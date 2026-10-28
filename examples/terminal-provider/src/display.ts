/**
 * Lo que Commercy MUESTRA en el POS o el kiosco (`display` de la respuesta de creación) y las reglas con las que lo
 * valida. El cliente final mira esto, así que Commercy lo valida con formato, no sólo con tipos: si un campo que va a
 * mostrar no pasa, rechaza TODO el `display`. Los validadores de abajo son las mismas reglas (los usa `loadConfig`
 * para fallar al arrancar si los datos de transferencia están mal, y los tests para comprobar lo que esta app arma).
 *
 * Docs: https://docs.commercy.com.ar/pos-payment-apps#qué-mostramos-el-display
 */

export const ALIAS_RE = /^[a-zA-Z0-9.-]{6,20}$/;

const INSTRUCTIONS_MAX = 280;
const QR_DATA_MAX = 2048;
/** Controles, marcas de dirección de texto (bidi) y separadores de línea/párrafo: nunca en un texto que se muestra. */
const FORBIDDEN_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const FORBIDDEN_CHARS_GLOBAL_RE = new RegExp(FORBIDDEN_CHARS_RE.source, "g");
const HEX4_RE = /^[0-9a-fA-F]{4}$/;

// ── QR EMVCo ───────────────────────────────────────────────────────────────

/**
 * CRC-16/CCITT-FALSE (polinomio 0x1021, valor inicial 0xFFFF, sin reflejo ni xorout) sobre los bytes UTF-8 del
 * texto. Con «ñ» o acentos los bytes difieren de los caracteres: calcularlo sobre los caracteres da otro CRC.
 */
export function crc16Ccitt(input: string): number {
  let crc = 0xffff;
  for (const byte of Buffer.from(input, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Campo TLV de EMVCo: tag de 2 dígitos + largo de 2 dígitos (en bytes UTF-8) + valor. */
export function tlv(tag: string, value: string): string {
  const length = Buffer.byteLength(value, "utf8");
  if (length > 99) throw new RangeError(`EMVCo: el campo ${tag} no puede pasar de 99 bytes`);
  return `${tag}${String(length).padStart(2, "0")}${value}`;
}

export interface QrInput {
  /** Monto del contrato (`"1234.50"`). */
  amount: string;
  /** Referencia del cobro (el `payment_ref`): la app la recupera cuando el cliente paga. */
  reference: string;
  merchantName: string;
  merchantCity: string;
}

/** QR EMVCo dinámico (`000201…`) que termina en el campo `63` de largo `04` con el CRC. */
export function buildEmvQr({ amount, reference, merchantName, merchantCity }: QrInput): string {
  const body =
    tlv("00", "01") +
    tlv("01", "12") + // dinámico: un QR por cobro
    tlv("26", tlv("00", "AR.COM.EJEMPLO.TERMINAL") + tlv("01", reference)) +
    tlv("52", "5411") +
    tlv("53", "032") + // ARS
    tlv("54", amount) +
    tlv("58", "AR") +
    tlv("59", merchantName) +
    tlv("60", merchantCity) +
    tlv("62", tlv("05", reference.slice(0, 25))) +
    "6304";
  return body + crc16Ccitt(body).toString(16).toUpperCase().padStart(4, "0");
}

/** Cadena TLV que consume el texto exacto y termina en el tag `63` de largo `04` (nada puede seguir al CRC). */
function isTlvEndingInCrc(text: string): boolean {
  let i = 0;
  let lastTag = "";
  let lastLen = "";
  while (i < text.length) {
    const tag = text.slice(i, i + 2);
    const len = text.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(len)) return false;
    const next = i + 4 + Number(len);
    if (next > text.length) return false;
    if (lastTag === "63") return false;
    lastTag = tag;
    lastLen = len;
    i = next;
  }
  return lastTag === "63" && lastLen === "04";
}

/**
 * Lo que exige Commercy de un QR EMVCo: Unicode imprimible, empieza con `000201`, es una cadena de campos bien
 * formada que termina EXACTAMENTE en el campo `63` de largo `04`, y ese CRC es el CRC-16/CCITT-FALSE de los bytes
 * UTF-8 de todo hasta `6304` inclusive. Los generadores cuentan el largo de un campo en caracteres o en bytes
 * (difieren con «ñ»): se acepta cualquiera de los dos; la integridad la da el CRC.
 */
export function isValidEmvQr(s: unknown): boolean {
  if (typeof s !== "string" || s.length < 16 || s.length > QR_DATA_MAX || FORBIDDEN_CHARS_RE.test(s)) return false;
  if (!s.startsWith("000201")) return false;
  const byteView = Buffer.from(s, "utf8").toString("latin1"); // un char por byte UTF-8
  if (!isTlvEndingInCrc(s) && !isTlvEndingInCrc(byteView)) return false;
  const given = s.slice(-4);
  if (!HEX4_RE.test(given)) return false;
  return given.toUpperCase() === crc16Ccitt(s.slice(0, -4)).toString(16).toUpperCase().padStart(4, "0");
}

// ── CVU y CUIT ─────────────────────────────────────────────────────────────

const verifier = (digits: string, weights: number[]): number => {
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) sum += Number(digits[i]) * (weights[i] ?? 0);
  return (10 - (sum % 10)) % 10;
};

/** CBU/CVU: 22 dígitos; dígito verificador del bloque 1 (posición 8) y del bloque 2 (posición 22), algoritmo del BCRA. */
export function isValidCvu(s: unknown): boolean {
  if (typeof s !== "string" || !/^\d{22}$/.test(s)) return false;
  const block1 = s.slice(0, 8);
  const block2 = s.slice(8);
  return (
    verifier(block1, [7, 1, 3, 9, 7, 1, 3]) === Number(block1[7]) &&
    verifier(block2, [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]) === Number(block2[13])
  );
}

/** CUIT/CUIL de 11 dígitos (con o sin guiones `30-71234567-1`) con dígito verificador (módulo 11). */
export function isValidCuit(s: unknown): boolean {
  if (typeof s !== "string" || !/^(\d{11}|\d{2}-\d{8}-\d)$/.test(s)) return false;
  const d = s.replace(/-/g, "");
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i += 1) sum += Number(d[i]) * (weights[i] ?? 0);
  const r = 11 - (sum % 11);
  const check = r === 11 ? 0 : r;
  if (check === 10) return false; // no existe un CUIT con verificador 10
  return check === Number(d[10]);
}

