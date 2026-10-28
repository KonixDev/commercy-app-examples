import { buildEmvQr, isValidEmvQr, transferProblem, type Transfer } from "./display.js";
import { parseMoney } from "./money.js";

export type Mode = "device" | "qr" | "none";
export type CancelMode = "sync" | "async" | "unsupported";
export type DeviceStatus = "online" | "offline" | "busy" | "unknown";

export interface Device {
  id: string;
  label?: string;
  status: DeviceStatus;
}

export interface AppConfig {
  /** Secretos vigentes: el actual primero y, durante una rotación, el anterior. */
  secrets: string[];
  apiBase: string;
  /** `null`: el simulador (/admin) está apagado. */
  adminToken: string | null;
  modes: Mode[];
  cancel: CancelMode;
  devices: Device[];
  /** Rango de monto que aceptás (strings del contrato). */
  amountMin: string;
  amountMax: string;
  merchant: { name: string; city: string };
  transfer: Transfer;
}

const MODES: Mode[] = ["device", "qr", "none"];
const CANCEL_MODES: CancelMode[] = ["sync", "async", "unsupported"];
const DEVICE_STATUSES: DeviceStatus[] = ["online", "offline", "busy", "unknown"];

const DEFAULT_DEVICES: Device[] = [
  { id: "reader_01", label: "Caja 1", status: "online" },
  { id: "reader_02", label: "Caja 2", status: "online" },
];

export const DEFAULT_TRANSFER: Transfer = {
  // Los del ejemplo de la documentación: válidos (verificadores correctos) pero de mentira.
  cvu: "0000003101000000000001",
  alias: "tienda.pagos",
  holder_name: "Tienda SRL",
  holder_cuit: "30-71234567-1",
};

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

function parseDevices(raw: string): Device[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DEVICES no es JSON válido");
  }
  if (!Array.isArray(parsed)) throw new Error("DEVICES tiene que ser un arreglo [{ id, label?, status? }]");
  const seen = new Set<string>();
  return parsed.map((item: unknown) => {
    const d = (item ?? {}) as Record<string, unknown>;
    if (typeof d.id !== "string" || !/^[\x21-\x7e]{1,200}$/.test(d.id)) throw new Error("DEVICES: cada lector necesita un id ASCII sin espacios (1 a 200)");
    if (seen.has(d.id)) throw new Error(`DEVICES: id repetido (${d.id})`);
    seen.add(d.id);
    const status = (d.status ?? "online") as DeviceStatus;
    if (!DEVICE_STATUSES.includes(status)) throw new Error(`DEVICES: status inválido (${String(d.status)})`);
    return { id: d.id, ...(typeof d.label === "string" && d.label ? { label: d.label } : {}), status };
  });
}

/**
 * Lee y valida el entorno. Tira un Error con el motivo (index.ts lo imprime y sale): un dato de transferencia o un
 * nombre de comercio mal puesto hace que Commercy rechace el `display` entero, y es mejor enterarse al arrancar.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig & { port: number } {
  const secret = env.COMMERCY_WEBHOOK_SECRET;
  if (!secret) throw new Error("Falta COMMERCY_WEBHOOK_SECRET. Copiá .env.example a .env y completalo.");
  const previous = env.COMMERCY_WEBHOOK_SECRET_PREVIOUS;

  const modes = (env.MODES ?? MODES.join(","))
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean) as Mode[];
  if (modes.length === 0 || modes.some((m) => !MODES.includes(m)) || new Set(modes).size !== modes.length) {
    throw new Error(`MODES inválido: usá una lista sin repetir de ${MODES.join(" | ")} separada por comas`);
  }

  const cancel = (env.CANCEL_MODE ?? "sync") as CancelMode;
  if (!CANCEL_MODES.includes(cancel)) throw new Error(`CANCEL_MODE inválido: ${CANCEL_MODES.join(" | ")}`);

  const amountMin = env.AMOUNT_MIN ?? "1.00";
  const amountMax = env.AMOUNT_MAX ?? "500000.00";
  const min = parseMoney(amountMin);
  const max = parseMoney(amountMax);
  if (min === null || max === null) throw new Error('AMOUNT_MIN y AMOUNT_MAX son strings con dos decimales, p. ej. "1.00"');
  if (min > max) throw new Error("AMOUNT_MIN no puede ser mayor que AMOUNT_MAX");

  const merchant = { name: env.MERCHANT_NAME ?? "Ñandú Pagos", city: env.MERCHANT_CITY ?? "CABA" };
  if (Array.from(merchant.name).length > 25 || Array.from(merchant.city).length > 15) {
    throw new Error("MERCHANT_NAME admite hasta 25 caracteres y MERCHANT_CITY hasta 15");
  }
  // Un QR de muestra con esos datos tiene que pasar la validación EMVCo de Commercy.
  if (!isValidEmvQr(buildEmvQr({ amount: "1.00", reference: "a".repeat(32), merchantName: merchant.name, merchantCity: merchant.city }))) {
    throw new Error("MERCHANT_NAME / MERCHANT_CITY generan un QR EMVCo inválido");
  }

  const transfer: Transfer = {
    cvu: env.TRANSFER_CVU ?? DEFAULT_TRANSFER.cvu,
    alias: env.TRANSFER_ALIAS ?? DEFAULT_TRANSFER.alias,
    holder_name: env.TRANSFER_HOLDER_NAME ?? DEFAULT_TRANSFER.holder_name,
    holder_cuit: env.TRANSFER_HOLDER_CUIT ?? DEFAULT_TRANSFER.holder_cuit,
  };
  const problem = transferProblem(transfer);
  if (problem) throw new Error(problem);

  return {
    secrets: [secret, ...(previous ? [previous] : [])],
    apiBase: trimSlash(env.COMMERCY_API_BASE ?? "https://api.commercy.com.ar"),
    adminToken: env.ADMIN_TOKEN || null,
    modes,
    cancel,
    devices: env.DEVICES ? parseDevices(env.DEVICES) : DEFAULT_DEVICES.map((d) => ({ ...d })),
    amountMin,
    amountMax,
    merchant,
    transfer,
    port: Number(env.PORT ?? 3000),
  };
}
