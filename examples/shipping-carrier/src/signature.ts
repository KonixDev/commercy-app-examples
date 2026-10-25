/**
 * Verificación de los requests firmados que Commercy le hace a una app de envío.
 * Es el mismo esquema que los webhooks:
 *   X-Commercy-Signature = "v1=" + HMAC-SHA256(secreto, "<X-Commercy-Timestamp>.<cuerpo crudo>") en hex
 *
 * Docs: https://docs.commercy.com.ar/shipping-apps.md
 */
import crypto from "node:crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 300; // 5 minutos

export interface SignedHeaders {
  "x-commercy-timestamp"?: string;
  "x-commercy-signature"?: string;
}

/**
 * `rawBody` tiene que ser el cuerpo EXACTO que llegó (antes de parsear el JSON).
 * Rechaza timestamps a más de 5 minutos de tu reloj (protección contra replay).
 */
export function verifyCommercyRequest(
  rawBody: string,
  headers: SignedHeaders,
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
  // timingSafeEqual exige el mismo largo: comparar largos primero no filtra nada útil.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