// ── Texto plano ────────────────────────────────────────────────────────────

/** Texto de un tercero (p. ej. el número de venta) listo para meter en `instructions`: sin controles ni bidi, acotado. */
export function cleanText(value: string, max: number): string {
  return Array.from(value.replace(FORBIDDEN_CHARS_GLOBAL_RE, "").trim()).slice(0, max).join("");
}

/**
 * `instructions` es texto plano de hasta 280 caracteres. Sólo se permite `\n` como salto (nada de `\t`, `\r` sueltos
 * ni HTML: se muestra literal). Devuelve `true` si cumple.
 */
export function isValidInstructions(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const text = s.trim();
  if (!text || Array.from(text).length > INSTRUCTIONS_MAX) return false;
  return !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(s);
}

// ── Display por modo ───────────────────────────────────────────────────────

export interface Transfer {
  cvu?: string;
  alias?: string;
  holder_name?: string;
  holder_cuit?: string;
}

export interface Display {
  qr_data?: string;
  instructions?: string;
  transfer?: Transfer;
}

/** Valida los datos de transferencia configurados; devuelve el primer problema o `null`. */
export function transferProblem(t: Transfer): string | null {
  if (!t.cvu && !t.alias) return "hace falta al menos un CVU o un alias";
  if (t.cvu !== undefined && !isValidCvu(t.cvu)) return `TRANSFER_CVU inválido (22 dígitos con verificador): ${t.cvu}`;
  if (t.alias !== undefined && !ALIAS_RE.test(t.alias)) return `TRANSFER_ALIAS inválido (6 a 20: letras, números, punto y guion): ${t.alias}`;
  if (t.holder_name !== undefined && (!t.holder_name.trim() || Array.from(t.holder_name).length > 80 || FORBIDDEN_CHARS_RE.test(t.holder_name))) {
    return "TRANSFER_HOLDER_NAME inválido (texto plano de hasta 80 caracteres)";
  }
  if (t.holder_cuit !== undefined && !isValidCuit(t.holder_cuit)) return `TRANSFER_HOLDER_CUIT inválido (CUIT con verificador): ${t.holder_cuit}`;
  return null;
}
