/**
 * Cliente mínimo de la plataforma de apps de Commercy (mismo patrón que `sales-dashboard`):
 * - OAuth 2.0 authorization code + PKCE (S256), cliente confidencial.
 * - Refresh token rotativo (un solo uso).
 * - API pública versionada por fecha en la URL.
 *
 * Acá sólo usamos la API para INFORMAR el seguimiento: `POST /orders/:id/status`
 * y `POST /orders/:id/fulfillment` (scope `write_orders`).
 *
 * Docs: https://docs.commercy.com.ar
 */
import crypto from "node:crypto";

export const COMMERCY_API_BASE = process.env.COMMERCY_API_BASE ?? "https://api.commercy.com.ar";
export const API_VERSION = process.env.COMMERCY_API_VERSION ?? "2026-10";
export const API_ROOT = `${COMMERCY_API_BASE}/api/public/${API_VERSION}`;

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomValue(bytes = 32): string {
  return b64url(crypto.randomBytes(bytes));
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomValue(32); // 43 caracteres base64url
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Paso 1 del flujo: URL para mandar al comerciante a la pantalla de consentimiento. */
export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(`${COMMERCY_API_BASE}/oauth/apps/authorize`);
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
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  installation_id: string;
  store: { id: string; name: string };
}

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

export class OAuthError extends Error {
  constructor(
    public status: number,
    public error: string,
    public description?: string,
  ) {
    super(`OAuth ${error}${description ? `: ${description}` : ""}`);
    this.name = "OAuthError";
  }
}

export class CommercyError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    /** `details[0].reason` en los 409 (p. ej. `order_closed`, `payment_confirmation_required`). */
    public reason?: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = "CommercyError";
  }
}

/** POST /oauth/apps/token con client_secret_basic. */
async function tokenRequest(credentials: Credentials, params: Record<string, string>): Promise<TokenSet> {
  const basic = Buffer.from(
    `${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(credentials.clientSecret)}`,
  ).toString("base64");

  const res = await fetch(`${COMMERCY_API_BASE}/oauth/apps/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams(params),
  });
  const body = (await res.json()) as TokenSet | { error: string; error_description?: string };
  if (!res.ok) {
    const err = body as { error?: string; error_description?: string };
    if (typeof err.error === "string") throw new OAuthError(res.status, err.error, err.error_description);
    throw new CommercyError("Respuesta inesperada del endpoint de token", res.status);
  }
  return body as TokenSet;
}

/** Canje del code de autorización (crea la instalación). */
export function exchangeCode(
  credentials: Credentials,
  args: { code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  return tokenRequest(credentials, {
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.verifier,
    redirect_uri: args.redirectUri,
  });
}

/** Refresh rotativo: cada refresh token se usa UNA sola vez, guardá siempre el nuevo. */
export function refreshAccessToken(credentials: Credentials, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(credentials, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export type TrackedStatus = "confirmed" | "preparing" | "shipped" | "delivered";

export class CommercyClient {
  constructor(private accessToken: string) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API_ROOT}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; details?: { reason?: string }[] };
      };
      throw new CommercyError(
        err.error?.message ?? `API POST ${path} falló con ${res.status}`,
        res.status,
        err.error?.code,
        err.error?.details?.[0]?.reason,
        res.headers.get("x-request-id") ?? undefined,
      );
    }
    return (await res.json()) as T;
  }

  /** Cambia el estado de la venta. `delivered` la cierra (stock, caja, asiento contable). */
  updateOrderStatus(orderId: string, status: TrackedStatus, notes?: string) {
    return this.post<{ data: unknown }>(`/orders/${orderId}/status`, { status, ...(notes ? { notes } : {}) });
  }

  /** Carga o corrige el seguimiento de la venta. */
  updateFulfillment(orderId: string, tracking: { tracking_number: string; tracking_url: string }) {
    return this.post<{ data: unknown }>(`/orders/${orderId}/fulfillment`, tracking);
  }
}
