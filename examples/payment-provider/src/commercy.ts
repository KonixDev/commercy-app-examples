/**
 * Lo que esta app necesita de Commercy:
 * - Verificar la firma de los requests que Commercy te manda (sesión, estado, webhooks).
 * - Firmar el webhook `payment.updated` que le mandás a Commercy.
 * - OAuth 2.0 authorization code + PKCE (S256) para registrar la instalación.
 *
 * Docs: https://docs.commercy.com.ar (Apps de pago, Webhooks, OAuth)
 */
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

// ── Firma HMAC (la misma en los dos sentidos) ──────────────────────────────

export const SIGNATURE_TOLERANCE_SECONDS = 300; // 5 minutos

const sign = (secret: string, timestamp: string, rawBody: string): string =>
  "v1=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Firma = HMAC-SHA256(secreto, "<X-Commercy-Timestamp>.<cuerpo crudo>") en hex, con prefijo "v1=".
 * El cuerpo tiene que ser el crudo (bytes tal cual llegaron), nunca el JSON re-serializado.
 */
export function verifyCommercyRequest(
  rawBody: string,
  headers: IncomingHttpHeaders,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const timestamp = header(headers, "x-commercy-timestamp");
  const signature = header(headers, "x-commercy-signature");
  if (!timestamp || !signature) return false;

  // Sólo dígitos: descarta "1e9", " 12", etc. antes de comparar la ventana.
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const a = Buffer.from(sign(secret, timestamp, rawBody));
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Headers para avisarle a Commercy que cambió el estado de una sesión. */
export function signCommercyWebhook(
  rawBody: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const timestamp = String(nowSec);
  return {
    "Content-Type": "application/json",
    "X-Commercy-Timestamp": timestamp,
    "X-Commercy-Signature": sign(secret, timestamp, rawBody),
  };
}

// ── Webhook hacia Commercy ─────────────────────────────────────────────────

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /api/v1/app-webhooks/:installationId con `payment.updated`.
 * El webhook no lleva el estado: Commercy lo vuelve a consultar en tu /status
 * y recién entonces responde, por eso el timeout es holgado. Reintenta con
 * espera creciente ante un 5xx o un error de red; con 401/404 no tiene sentido
 * reintentar (secreto/reloj o id de instalación mal).
 */
export async function notifyCommercy(
  apiBase: string,
  secret: string,
  installationId: string,
  paymentId: string,
  log: (...args: unknown[]) => void = console.log,
): Promise<void> {
  const raw = JSON.stringify({ type: "payment.updated", payment_id: paymentId });
  const url = `${apiBase}/api/v1/app-webhooks/${encodeURIComponent(installationId)}`;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      // Se firma de nuevo en cada intento: el timestamp vale 5 minutos.
      const res = await fetch(url, {
        method: "POST",
        headers: signCommercyWebhook(raw, secret),
        body: raw,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status < 500) {
        if (res.status !== 200) log(`[webhook→commercy] ${paymentId}: HTTP ${res.status} (no se reintenta)`);
        else log(`[webhook→commercy] ${paymentId}: OK`);
        return;
      }
      log(`[webhook→commercy] ${paymentId}: HTTP ${res.status}, reintento ${attempt + 1}`);
    } catch (err) {
      log(`[webhook→commercy] ${paymentId}: ${(err as Error).message}, reintento ${attempt + 1}`);
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await sleep(delay);
  }
  log(`[webhook→commercy] ${paymentId}: se agotaron los reintentos. Commercy igual lo va a consultar al vencer la sesión.`);
}

// ── OAuth (PKCE) ───────────────────────────────────────────────────────────

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const randomValue = (bytes = 32): string => b64url(crypto.randomBytes(bytes));

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomValue(32);
  return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) };
}

export function buildAuthorizeUrl(
  apiBase: string,
  args: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const url = new URL(`${apiBase}/oauth/apps/authorize`);
  url.search = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  scope: string;
  installation_id: string;
  store: { id: string; name: string };
}

/** Canje del code (crea la instalación). Cliente confidencial: client_secret_basic. */
export async function exchangeCode(
  apiBase: string,
  credentials: { clientId: string; clientSecret: string },
  args: { code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  const basic = Buffer.from(
    `${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(credentials.clientSecret)}`,
  ).toString("base64");

  const res = await fetch(`${apiBase}/oauth/apps/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      code_verifier: args.verifier,
      redirect_uri: args.redirectUri,
    }),
  });

  const body = (await res.json()) as TokenSet & { error?: string; error_description?: string };
  if (!res.ok) throw new Error(`OAuth ${body.error ?? res.status}: ${body.error_description ?? ""}`);
  return body;
}
