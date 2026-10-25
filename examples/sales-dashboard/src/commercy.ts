/**
 * Cliente mínimo de la plataforma de apps de Commercy:
 * - OAuth 2.0 authorization code + PKCE (S256), cliente confidencial.
 * - Refresh token rotativo (un solo uso; si dos procesos refrescan a la vez
 *   hay una ventana de gracia de 10 segundos del lado de Commercy).
 * - API pública versionada por fecha en la URL.
 * - Verificación de la firma HMAC-SHA256 de los webhooks.
 *
 * Docs: https://docs.commercy.com.ar
 */
import crypto from "node:crypto";

export const COMMERCY_API_BASE =
  process.env.COMMERCY_API_BASE ?? "https://api.commercy.com.ar";

export const API_VERSION = process.env.COMMERCY_API_VERSION ?? "2026-10";

export const API_ROOT = `${COMMERCY_API_BASE}/api/public/${API_VERSION}`;

const b64url = (buf: Buffer): string =>
  buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function randomValue(bytes = 32): string {
  return b64url(crypto.randomBytes(bytes));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomValue(32); // 43 caracteres base64url
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}

/** Paso 1 del flujo: URL para mandar al comerciante a la pantalla de consentimiento. */
export function buildAuthorizeUrl({
  clientId,
  redirectUri,
  state,
  challenge,
}: AuthorizeUrlParams): string {
  const url = new URL(`${COMMERCY_API_BASE}/oauth/apps/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: challenge,
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

export class CommercyError extends Error {
  status: number;
  code?: string;
  requestId?: string;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = "CommercyError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export type OAuthErrorBody = {
  error: string;
  error_description?: string;
};

export class OAuthError extends Error {
  status: number;
  error: string;
  description?: string;

  constructor(status: number, body: OAuthErrorBody) {
    super(`OAuth ${body.error}${body.error_description ? `: ${body.error_description}` : ""}`);
    this.name = "OAuthError";
    this.status = status;
    this.error = body.error;
    this.description = body.error_description;
  }
}

export interface TokenRequestParams {
  grant_type: "authorization_code" | "refresh_token";
  code?: string;
  code_verifier?: string;
  refresh_token?: string;
  redirect_uri?: string;
}

/**
 * POST /oauth/apps/token con client_secret_basic.
 * El body puede ser urlencoded o JSON; la doc permite ambos.
 */
export async function tokenRequest(
  credentials: { clientId: string; clientSecret: string },
  params: TokenRequestParams,
): Promise<TokenSet> {
  const basic = Buffer.from(
    `${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(credentials.clientSecret)}`,
  ).toString("base64");

  const res = await fetch(`${COMMERCY_API_BASE}/oauth/apps/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]),
  });

  const body = (await res.json()) as TokenSet | OAuthErrorBody;
  if (!res.ok) {
    const err = body as OAuthErrorBody;
    if (err && typeof err.error === "string") throw new OAuthError(res.status, err);
    throw new CommercyError("Respuesta inesperada del endpoint de token", res.status);
  }
  return body as TokenSet;
}

/** Canje del code de autorización (crea la instalación). */
export function exchangeCode(
  credentials: { clientId: string; clientSecret: string },
  args: { code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  return tokenRequest(credentials, {
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.verifier,
    redirect_uri: args.redirectUri,
  });
}

/** Refresh rotativo: cada refresh token se usa UNA sola vez. */
export function refreshAccessToken(
  credentials: { clientId: string; clientSecret: string },
  refreshToken: string,
): Promise<TokenSet> {
  return tokenRequest(credentials, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export class CommercyClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    options: { body?: unknown; query?: Record<string, string>; idempotencyKey?: string } = {},
  ): Promise<T> {
    const url = new URL(`${API_ROOT}${path}`);
    if (options.query) url.search = new URLSearchParams(options.query).toString();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const res = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const requestId = res.headers.get("x-request-id") ?? undefined;
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      throw new CommercyError(
        err.error?.message ?? `API ${method} ${path} falló con ${res.status}`,
        res.status,
        err.error?.code,
        requestId,
      );
    }
    return (await res.json()) as T;
  }

  store() {
    return this.request<{ data: { id: string; name: string; currency: string; plan_tier: string; shops: { id: string; name: string }[] } }>(
      "GET",
      "/store",
    );
  }

  shops() {
    return this.request<{ data: unknown[] }>("GET", "/shops");
  }

  products(query: { updated_since?: string; limit?: string; cursor?: string } = {}) {
    return this.request<{ data: unknown[]; next_cursor: string | null }>("GET", "/products", { query });
  }

  product(id: string) {
    return this.request<{ data: unknown }>("GET", `/products/${id}`);
  }

  stock(query: { shop: string; product?: string; limit?: string; cursor?: string }) {
    return this.request<{ data: unknown[]; next_cursor: string | null }>("GET", "/stock", { query });
  }

  orders(query: { status?: string; updated_since?: string; shop?: string; limit?: string; cursor?: string } = {}) {
    return this.request<{ data: unknown[]; next_cursor: string | null }>("GET", "/orders", { query });
  }

  order(id: string) {
    return this.request<{ data: unknown }>("GET", `/orders/${id}`);
  }

  updateOrderStatus(
    id: string,
    body: { status: "confirmed" | "preparing" | "shipped" | "delivered"; notes?: string },
  ) {
    return this.request<{ data: unknown }>("POST", `/orders/${id}/status`, { body });
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export const SIGNATURE_TOLERANCE_SECONDS = 300; // 5 minutos

export interface WebhookHeaders {
  "x-commercy-timestamp"?: string;
  "x-commercy-signature"?: string;
}

/**
 * Verificación de la firma de webhooks de Commercy.
 * Firma = HMAC-SHA256(secreto, "<timestamp>.<cuerpo crudo>") en hex con prefijo "v1=".
 * El cuerpo crudo debe ser exactamente el que llegó (bytes), sin re-serializar.
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const timestamp = headers["x-commercy-timestamp"];
  const signature = headers["x-commercy-signature"];
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected =
    "v1=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
