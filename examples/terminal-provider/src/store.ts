/**
 * El "procesador" de juguete: cobros en memoria, por `payment_ref`. En producción esto es tu procesador de pagos
 * (y una base con índice único en `payment_ref`); lo que importa de acá es el CONTRATO:
 *
 * - Idempotencia por `payment_ref`: mismo cuerpo → mismo `payment_id`; otro cuerpo → `idempotency_conflict`.
 * - Si no conocés un `payment_ref` (en `status` o `cancel`) lo das por CONSUMIDO: desde ese momento rechazás crearlo,
 *   para que un reintento de creación que todavía viaja por la red no cree el cobro después de que Commercy lo dio
 *   por inexistente.
 * - `amount_paid` es el total BRUTO cobrado (con recargo y propina), antes de las comisiones. Montos siempre string.
 * - Tu app no se entera de nada del comprador: sólo del número de venta, el monto, las cuotas y el modo.
 */
import crypto from "node:crypto";
import type { AppConfig, DeviceStatus, Mode } from "./config.js";
import { buildEmvQr, cleanText, type Display } from "./display.js";
import { formatMoney, parseMoney } from "./money.js";

export type PosStatus =
  | "pending"
  | "in_process"
  | "approved"
  | "partial"
  | "rejected"
  | "cancel_requested"
  | "cancelled"
  | "expired"
  | "refunded"
  | "partially_refunded";

export type CancelResult = "cancelled" | "cancel_requested" | "not_cancellable";

/** Estados en los que el cobro sigue vivo (el lector está ocupado y todavía se puede cancelar o pagar). */
const ACTIVE: PosStatus[] = ["pending", "in_process", "cancel_requested"];

export interface Payment {
  paymentRef: string;
  paymentId: string;
  installationId: string;
  shopId: string;
  /** Cuerpo de la creación, normalizado: sirve para distinguir un reintento de un `idempotency_conflict`. */
  bodyKey: string;
  orderId: string;
  orderNumber: string;
  amount: string;
  mode: Mode;
  deviceId?: string;
  installments?: { count: number; cost: "buyer" | "seller" };
  expiresAt: string;
  status: PosStatus;
  amountPaid: string;
  amountExtra?: { tip?: string; surcharge?: string };
  refundedAmount?: string;
  errorCode?: string;
  details?: { installments?: number; card_last4?: string; card_brand?: string; auth_code?: string };
  display?: Display;
  cancelResults: Map<string, CancelResult>;
}

export type CreateBody = {
  installation_id: string;
  shop_id: string;
  payment_ref: string;
  order: { id: string; number: string };
  amount: string;
  currency: "ARS";
  mode: Mode;
  device_id?: string;
  installments?: { count: number; cost: "buyer" | "seller" };
  expires_at: string;
  display_title: string;
  print_ticket?: boolean;
};

export type CreateOutcome =
  | { ok: true; payment: Payment }
  | { ok: false; httpStatus: number; code: string; message: string };

export type TransitionOutcome = { ok: true; payment: Payment } | { ok: false; httpStatus: number; code: string; message: string };

