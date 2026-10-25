import "dotenv/config";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import {
  CommercyError,
  OAuthError,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  randomValue,
  type Credentials,
} from "./commercy.js";
import { quote, type QuoteItem } from "./rates.js";
import { verifyCommercyRequest } from "./signature.js";
import { installations, shipments, type Shipment } from "./store.js";
import { NEXT_STATUS, pushTracking } from "./tracking.js";

const { COMMERCY_CLIENT_ID, COMMERCY_CLIENT_SECRET, COMMERCY_WEBHOOK_SECRET } = process.env;
const PORT = Number(process.env.PORT ?? 3000);
const APP_BASE_URL = (process.env.APP_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

if (!COMMERCY_WEBHOOK_SECRET) {
  console.error("[config] Falta COMMERCY_WEBHOOK_SECRET. Copiá .env.example a .env y completalo.");
  process.exit(1);
}
const SECRET: string = COMMERCY_WEBHOOK_SECRET;

// Las credenciales OAuth sólo se necesitan para instalar la app y empujar el seguimiento.
const credentials: Credentials | null =
  COMMERCY_CLIENT_ID && COMMERCY_CLIENT_SECRET
    ? { clientId: COMMERCY_CLIENT_ID, clientSecret: COMMERCY_CLIENT_SECRET }
    : null;
if (!credentials) {
  console.warn("[config] Sin COMMERCY_CLIENT_ID/SECRET: cotizar, crear y cancelar funcionan; /install y el empuje de seguimiento no.");
}

const REDIRECT_URI = `${APP_BASE_URL}/callback`;
const log = (...args: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...args);

/** Escapa texto antes de meterlo en HTML (query string, nombre de la tienda, mensajes de error). */
const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const app = express();

// ── Requests firmados de Commercy ──────────────────────────────────────────

interface CommercyBody {
  installation_id: string;
  shop_id: string;
  [key: string]: unknown;
}

declare module "express-serve-static-core" {
  interface Request {
    commercy?: CommercyBody;
  }
}

/**
 * 1) firma sobre el cuerpo CRUDO (express.raw va antes), en tiempo constante y dentro de ±5 min;
 * 2) el `installation_id` del cuerpo tiene que ser el del header: la firma cubre el cuerpo, no la URL.
 */
function commercyAuth(req: Request, res: Response, next: NextFunction): void {
  if (!Buffer.isBuffer(req.body)) {
    res.sendStatus(401);
    return;
  }
  const raw = req.body.toString("utf8");
  const pick = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const ok = verifyCommercyRequest(
    raw,
    { "x-commercy-timestamp": pick("x-commercy-timestamp"), "x-commercy-signature": pick("x-commercy-signature") },
    SECRET,
  );
  if (!ok) {
    log(`Rechazado ${req.path}: firma inválida o fuera de ventana`);
    res.sendStatus(401);
    return;
  }
  let body: CommercyBody;
  try {
    body = JSON.parse(raw) as CommercyBody;
  } catch {
    res.status(400).json({ error: "JSON inválido" });
    return;
  }
  if (!body || body.installation_id !== pick("x-commercy-installation")) {
    log(`Rechazado ${req.path}: installation_id no coincide con el header`);
    res.sendStatus(401);
    return;
  }
  req.commercy = body;
  next();
}

const signed = [express.raw({ type: "application/json", limit: "1mb" }), commercyAuth];

/** Cotizar: Commercy espera la respuesta en menos de 3 s. Acá es un cálculo en memoria, sin I/O. */
app.post("/commercy/shipping/quote", ...signed, (req, res) => {
  const body = req.commercy as CommercyBody & { postal_code?: unknown; items?: QuoteItem[] };
  const postalCode = String(body.postal_code ?? "");
  if (!/^\d{4}$/.test(postalCode)) {
    // Un 4xx no te saca del checkout: sólo esa cotización no aparece.
    res.status(400).json({ error: "postal_code debe tener 4 dígitos" });
    return;
  }
  const items = Array.isArray(body.items) ? body.items : []; // puede venir vacío
  res.json({ methods: quote(postalCode, items) });
});

interface CreateBody extends CommercyBody {
  idempotency_key?: string;
  method_id?: string | null;
  order?: { id?: string; number?: string | null };
}

/**
 * Alta de envío, idempotente por `idempotency_key`: la key identifica un INTENTO de envío.
 * Si Commercy reintenta (timeout), llega la misma key y devolvemos el mismo envío sin crear otro.
 */
app.post("/commercy/shipping/shipments", ...signed, (req, res) => {
  const body = req.commercy as CreateBody;
  const key = body.idempotency_key;
  if (!key || typeof key !== "string" || !body.order?.id) {
    res.status(400).json({ error: "Faltan idempotency_key u order.id" });
    return;
  }

  let shipment = shipments.byKey(key);
  if (!shipment) {
    const n = shipments.nextSeq();
    const padded = String(n).padStart(6, "0");
    const trackingNumber = `EE${padded}AR`;
    shipment = {
      code: `EE-${padded}`,
      idempotencyKey: key,
      installationId: body.installation_id,
      shopId: body.shop_id,
      orderId: body.order.id,
      orderNumber: body.order.number ?? null,
      methodId: body.method_id ?? null, // null → servicio por defecto (la venta se cotizó con otro carrier)
      trackingNumber,
      trackingUrl: `${APP_BASE_URL}/seguimiento/${trackingNumber}`, // tiene que ser https en producción
      status: "created",
      createdAt: new Date().toISOString(),
    };
    shipments.put(shipment);
    log(`Envío creado ${shipment.code} para la venta ${shipment.orderId} (key ${key})`);
  } else {
    log(`Alta repetida para key ${key}: devuelvo ${shipment.code}`);
  }

  res.json({ code: shipment.code, tracking_number: shipment.trackingNumber, tracking_url: shipment.trackingUrl });
});

app.post("/commercy/shipping/shipments/cancel", ...signed, (req, res) => {
  const { code } = req.commercy as CommercyBody & { code?: string };
  const shipment = typeof code === "string" ? shipments.byCode(code) : undefined;
  if (!shipment) {
    res.status(404).json({ error: "Envío inexistente" });
    return;
  }
  if (shipment.status === "delivered") {
    res.status(409).json({ error: "El envío ya fue entregado" });
    return;
  }
  // Cancelar dos veces es inocuo: respondemos igual `canceled: true`.
  if (shipment.status !== "canceled") {
    shipments.put({ ...shipment, status: "canceled" });
    log(`Envío cancelado ${shipment.code}`);
  }
  res.json({ canceled: true });
});

const seenEventIds = new Set<string>(); // en producción: base o Redis con TTL (~48 h), no memoria

// ── Webhooks (opcionales para un carrier, pero conviene escuchar estos dos) ─

app.post("/webhooks/commercy", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const h = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  if (!verifyCommercyRequest(raw, { "x-commercy-timestamp": h("x-commercy-timestamp"), "x-commercy-signature": h("x-commercy-signature") }, SECRET)) {
    res.sendStatus(401);
    return;
  }
  let event: { id?: string; type: string; data?: { id?: string; installation_id?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    res.sendStatus(400);
    return;
  }

  // Deduplicar por X-Commercy-Event-Id (entrega "al menos una vez"), recién después de autenticar.
  const eventId = h("x-commercy-event-id") ?? event.id;
  if (eventId) {
    if (seenEventIds.has(eventId)) {
      log(`Duplicado ignorado: ${eventId} (${event.type})`);
      res.sendStatus(200);
      return;
    }
    seenEventIds.add(eventId);
  }

  // Obligatorio y siempre entregado: descartá los tokens de la instalación.
  if (event.type === "app.uninstalled") {
    const installationId = event.data?.installation_id;
    if (installationId) {
      installations.remove(installationId);
      log(`app.uninstalled → tokens de la instalación ${installationId} descartados`);
    }
  }

  // Si el comercio cancela la venta, Commercy NO cancela el envío en tu sistema: lo hacés vos.
  if (event.type === "order.cancelled" && event.data?.id) {
    for (const s of shipments.byOrder(event.data.id)) {
      if (s.status !== "canceled" && s.status !== "delivered") {
        shipments.put({ ...s, status: "canceled" });
        log(`order.cancelled → envío ${s.code} cancelado`);
      }
    }
  }
  res.sendStatus(200);
});

// ── Instalación (OAuth) ────────────────────────────────────────────────────

const pending = new Map<string, string>(); // state → PKCE verifier

app.get("/install", (_req, res) => {
  if (!credentials) {
    res.status(500).send("Faltan COMMERCY_CLIENT_ID y COMMERCY_CLIENT_SECRET en .env");
    return;
  }
  const pkce = createPkcePair();
  const state = randomValue(16);
  pending.set(state, pkce.verifier);
  res.redirect(buildAuthorizeUrl({ clientId: credentials.clientId, redirectUri: REDIRECT_URI, state, challenge: pkce.challenge }));
});

app.get("/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description: description } = req.query as Record<string, string | undefined>;
  if (error) {
    res.status(400).send(`Autorización rechazada o inválida: ${esc(error)} — ${esc(description)}`);
    return;
  }
  const verifier = state ? pending.get(state) : undefined;
  if (!code || !state || !verifier || !credentials) {
    res.status(400).send("State inválido o sesión expirada. Volvé a /install.");
    return;
  }
  pending.delete(state);
  try {
    const tokens = await exchangeCode(credentials, { code, verifier, redirectUri: REDIRECT_URI });
    installations.put({
      installationId: tokens.installation_id,
      storeId: tokens.store.id,
      storeName: tokens.store.name,
      scope: tokens.scope,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    });
    log(`Instalación ${tokens.installation_id} (${tokens.store.name}), scopes: ${tokens.scope}`);
    res.send(`Instalada en <strong>${esc(tokens.store.name)}</strong> (installation_id <code>${esc(tokens.installation_id)}</code>). Ya podés empujar seguimiento.`);
  } catch (err) {
    if (err instanceof OAuthError) res.status(400).send(`Error de OAuth: ${esc(err.error)} — ${esc(err.description)}`);
    else res.status(500).send(`Error inesperado: ${esc((err as Error).message)}`);
  }
});

