import "dotenv/config";
import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import {
  CommercyClient,
  OAuthError,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  refreshAccessToken,
  verifyWebhookSignature,
} from "./commercy.js";
import { DashboardService, EventFeed, renderDashboard } from "./dashboard.js";

const {
  COMMERCY_CLIENT_ID,
  COMMERCY_CLIENT_SECRET,
  COMMERCY_WEBHOOK_SECRET,
  APP_BASE_URL,
  DASHBOARD_TOKEN,
} = process.env;

if (!COMMERCY_CLIENT_ID || !COMMERCY_CLIENT_SECRET || !COMMERCY_WEBHOOK_SECRET || !APP_BASE_URL) {
  console.error(
    "[config] Faltan variables de entorno. Copiá .env.example a .env y completá CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET y APP_BASE_URL.",
  );
  process.exit(1);
}

if (!DASHBOARD_TOKEN) {
  console.warn(
    "[config] DASHBOARD_TOKEN no está seteado: /dashboard y /api/* quedan SIN autenticación. Demo: protegelo antes de exponerlo.",
  );
}

const REDIRECT_URI = `${APP_BASE_URL.replace(/\/$/, "")}/callback`;

interface StoredInstallation {
  installationId: string;
  storeId: string;
  storeName: string;
  scope: string;
  accessToken: string;
  refreshToken: string;
  createdAt: string;
}

/**
 * En una app real esto vive en una base de datos, cifrado. Para la demo
 * lo mantenemos sólo en memoria: si reiniciás el proceso, volvé a /install.
 */
const state = {
  // PKCE + state pendientes de la autorización en curso
  pending: null as null | { verifier: string; state: string },
  // Última instalación canjeada en esta corrida
  installation: null as StoredInstallation | null,
  // Ids de eventos ya vistos (deduplicación por X-Commercy-Event-Id)
  seenEventIds: new Set<string>(),
};

/** Escapa texto antes de meterlo en HTML (nombre de la tienda, query string, mensajes de error). */
const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Dashboard: feed de webhooks en vivo + agregaciones con cache corto.
const feed = new EventFeed();
const dashboard = new DashboardService(feed);

// ── App Express ────────────────────────────────────────────────────────────

const app = express();

const log = (...args: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...args);


// ── Instalación (OAuth) ────────────────────────────────────────────────────

