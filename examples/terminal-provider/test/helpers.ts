import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { DEFAULT_TRANSFER, loadConfig, type AppConfig } from "../src/config.js";
import type { NoticePayment, NoticeResult } from "../src/commercy.js";

export const SECRET = "whsec_test_actual";
export const PREVIOUS_SECRET = "whsec_test_anterior";
export const ADMIN_TOKEN = "admin-token-de-prueba";
export const INSTALLATION = "6710b3c2e4a1f20012ab34cd";
export const SHOP = "6710b3c2e4a1f20012ab34d0";

const nowSec = () => Math.floor(Date.now() / 1000);

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({ COMMERCY_WEBHOOK_SECRET: SECRET, ADMIN_TOKEN, COMMERCY_API_BASE: "http://127.0.0.1:1" }),
    secrets: [SECRET, PREVIOUS_SECRET],
    transfer: { ...DEFAULT_TRANSFER },
    ...overrides,
  };
}

/** Firma como Commercy: HMAC-SHA256(secreto, "<ts>.<cuerpo crudo>") en hex con prefijo v1=. */
export function signedHeaders(raw: string, secret = SECRET, opts: { ts?: number; installation?: string } = {}): Record<string, string> {
  const timestamp = String(opts.ts ?? nowSec());
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Commercy-Timestamp": timestamp,
    "X-Commercy-Signature": "v1=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex"),
    "X-Commercy-Contract": "2026-10",
  };
  if (opts.installation) headers["X-Commercy-Installation"] = opts.installation;
  return headers;
}

export interface TestServer {
  base: string;
  notices: NoticePayment[];
  /** Respuesta que da el `notify` inyectado. */
  setNoticeResult(result: NoticeResult): void;
  close(): Promise<void>;
  /** POST firmado como Commercy. `body` se serializa; `raw` pisa el cuerpo enviado (para firmar otro). */
  post(path: string, body: unknown, opts?: { secret?: string; ts?: number; installation?: string; sendRaw?: string; unsigned?: boolean }): Promise<{ status: number; json: any }>;
  admin(method: "GET" | "POST", path: string, body?: unknown, token?: string | null): Promise<{ status: number; json: any }>;
}

export async function startServer(config: AppConfig = testConfig()): Promise<TestServer> {
  const notices: NoticePayment[] = [];
  let noticeResult: NoticeResult = { delivered: true, status: 200, retrying: false };
  const { app } = createApp({
    config,
    log: () => undefined,
    notify: async (payment) => {
      notices.push(payment);
      return noticeResult;
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const parse = async (res: Response) => {
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  };

  return {
    base,
    notices,
    setNoticeResult: (r) => void (noticeResult = r),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    async post(path, body, opts = {}) {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      const installation = opts.installation ?? (typeof body === "object" && body !== null ? (body as { installation_id?: string }).installation_id : undefined);
      const headers = opts.unsigned ? { "Content-Type": "application/json" } : signedHeaders(raw, opts.secret, { ts: opts.ts, installation });
      return parse(await fetch(`${base}${path}`, { method: "POST", headers, body: opts.sendRaw ?? raw }));
    },
    async admin(method, path, body, token = ADMIN_TOKEN) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      return parse(await fetch(`${base}/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    },
  };
}

let counter = 0;
/** `payment_ref` como los de Commercy: 32 caracteres [a-z0-9]. */
export const newRef = (): string => `ref${String(++counter).padStart(2, "0")}${crypto.randomBytes(14).toString("hex")}`.slice(0, 32);

/** Cuerpo de creación como el que manda Commercy. */
export function createBody(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    installation_id: INSTALLATION,
    shop_id: SHOP,
    payment_ref: newRef(),
    order: { id: "6710d1e0e4a1f20012ab3600", number: "1042" },
    amount: "1234.50",
    currency: "ARS",
    mode: "qr",
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    display_title: "Venta 1042",
    print_ticket: false,
    ...overrides,
  };
}

export const lookupBody = (ref: string, extra: Record<string, unknown> = {}) => ({ installation_id: INSTALLATION, shop_id: SHOP, payment_ref: ref, ...extra });