// ── Seguimiento público para el comprador ──────────────────────────────────

const LABEL: Record<Shipment["status"], string> = {
  created: "Envío creado",
  preparing: "En preparación",
  shipped: "Despachado",
  delivered: "Entregado",
  canceled: "Cancelado",
};

app.get("/seguimiento/:trackingNumber", (req, res) => {
  const s = shipments.byTrackingNumber(req.params.trackingNumber ?? "");
  if (!s) {
    res.status(404).send("Envío no encontrado");
    return;
  }
  res.type("html").send(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:480px;margin:3rem auto">
     <h1>Envíos Ejemplo</h1><p>Seguimiento <strong>${s.trackingNumber}</strong></p><p>Estado: <strong>${LABEL[s.status]}</strong></p></body>`,
  );
});

// ── Demo: simular que el envío avanza ──────────────────────────────────────

/**
 * DEMO: en la vida real el estado lo da tu operación logística (scanner del depósito, app del repartidor...).
 * Cada llamada avanza un paso (en preparación → despachado → entregado) y lo empuja a Commercy.
 * Sacá esta ruta antes de salir a producción: no tiene autenticación.
 */
app.post("/demo/shipments/:code/advance", async (req, res) => {
  const shipment = shipments.byCode(req.params.code ?? "");
  if (!shipment) {
    res.status(404).json({ error: "Envío inexistente" });
    return;
  }
  const next = NEXT_STATUS[shipment.status];
  if (!next) {
    res.status(409).json({ error: `El envío está ${LABEL[shipment.status].toLowerCase()}: no hay más pasos` });
    return;
  }
  if (!installations.get(shipment.installationId)) {
    res.status(409).json({ error: "No tenemos el token de esa instalación: instalá la app (GET /install) para informar el seguimiento." });
    return;
  }
  try {
    await pushTracking(shipment, next, credentials);
    shipments.put({ ...shipment, status: next });
    log(`Seguimiento empujado: ${shipment.code} → ${next}`);
    res.json({ code: shipment.code, status: next });
  } catch (err) {
    // No avanzamos el estado local si Commercy lo rechazó: se puede reintentar.
    if (err instanceof CommercyError) {
      // 409 order_closed: la venta se cerró/canceló. 409 payment_confirmation_required: lo confirma el comercio.
      res.status(err.status).json({ error: err.message, code: err.code, reason: err.reason, request_id: err.requestId });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

// ── Arranque ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Envíos Ejemplo escuchando en http://localhost:${PORT}`);
  log(`apiBaseUrl para soporte: ${APP_BASE_URL}`);
  log(`Redirect URI para el portal: ${REDIRECT_URI}`);
  log(`Webhook URL (opcional): ${APP_BASE_URL}/webhooks/commercy`);
});
