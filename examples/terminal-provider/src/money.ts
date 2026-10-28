/**
 * Montos del contrato: STRING con dos decimales (`"1234.50"`), moneda `ARS`, comparados en centavos enteros
 * (nunca float). `1234.5` (número), `"1234.5"`, `"-1.00"` y `"1e3"` no son montos válidos: Commercy descarta la
 * respuesta entera. Ojo: en las apps de pago ONLINE el monto va como número; acá no.
 */

const MONEY_RE = /^\d{1,10}\.\d{2}$/;

/** Centavos enteros de un monto del contrato, o `null` si no es exactamente `^\d{1,10}\.\d{2}$`. */
export function parseMoney(value: unknown): number | null {
  if (typeof value !== "string" || !MONEY_RE.test(value)) return null;
  return Number(value.replace(".", ""));
}

/** Centavos → string del contrato (`123450` → `"1234.50"`). */
export function formatMoney(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