app.get("/", (req, res) => {
  const install = state.installation;
  if (install && req.query.raw === undefined) {
    res.redirect("/dashboard");
    return;
  }
  if (!install) {
    res.send(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8"><title>Commercy demo app</title></head>
  <body style="font-family: system-ui; max-width: 640px; margin: 3rem auto; line-height: 1.5">
    <h1>App demo de Commercy</h1>
    <p>Dashboard de ventas para comercios: métricas de los últimos 7 días, top
    productos, alertas de stock bajo y feed de webhooks en vivo.</p>
    <p><a href="/install"><button style="font-size:16px;padding:10px 20px">Instalar en mi tienda</button></a></p>
    <p style="color:#6b7280;font-size:13px">API de prueba: /api/store · /api/shops · /api/products · /api/orders<br>
    Webhook: POST /webhooks/commercy (HMAC + deduplicación)</p>
  </body>
</html>`);
    return;
  }
  res.send(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8"><title>Commercy demo app</title></head>
  <body style="font-family: system-ui; max-width: 640px; margin: 3rem auto; line-height: 1.5">
    <h1>App demo de Commercy</h1>
    <ul>
      <li><a href="/dashboard">Dashboard de ventas</a></li>
      <li><a href="/install">Reinstalar / cambiar de tienda</a></li>
      <li><a href="/api/store">API: tienda</a> · <a href="/api/products">productos</a> · <a href="/api/orders">ventas</a></li>
    </ul>
    <p style="color:#6b7280">Instalación activa: <code>${esc(install.installationId)}</code> — <strong>${esc(install.storeName)}</strong></p>
  </body>
</html>`);
});

app.get("/install", (_req, res) => {
  const pkce = createPkcePair();
  const stateValue = createPkcePair().challenge; // state aleatorio
  state.pending = { verifier: pkce.verifier, state: stateValue };

  const url = buildAuthorizeUrl({
    clientId: COMMERCY_CLIENT_ID!,
    redirectUri: REDIRECT_URI,
    state: stateValue,
    challenge: pkce.challenge,
  });
  log("Iniciando instalación. Redirect URI:", REDIRECT_URI);
  res.redirect(url);
});

app.get("/callback", async (req: Request, res: Response) => {
  const { code, state: returnedState, error, error_description: errorDescription } = req.query as {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  };

  if (error) {
    res.status(400).send(`Autorización rechazada o inválida: ${esc(error)} — ${esc(errorDescription)}`);
    return;
  }
  if (!code) {
    res.status(400).send("Falta el code");
    return;
  }
  if (!state.pending || state.pending.state !== returnedState) {
    res.status(400).send("State inválido: posible CSRF o sesión expirada. Volvé a /install.");
    return;
  }

  const verifier = state.pending.verifier;
  state.pending = null;

  try {
    const tokens = await exchangeCode(
      { clientId: COMMERCY_CLIENT_ID!, clientSecret: COMMERCY_CLIENT_SECRET! },
      { code, verifier, redirectUri: REDIRECT_URI },
    );
    state.installation = {
      installationId: tokens.installation_id,
      storeId: tokens.store.id,
      storeName: tokens.store.name,
      scope: tokens.scope,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      createdAt: new Date().toISOString(),
    };
    log(
      "Instalación creada:",
      tokens.installation_id,
      "tienda:",
      tokens.store.name,
      "scopes:",
      tokens.scope,
    );
    // Los tokens se quedan en el servidor: nunca los mandes al navegador.
    res.send(
      `<p>Instalación lista en <strong>${esc(tokens.store.name)}</strong> (installation_id <code>${esc(tokens.installation_id)}</code>, scopes <code>${esc(tokens.scope)}</code>).</p>
       <p>Ir al <a href="/dashboard">dashboard</a>.</p>`,
    );
  } catch (err) {
    if (err instanceof OAuthError) {
      res.status(400).send(`Error de OAuth: ${esc(err.error)} — ${esc(err.description)}`);
    } else {
      res.status(500).send(`Error inesperado: ${esc((err as Error).message)}`);
    }
  }
});

// ── Refresh rotativo con serialización ─────────────────────────────────────

async function withFreshToken<T>(fn: (client: CommercyClient) => Promise<T>): Promise<T> {
  if (!state.installation) {
    // En la demo pedimos reinstalar: el proceso perdió los tokens (o desinstalaron la app).
    const err = new Error("No hay instalación activa. Entrá a /install.") as Error & { redirect?: string };
    err.redirect = "/install";
    throw err;
  }
  // Esperar a que termine un refresh en curso (un solo proceso renueva; los demás esperan).
  if (refreshing) await refreshing;
  const token = state.installation!.accessToken;
  try {
    return await fn(new CommercyClient(token));
  } catch (err) {
    const e = err as { status?: number };
    if (e.status !== 401) throw err;
    // Si otro request ya renovó el token mientras tanto, no se vuelve a refrescar: sólo se reintenta.
    if (state.installation?.accessToken === token) await refreshTokens();
    return fn(new CommercyClient(state.installation!.accessToken));
  }
}

// Un refresh token se usa UNA vez: todos los requests que reciben 401 a la vez comparten la misma promesa.
let refreshing: Promise<void> | null = null;

function refreshTokens(): Promise<void> {
  refreshing ??= (async () => {
    const tokens = await refreshAccessToken(
      { clientId: COMMERCY_CLIENT_ID!, clientSecret: COMMERCY_CLIENT_SECRET! },
      state.installation!.refreshToken,
    );
    state.installation = {
      ...state.installation!,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token, // el anterior queda invalidado: SIEMPRE guardar el nuevo
      scope: tokens.scope,
    };
    log("Refresh token rotado OK.");
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// ── Protección opcional de /dashboard y /api/* ─────────────────────────────

/** Si DASHBOARD_TOKEN está seteado, exige `?token=` o `Authorization: Bearer`. Comparación en tiempo constante. */
function requireDashboardToken(req: Request, res: Response, next: NextFunction): void {
  if (!DASHBOARD_TOKEN) {
    next();
    return;
  }
  const bearer = /^Bearer (.+)$/i.exec(req.get("authorization") ?? "")?.[1];
  const provided = bearer ?? (typeof req.query.token === "string" ? req.query.token : "");
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(DASHBOARD_TOKEN).digest();
  if (!timingSafeEqual(a, b)) {
    res.status(401).type("text/plain").send("No autorizado: pasá ?token=... o el header Authorization: Bearer ...");
    return;
  }
  next();
}

app.use(["/dashboard", "/api"], requireDashboardToken);

// ── Endpoints de prueba contra la API ──────────────────────────────────────

function wrap(handler: () => Promise<unknown>) {
  return async (_req: Request, res: Response) => {
    try {
      const data = await handler();
      res.type("application/json").send(data);
    } catch (err) {
      const e = err as { status?: number; message: string; requestId?: string; redirect?: string };
      if (e.redirect) {
        res.redirect(e.redirect);
        return;
      }
      res
        .status(e.status ?? 500)
        .send({ error: e.message, request_id: e.requestId });
    }
  };
}

app.get("/api/store", wrap(async () => withFreshToken((c) => c.store())));
app.get("/api/shops", wrap(async () => withFreshToken((c) => c.shops())));
app.get("/api/products", wrap(async () => withFreshToken((c) => c.products({ limit: "10" }))));
app.get("/api/orders", wrap(async () => withFreshToken((c) => c.orders({ limit: "10" }))));

// ── Dashboard (la funcionalidad de la app) ─────────────────────────────────

app.get("/dashboard", async (_req: Request, res: Response) => {
  if (!state.installation) {
    res.redirect("/install");
    return;
  }
  try {
    const data = await withFreshToken(async (c) => {
      const storeRes = await c.store();
      return dashboard.get(c, {
        name: storeRes.data.name,
        currency: storeRes.data.currency,
      });
    });
    res.type("html").send(renderDashboard(data));
  } catch (err) {
    const e = err as { status?: number; message: string; requestId?: string };
    if (e.status === 403) {
      res
        .status(200)
        .type("html")
        .send(
          `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:560px;margin:4rem auto;line-height:1.6">
           <h1>Falta un scope</h1><p>${esc(e.message)}</p>
           <p>Ampliá los scopes de la app en el portal y volvé a <a href="/install">instalarla</a>.</p></body>`,
        );
      return;
    }
    res
      .status(e.status ?? 500)
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:560px;margin:4rem auto;line-height:1.6">
         <h1>No se pudo armar el dashboard</h1><p>${esc(e.message)}</p>${
           e.requestId ? `<p style="color:#9ca3af">request_id: ${esc(e.requestId)}</p>` : ""
         }<p><a href="/dashboard">Reintentar</a> · <a href="/install">Instalar la app</a></p></body>`,
      );
  }
});

// Redirigir la home al dashboard cuando ya hay instalación.

// ── Webhooks ───────────────────────────────────────────────────────────────

app.post(
  "/webhooks/commercy",
  express.raw({ type: "application/json", limit: "1mb" }),
  (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body)) {
      res.sendStatus(400);
      return;
    }
    const raw = req.body.toString("utf8");
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const pick = (name: string) => {
      const v = headers[name];
      return Array.isArray(v) ? v[0] : v;
    };

    const ok = verifyWebhookSignature(
      raw,
      {
        "x-commercy-timestamp": pick("x-commercy-timestamp"),
        "x-commercy-signature": pick("x-commercy-signature"),
      },
      COMMERCY_WEBHOOK_SECRET!,
    );
    if (!ok) {
      log("Webhook rechazado: firma inválida");
      res.sendStatus(401);
      return;
    }

    let event: { id: string; type: string; store_id: string | null; data: unknown; meta?: unknown };
    try {
      event = JSON.parse(raw);
    } catch {
      res.sendStatus(400);
      return;
    }

    // Deduplicar por id de evento (al menos una vez: puede repetirse).
    if (state.seenEventIds.has(event.id)) {
      log("Duplicado ignorado:", event.id, event.type);
      res.sendStatus(200);
      return;
    }
    state.seenEventIds.add(event.id);
    feed.add({ id: event.id, type: event.type, storeId: event.store_id });

    // Los webhooks de datos invalidan el cache del dashboard: el panel reacciona al instante.
    if (
      event.type.startsWith("order.") ||
      event.type.startsWith("product.") ||
      event.type === "stock.changed" ||
      event.type.startsWith("customer.")
    ) {
      dashboard.invalidate();
    }

    // Los 4 obligatorios llegan siempre, sin importar los scopes.
    if (event.type === "app.uninstalled") {
      log("La app fue desinstalada. Descartando tokens de la instalación.");
      state.installation = null;
    }
    if (event.type === "store.redact") {
      log("Borrado de datos del comercio (48 h post-desinstalación).");
    }
    if (event.type === "customers.redact" || event.type === "customers.data_request") {
      log("Pedido de datos de cliente:", event.type);
    }

    log(`Webhook recibido: ${event.type} (store ${event.store_id ?? "n/a"})`);
    // Respondemos rápido y procesamos después. Nada pesado acá.
    res.sendStatus(200);
  },
);

// Parser JSON global para el resto de las rutas, DESPUÉS del webhook raw.
app.use(express.json({ limit: "1mb" }));

// ── Arranque ───────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  log(`Demo app escuchando en http://localhost:${PORT}`);
  log(`Redirect URI registrada en el portal: ${REDIRECT_URI}`);
  log(`Webhook URL: ${REDIRECT_URI.replace("/callback", "")}/webhooks/commercy`);
});