/** JSON con las claves ordenadas: dos cuerpos iguales con otro orden de claves son el mismo cuerpo. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const fail = (httpStatus: number, code: string, message: string): { ok: false; httpStatus: number; code: string; message: string } => ({
  ok: false,
  httpStatus,
  code,
  message,
});

export class Store {
  private readonly payments = new Map<string, Payment>(); // payment_ref → cobro
  private readonly consumed = new Set<string>(); // refs por las que ya contestamos payment_not_found
  private readonly deviceStatus = new Map<string, DeviceStatus>();
  private seq = 0;

  constructor(private readonly config: AppConfig) {
    for (const d of config.devices) this.deviceStatus.set(d.id, d.status);
  }

  // ── Dispositivos ─────────────────────────────────────────────────────────

  /** Un lector con un cobro vivo está `busy`, sea cual sea su estado de conexión (salvo `offline`). */
  listDevices(installationId: string): Array<{ id: string; label?: string; status: DeviceStatus }> {
    return this.config.devices.map((d) => {
      const stored = this.deviceStatus.get(d.id) ?? "unknown";
      const status = stored === "online" && this.deviceInUse(installationId, d.id) ? "busy" : stored;
      return { id: d.id, ...(d.label ? { label: d.label } : {}), status };
    });
  }

  /** Simula que el lector se desconecta, se ocupa o vuelve (lo usa el simulador). Crea el lector si no existía. */
  setDevice(id: string, status: DeviceStatus, label?: string): void {
    if (!this.config.devices.some((d) => d.id === id)) this.config.devices.push({ id, ...(label ? { label } : {}), status });
    this.deviceStatus.set(id, status);
  }

  private deviceInUse(installationId: string, deviceId: string): boolean {
    for (const p of this.payments.values()) {
      if (p.installationId === installationId && p.deviceId === deviceId && ACTIVE.includes(p.status)) return true;
    }
    return false;
  }

  // ── Crear ────────────────────────────────────────────────────────────────

  /** Resultado de una creación: el cobro nuevo o el existente (reintento idempotente), o el error tipado. */
  create(body: CreateBody): CreateOutcome & { replay?: boolean } {
    const existing = this.payments.get(body.payment_ref);
    const bodyKey = stableStringify(body);
    if (existing) {
      if (existing.bodyKey !== bodyKey) {
        return fail(409, "idempotency_conflict", "el payment_ref ya existe con otro cuerpo");
      }
      return { ok: true, payment: existing, replay: true };
    }
    if (this.consumed.has(body.payment_ref)) {
      return fail(409, "payment_ref_consumed", "ese payment_ref ya se dio por inexistente: no se puede crear");
    }

    if (!this.config.modes.includes(body.mode)) return fail(422, "not_available", `el modo ${body.mode} no está habilitado`);
    const cents = parseMoney(body.amount) ?? 0;
    if (cents < (parseMoney(this.config.amountMin) ?? 0) || cents > (parseMoney(this.config.amountMax) ?? Infinity)) {
      return fail(422, "amount_out_of_range", `el monto tiene que estar entre ${this.config.amountMin} y ${this.config.amountMax}`);
    }
    if (body.mode === "device") {
      const deviceId = body.device_id ?? "";
      if (!this.config.devices.some((d) => d.id === deviceId)) {
        // Un id mal tipeado no puede mandar la plata a otro comercio: tiene que ser un lector de ESTA instalación.
        return fail(422, "invalid_device", "el lector no pertenece a la cuenta de esa instalación");
      }
      const stored = this.deviceStatus.get(deviceId);
      if (stored === "offline") return fail(409, "device_offline", "el lector no está conectado");
      if (stored === "busy" || this.deviceInUse(body.installation_id, deviceId)) return fail(409, "device_busy", "el lector ya tiene un cobro en curso");
    }

    const payment: Payment = {
      paymentRef: body.payment_ref,
      paymentId: `pay_${crypto.randomBytes(8).toString("hex")}`,
      installationId: body.installation_id,
      shopId: body.shop_id,
      bodyKey,
      orderId: body.order.id,
      orderNumber: body.order.number,
      amount: body.amount,
      mode: body.mode,
      ...(body.mode === "device" && body.device_id ? { deviceId: body.device_id } : {}),
      ...(body.installments ? { installments: { count: body.installments.count, cost: body.installments.cost } } : {}),
      // Se respeta el vencimiento que pidió Commercy (acá no hay un procesador que lo acote); informá el REAL.
      expiresAt: new Date(body.expires_at).toISOString(),
      status: "pending",
      amountPaid: "0.00",
      cancelResults: new Map(),
    };
    const display = this.buildDisplay(payment);
    if (display) payment.display = display;
    this.payments.set(payment.paymentRef, payment);
    return { ok: true, payment };
  }

  /** `display` según el modo: `device` no muestra nada de tu app; `qr` un QR EMVCo; `none` instrucciones y transferencia. */
  private buildDisplay(p: Payment): Display | undefined {
    const number = cleanText(p.orderNumber, 20);
    if (p.mode === "qr") {
      return {
        qr_data: buildEmvQr({ amount: p.amount, reference: p.paymentRef, merchantName: this.config.merchant.name, merchantCity: this.config.merchant.city }),
        instructions: `Escaneá el QR con tu app de pagos.\nVenta ${number}`,
      };
    }
    if (p.mode === "none") {
      return {
        instructions: `Transferí $${p.amount} a la cuenta indicada.\nIndicá la venta ${number} en el concepto.`,
        transfer: { ...this.config.transfer },
      };
    }
    return undefined;
  }

  // ── Consultar ────────────────────────────────────────────────────────────

  /**
   * Busca por `payment_ref` (alcanza solo: `payment_id` es opcional). Un `payment_ref` desconocido para TODOS se da por
   * consumido; uno de otra instalación se contesta igual `payment_not_found` pero no se consume (ya existe).
   */
  find(installationId: string, paymentRef: string): Payment | null {
    const p = this.payments.get(paymentRef);
    if (!p) {
      this.consumed.add(paymentRef);
      return null;
    }
    return p.installationId === installationId ? p : null;
  }

  get(paymentRef: string): Payment | undefined {
    return this.payments.get(paymentRef);
  }

  all(): Payment[] {
    return [...this.payments.values()];
  }

  consumedRefs(): string[] {
    return [...this.consumed];
  }

  // ── Cancelar ─────────────────────────────────────────────────────────────

  /** Idempotente por `cancel_ref`: repetirlo devuelve el mismo resultado. */
  cancel(p: Payment, cancelRef: string): CancelResult {
    const done = p.cancelResults.get(cancelRef);
    if (done) return done;
    let result: CancelResult;
    if (p.status === "cancelled") result = "cancelled";
    else if (p.status === "cancel_requested") result = "cancel_requested";
    else if (this.config.cancel === "unsupported" || (p.status !== "pending" && p.status !== "in_process")) result = "not_cancellable";
    else if (this.config.cancel === "sync") {
      p.status = "cancelled";
      p.amountPaid = "0.00";
      result = "cancelled";
    } else {
      p.status = "cancel_requested"; // se confirma después (simulador: `cancel-done`)
      result = "cancel_requested";
    }
    p.cancelResults.set(cancelRef, result);
    return result;
  }

  // ── Simulador: lo que haría tu procesador por su cuenta ──────────────────

  /**
   * Resuelve un cobro "desde afuera". Reglas que Commercy hace cumplir al leer el estado, respetadas acá:
   * un `approved` sólo puede pasar a `refunded` / `partially_refunded`; `rejected`, `cancelled` y `expired` llevan
   * `amount_paid` en `"0.00"`; la suma de `amount_extra` es ≤ `amount_paid - amount_requested`.
   */
  transition(p: Payment, action: string, input: Record<string, unknown>): TransitionOutcome {
    const bad = (message: string) => fail(400, "invalid_request", message);
    const invalid = (allowed: string) => fail(409, "invalid_transition", `no se puede ${action} un cobro ${p.status} (solo desde: ${allowed})`);
    const money = (key: string): string | null | undefined => {
      const v = input[key];
      if (v === undefined) return undefined;
      return parseMoney(v) === null ? null : (v as string);
    };
    const requested = parseMoney(p.amount) ?? 0;

    switch (action) {
      case "in-process": {
        if (p.status !== "pending") return invalid("pending");
        p.status = "in_process";
        return { ok: true, payment: p };
      }
      case "approve": {
        if (!["pending", "in_process", "partial", "cancel_requested"].includes(p.status)) return invalid("pending, in_process, partial, cancel_requested");
        const tip = money("tip");
        const surcharge = money("surcharge");
        if (tip === null || surcharge === null) return bad('tip y surcharge son strings con dos decimales, p. ej. "50.00"');
        const extra = (tip ? parseMoney(tip) ?? 0 : 0) + (surcharge ? parseMoney(surcharge) ?? 0 : 0);
        p.status = "approved";
        p.errorCode = undefined;
        p.amountPaid = formatMoney(requested + extra); // BRUTO: lo que pagó el cliente, no lo que te liquidan
        if (extra > 0) p.amountExtra = { ...(tip ? { tip } : {}), ...(surcharge ? { surcharge } : {}) };
        p.details = this.approvalDetails(p);
        return { ok: true, payment: p };
      }
      case "partial": {
        if (!["pending", "in_process"].includes(p.status)) return invalid("pending, in_process");
        const paid = money("amount_paid");
        if (paid === null) return bad('amount_paid es un string con dos decimales, p. ej. "500.00"');
        const cents = paid === undefined ? Math.max(1, Math.floor(requested / 2)) : (parseMoney(paid) ?? 0);
        if (cents <= 0 || cents >= requested) return bad("amount_paid tiene que ser mayor a cero y menor al total");
        p.status = "partial";
        p.amountPaid = formatMoney(cents);
        p.details = this.approvalDetails(p);
        return { ok: true, payment: p };
      }
      case "reject": {
        if (!["pending", "in_process"].includes(p.status)) return invalid("pending, in_process");
        const code = input.code ?? "declined";
        if (typeof code !== "string" || !["declined", "customer_canceled", "device_busy", "device_offline", "other"].includes(code)) {
          return bad("code: declined | customer_canceled | device_busy | device_offline | other");
        }
        p.status = "rejected";
        p.amountPaid = "0.00";
        p.errorCode = code;
        return { ok: true, payment: p };
      }
      case "expire": {
        if (!ACTIVE.includes(p.status)) return invalid("pending, in_process, cancel_requested");
        p.status = "expired";
        p.amountPaid = "0.00";
        return { ok: true, payment: p };
      }
      case "cancel-done": {
        // La confirmación de una cancelación asíncrona (o el cliente que cancela en el lector).
        if (!ACTIVE.includes(p.status)) return invalid("pending, in_process, cancel_requested");
        p.status = "cancelled";
        p.amountPaid = "0.00";
        return { ok: true, payment: p };
      }
      case "refund": {
        if (p.status !== "approved" && p.status !== "partially_refunded") return invalid("approved, partially_refunded");
        const amount = money("amount");
        if (amount === null) return bad('amount es un string con dos decimales, p. ej. "100.00"');
        const already = parseMoney(p.refundedAmount ?? "0.00") ?? 0;
        const paid = parseMoney(p.amountPaid) ?? 0;
        const add = amount === undefined ? paid - already : (parseMoney(amount) ?? 0);
        if (add <= 0 || already + add > paid) return bad("el monto a devolver tiene que ser mayor a cero y no superar lo cobrado");
        p.refundedAmount = formatMoney(already + add);
        p.status = already + add >= paid ? "refunded" : "partially_refunded";
        return { ok: true, payment: p };
      }
      default:
        return fail(404, "unknown_action", `acción desconocida: ${action}`);
    }
  }

  /** `details` del cobro (todo opcional para Commercy): cuotas y, en un lector, los datos de la tarjeta (nunca el número). */
  private approvalDetails(p: Payment): Payment["details"] {
    const details: NonNullable<Payment["details"]> = {};
    if (p.installments) details.installments = p.installments.count;
    if (p.mode === "device") {
      details.card_last4 = "4242"; // exactamente 4 dígitos: Commercy descarta cualquier otra cosa, nunca guarda un PAN
      details.card_brand = "visa";
      details.auth_code = `A${String(++this.seq).padStart(5, "0")}`;
    }
    return Object.keys(details).length ? details : undefined;
  }
}
