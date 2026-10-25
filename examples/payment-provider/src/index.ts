import crypto from "node:crypto";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  notifyCommercy,
  randomValue,
  verifyCommercyRequest,
} from "./commercy.js";
import { renderCheckout, renderMessage } from "./checkout.js";
import { aggregateStatus, isExpired, Store, type AttemptStatus, type PaymentSession } from "./store.js";

const log = (...args: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...args);

/** Escapa texto antes de meterlo en HTML (query string, nombre de la tienda, mensajes de error). */
const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const store = new Store(config.dataFile);
const REDIRECT_URI = `${config.appBaseUrl}/callback`;

const app = express();
app.disable("x-powered-by");

// ── Autenticación de los requests de Commercy ──────────────────────────────

interface CommercyBody {
  installation_id?: string;
  [key: string]: unknown;
}
type CommercyRequest = Request & { commercy: CommercyBody };

/**
 * 1. Cuerpo CRUDO (express.raw, antes de cualquier parser JSON).
 * 2. Firma en tiempo constante + ventana de 5 minutos.
 * 3. El installation_id del cuerpo tiene que ser el del header: la firma cubre el
 *    cuerpo, no la URL, así que el recurso viaja en el cuerpo.
 */
function commercyAuth(req: Request, res: Response, next: NextFunction) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (!verifyCommercyRequest(raw, req.headers, config.webhookSecret)) {
    log(`${req.path}: firma inválida o fuera de ventana`);
    res.status(401).json({ error: "firma inválida" });
    return;
  }
  let body: CommercyBody;
  try {
    body = JSON.parse(raw) as CommercyBody;
  } catch {
    res.status(400).json({ error: "JSON inválido" });
    return;
  }
  if (body.installation_id !== req.headers["x-commercy-installation"]) {
    res.status(401).json({ error: "installation_id no coincide con el header" });
    return;
  }
  (req as CommercyRequest).commercy = body;
  next();
}

const rawJson = express.raw({ type: "application/json", limit: "64kb" });

