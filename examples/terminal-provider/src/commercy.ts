/**
 * Lo que esta app necesita de Commercy:
 * - Verificar la firma de los requests que Commercy te manda (devices, payments, status, cancel).
 * - Firmar el aviso `pos_payment.updated` que le mandás a Commercy.
 *
 * Es el mismo esquema que los webhooks y que las apps de pago online. Docs: https://docs.commercy.com.ar/pos-payment-apps
 */
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const SIGNATURE_TOLERANCE_SECONDS = 300; // 5 minutos

const sign = (secret: string, timestamp: string, rawBody: string): string =>
  "v1=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Firma = HMAC-SHA256(secreto, "<X-Commercy-Timestamp>.<cuerpo crudo>") en hex, con prefijo "v1=", ventana de ±5 min.
 * El cuerpo tiene que ser el crudo (los bytes tal cual llegaron), nunca el JSON re-serializado.
 *
 * `secrets`: el secreto vigente y, mientras rotás, el anterior. Commercy firma con el NUEVO desde el momento de la
 * rotación, así que mientras desplegás el secreto nuevo aceptá los dos.
 */
export function verifyCommercyRequest(
  rawBody: string,
  headers: IncomingHttpHeaders,
  secrets: string[],
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const timestamp = header(headers, "x-commercy-timestamp");
  const signature = header(headers, "x-commercy-signature");
  if (!timestamp || !signature) return false;

  // Sólo dígitos: descarta "1e9", " 12", etc. antes de comparar la ventana.
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const received = Buffer.from(signature);
  let ok = false;
  for (const secret of secrets) {
    const expected = Buffer.from(sign(secret, timestamp, rawBody));
    // Se compara contra todos (sin cortar en el primero) y en tiempo constante.
    if (expected.length === received.length && crypto.timingSafeEqual(expected, received)) ok = true;
  }
  return ok;
}

/** Headers para avisarle a Commercy que cambió el estado de un cobro. */
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

// ── Aviso hacia Commercy ───────────────────────────────────────────────────

export interface NoticePayment {
  installationId: string;
  paymentId: string;
  paymentRef: string;
}

export interface NoticeResult {
  /** Commercy contestó 2xx. Un 202 (ya hay una consulta en curso para ese cobro) cuenta como entregado, pero se reintenta unos segundos después (ver `MAX_BUSY_RETRIES`). */
  delivered: boolean;
  /** HTTP de la respuesta, si hubo. */
  status?: number;
  error?: string;
  /** El primer intento falló por algo transitorio (o fue un 202) y los reintentos siguen en segundo plano. */
  retrying: boolean;
}

export type Notify = (payment: NoticePayment) => Promise<NoticeResult>;

export interface NotifyOptions {
  /** Esperas entre reintentos ante 5xx, 429, error de red o 202. */
  retryDelaysMs?: number[];
  log?: (...args: unknown[]) => void;
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];
/**
 * Un 202 quiere decir que Commercy ya estaba consultando ese cobro: el estado que leyó puede ser anterior al cambio que avisás.
 * Se reintenta unos segundos después, hasta 3 veces; si sigue en 202, la consulta de Commercy (y su barrido) lo alcanzan igual.
 */
const MAX_BUSY_RETRIES = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /api/v1/app-webhooks/:installationId con `pos_payment.updated`.
 *
 * El aviso NO lleva el estado: sólo dice qué cobro cambió. Commercy lo vuelve a consultar en tu `status` y nunca
 * aplica el contenido del aviso. Va con `Content-Type: application/json` (obligatorio) y firmado con tu secreto
 * vigente. Reintenta con espera creciente ante un 5xx, un 429 o un error de red; con 401/404 no tiene sentido
 * (secreto, reloj o id de instalación mal). Ante un 202 (Commercy ya estaba consultando ese cobro) reintenta a los pocos segundos,
 * hasta 3 veces. Atiende hasta 120 avisos por minuto por instalación.
 *
 * Devuelve después del PRIMER intento; los reintentos, si hacen falta, siguen en segundo plano.
 */
export async function notifyCommercy(
  apiBase: string,
  secret: string,
  payment: NoticePayment,
  { retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, log = console.log }: NotifyOptions = {},
): Promise<NoticeResult> {
  const raw = JSON.stringify({
    type: "pos_payment.updated",
    installation_id: payment.installationId,
    payment_id: payment.paymentId,
    payment_ref: payment.paymentRef,
  });
  const url = `${apiBase}/api/v1/app-webhooks/${encodeURIComponent(payment.installationId)}`;

  const attempt = async (): Promise<NoticeResult & { retryable: boolean }> => {
    try {
      // Se firma de nuevo en cada intento: el timestamp vale 5 minutos.
      const res = await fetch(url, {
        method: "POST",
        headers: signCommercyWebhook(raw, secret),
        body: raw,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      const delivered = res.status >= 200 && res.status < 300;
      return { delivered, status: res.status, retrying: false, retryable: res.status >= 500 || res.status === 429 || res.status === 202 };
    } catch (err) {
      return { delivered: false, error: (err as Error).message, retrying: false, retryable: true };
    }
  };

  const first = await attempt();
  const { retryable, ...result } = first;
  const tag = `[aviso→commercy] ${payment.paymentRef}`;
  if (result.delivered && !retryable) {
    log(`${tag}: OK (HTTP ${result.status})`);
    return result;
  }
  if (!retryable || retryDelaysMs.length === 0) {
    log(`${tag}: ${result.error ?? `HTTP ${result.status}`} (no se reintenta)`);
    return result;
  }

  log(`${tag}: ${result.error ?? `HTTP ${result.status}`}, se reintenta en segundo plano`);
  void (async () => {
    let busyReplies = result.status === 202 ? 1 : 0;
    for (const delay of retryDelaysMs) {
      await sleep(delay);
      const next = await attempt();
      if (next.status === 202) {
        busyReplies += 1;
        if (busyReplies > MAX_BUSY_RETRIES) return log(`${tag}: Commercy sigue consultando (202); lo alcanza su consulta`);
        continue;
      }
      if (next.delivered) return log(`${tag}: OK tras reintentar (HTTP ${next.status})`);
      if (!next.retryable) return log(`${tag}: ${next.error ?? `HTTP ${next.status}`} (se deja de reintentar)`);
    }
    log(`${tag}: se agotaron los reintentos. Commercy igual lo consulta mientras espera y en su barrido.`);
  })();
  return { ...result, retrying: true };
}