// ── Commercy → esta app: abrir la sesión de cobro ──────────────────────────

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function parseHttpUrl(value: unknown): string | null {
  if (!isStr(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

app.post("/commercy/payments/session", rawJson, commercyAuth, (req, res) => {
  const b = (req as CommercyRequest).commercy as Record<string, any>;

  const backUrl = parseHttpUrl(b.back_url);
  const expiresAt = isStr(b.expires_at) && !Number.isNaN(Date.parse(b.expires_at)) ? b.expires_at : null;
  if (
    !isStr(b.installation_id) ||
    !isStr(b.idempotency_key) ||
    !isStr(b.order?.id) ||
    typeof b.amount !== "number" ||
    !Number.isFinite(b.amount) ||
    b.amount <= 0 ||
    b.currency !== "ARS" ||
    !backUrl ||
    !expiresAt
  ) {
    res.status(422).json({ error: "request de sesión inválido" });
    return;
  }

  // Idempotencia: la misma idempotency_key (el id de la venta) devuelve LA MISMA sesión.
  // El payment_id es estable durante toda la sesión, incluidos los reintentos del comprador.
  const key = `${b.installation_id}:${b.idempotency_key}`;
  let session = store.getByKey(key);
  if (!session) {
    session = {
      paymentId: `pay_${crypto.randomBytes(12).toString("hex")}`, // no adivinable: el checkout no tiene login
      key,
      installationId: b.installation_id,
      shopId: isStr(b.shop_id) ? b.shop_id : "",
      orderId: b.order.id,
      orderNumber: isStr(b.order.number) ? b.order.number : "",
      amount: b.amount,
      currency: b.currency,
      items: (Array.isArray(b.items) ? b.items : []).slice(0, 50).map((i: any) => ({
        name: String(i?.name ?? "").slice(0, 200),
        quantity: Number(i?.quantity) || 1,
        unit_price: Number(i?.unit_price) || 0,
      })),
      backUrl,
      expiresAt,
      cancelled: false,
      attempts: [],
      createdAt: new Date().toISOString(),
    };
    store.add(session);
    log(`Sesión ${session.paymentId} creada: venta ${session.orderId}, ${session.amount} ${session.currency}`);
  }

  // El checkout_url tiene que ser https y del mismo dominio registrable que el appUrl:
  // por eso se arma con APP_BASE_URL y no con nada que venga del request.
  res.json({ payment_id: session.paymentId, checkout_url: `${config.appBaseUrl}/pay/${session.paymentId}` });
});

// ── Commercy → esta app: consultar el estado ───────────────────────────────

app.post("/commercy/payments/status", rawJson, commercyAuth, (req, res) => {
  const b = (req as CommercyRequest).commercy;
  const session = isStr(b.payment_id) ? store.get(b.payment_id) : undefined;
  // Una sesión de otra instalación se trata como inexistente: no se filtra entre comercios.
  if (!session || session.installationId !== b.installation_id) {
    res.status(404).json({ error: "payment_id desconocido" });
    return;
  }
  // Los cinco campos son obligatorios; order_id y amount tienen que ser EXACTOS.
  res.json({
    payment_id: session.paymentId,
    order_id: session.orderId,
    status: aggregateStatus(session),
    amount: session.amount,
    currency: session.currency,
  });
});

// ── Checkout hospedado ─────────────────────────────────────────────────────

const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
  next();
};

const PAYMENT_ID = /^pay_[a-f0-9]{24}$/;
const form = express.urlencoded({ extended: false, limit: "4kb" });

const findSession = (id: string) => (PAYMENT_ID.test(id) ? store.get(id) : undefined);
const notFound = (res: Response) => res.status(404).send(renderMessage("No encontrado", "Esta sesión de pago no existe."));

app.get("/pay/:id", noStore, (req, res) => {
  const session = findSession(String(req.params.id));
  if (!session) return void notFound(res);
  res.type("html").send(renderCheckout(session));
});

/** Registra un cambio y le avisa a Commercy en segundo plano (el comprador no espera la verificación). */
function commit(session: PaymentSession, description: string) {
  store.save();
  log(`Sesión ${session.paymentId}: ${description} → ${aggregateStatus(session)}`);
  void notifyCommercy(config.apiBase, config.webhookSecret, session.installationId, session.paymentId, log);
}

app.post("/pay/:id", noStore, form, (req, res) => {
  const session = findSession(String(req.params.id));
  if (!session) return void notFound(res);

  const status = aggregateStatus(session);
  // Un pago aprobado o en curso no se repite: se vuelve a mostrar la página.
  if (status === "approved" || status === "in_process") return void res.redirect(303, `/pay/${session.paymentId}`);
  // Vencida o cancelada: no se aceptan pagos (el vencimiento lo fija Commercy).
  if (status === "cancelled" || isExpired(session)) {
    return void res.status(410).type("html").send(renderCheckout(session));
  }

  const outcomes: Record<string, AttemptStatus> = { approve: "approved", reject: "rejected", review: "in_process" };
  const outcome = outcomes[String(req.body?.action)];
  if (!outcome) return void res.status(400).send(renderMessage("Acción inválida", "Elegí Pagar o Rechazar."));

  session.attempts.push({ status: outcome, at: new Date().toISOString() });
  commit(session, `intento ${outcome}`);
  res.redirect(303, session.backUrl);
});

/** Simula la resolución de una verificación pendiente (in_process → approved | rejected). */
app.post("/pay/:id/resolve", noStore, form, (req, res) => {
  const session = findSession(String(req.params.id));
  if (!session) return void notFound(res);

  const pending = session.attempts.find((a) => a.status === "in_process");
  const outcome = req.body?.action === "approve" ? "approved" : req.body?.action === "reject" ? "rejected" : null;
  if (!pending || !outcome) return void res.redirect(303, `/pay/${session.paymentId}`);

  pending.status = outcome;
  pending.at = new Date().toISOString();
  commit(session, `revisión resuelta ${outcome}`);
  res.redirect(303, session.backUrl);
});

// ── Commercy → esta app: eventos (webhooks de la app) ──────────────────────

/**
 * La URL de webhook de la app en el portal. Los 4 eventos obligatorios llegan siempre;
 * `order.cancelled` requiere suscribirse y el scope read_orders.
 */
app.post("/webhooks/commercy", rawJson, (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (!verifyCommercyRequest(raw, req.headers, config.webhookSecret)) {
    res.sendStatus(401);
    return;
  }
  const event = JSON.parse(raw) as { id: string; type: string; data: Record<string, any> };
  if (store.markEventSeen(event.id)) {
    res.sendStatus(200); // duplicado: al menos una vez
    return;
  }

  switch (event.type) {
    case "order.cancelled": {
      // El comercio canceló la venta: cerrá la sesión. Si ya estaba cobrada, la devolución
      // la hacés vos en tu plataforma (Commercy no mueve la plata ni recibe reembolsos).
      for (const s of store.findByOrder(String(event.data?.id))) {
        s.cancelled = true;
        log(`Venta ${s.orderId} cancelada por el comercio. Sesión ${s.paymentId}: ${aggregateStatus(s)}`);
        if (aggregateStatus(s) === "approved") log(`  ↳ ya estaba cobrada: reembolsar al comprador desde esta plataforma`);
      }
      store.save();
      break;
    }
    case "app.uninstalled": {
      const installation = store.getInstallation(String(event.data?.installation_id));
      if (installation) store.putInstallation({ ...installation, status: "uninstalled" });
      log("App desinstalada. Las sesiones abiertas se siguen resolviendo.");
      break;
    }
    case "store.redact":
      store.deleteInstallationData(String(event.data?.installation_id));
      log("store.redact: datos del comercio borrados.");
      break;
    case "customers.redact":
    case "customers.data_request":
      log(`${event.type}: esta app no guarda datos de clientes.`); // sólo guarda venta, monto e ítems
      break;
  }
  res.sendStatus(200);
});

// ── Instalación (OAuth + PKCE) ─────────────────────────────────────────────

// state → verifier, con vencimiento a los 10 minutos
const pendingAuth = new Map<string, { verifier: string; expires: number }>();

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Pagos Ejemplo</title></head>
<body style="font-family: system-ui; max-width: 640px; margin: 3rem auto; line-height: 1.5">
  <h1>Pagos Ejemplo</h1>
  <p>Pasarela de pagos de ejemplo para el checkout de Commercy.</p>
  <p><a href="/install"><button style="font-size:16px;padding:10px 20px">Instalar en mi tienda</button></a></p>
</body></html>`);
});

app.get("/install", (_req, res) => {
  if (!config.clientId || !config.clientSecret) {
    res.status(500).send("Faltan COMMERCY_CLIENT_ID y COMMERCY_CLIENT_SECRET en .env");
    return;
  }
  const pkce = createPkcePair();
  const state = randomValue(16);
  pendingAuth.set(state, { verifier: pkce.verifier, expires: Date.now() + 10 * 60_000 });
  res.redirect(
    buildAuthorizeUrl(config.apiBase, {
      clientId: config.clientId,
      redirectUri: REDIRECT_URI,
      state,
      challenge: pkce.challenge,
    }),
  );
});

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error) return void res.status(400).send(`Autorización rechazada: ${esc(error)}`);

  const pending = state ? pendingAuth.get(state) : undefined;
  if (state) pendingAuth.delete(state);
  if (!code || !pending || pending.expires < Date.now()) {
    return void res.status(400).send("State inválido o vencido. Volvé a /install.");
  }

  try {
    const tokens = await exchangeCode(
      config.apiBase,
      { clientId: config.clientId, clientSecret: config.clientSecret },
      { code, verifier: pending.verifier, redirectUri: REDIRECT_URI },
    );
    // Esta app no llama a la API pública, así que NO guarda access/refresh token.
    // Lo que importa es el installation_id: es la clave para vincular al comercio con SU cuenta
    // en tu procesador (tu propio proceso de alta) y para avisarle a Commercy de cada cambio.
    store.putInstallation({
      installationId: tokens.installation_id,
      storeId: tokens.store.id,
      storeName: tokens.store.name,
      scope: tokens.scope,
      status: "active",
      createdAt: new Date().toISOString(),
    });
    log(`Instalación ${tokens.installation_id} (${tokens.store.name})`);
    res.send(`Instalación lista para <strong>${esc(tokens.store.name)}</strong>. Prendé la app en Ajustes > Cobros de tu tienda.`);
  } catch (err) {
    res.status(400).send(`No se pudo instalar: ${esc((err as Error).message)}`);
  }
});

app.get("/health", (_req, res) => void res.json({ ok: true }));

app.listen(config.port, () => {
  log(`Pagos Ejemplo escuchando en http://localhost:${config.port}`);
  log(`appUrl / checkout: ${config.appBaseUrl}`);
  log(`Redirect URI (OAuth): ${REDIRECT_URI}`);
  log(`Webhook URL de la app: ${config.appBaseUrl}/webhooks/commercy`);
  log(`Webhooks hacia Commercy: ${config.apiBase}/api/v1/app-webhooks/:installationId`);
});
