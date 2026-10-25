/**
 * Persistencia del ejemplo: memoria + un JSON en disco (se reescribe entero en cada cambio).
 * En producción esto es una base de datos (con índices únicos en `key` y `paymentId`) y los
 * webhooks pendientes van a una cola con reintentos, no a un setTimeout en el proceso.
 */
import fs from "node:fs";
import path from "node:path";

export type AttemptStatus = "approved" | "rejected" | "in_process";
export type PaymentStatus = "pending" | "in_process" | "approved" | "rejected" | "cancelled";

export interface Attempt {
  status: AttemptStatus;
  at: string;
}

export interface PaymentSession {
  paymentId: string;
  /** `${installation_id}:${idempotency_key}`: dos requests iguales devuelven la misma sesión. */
  key: string;
  installationId: string;
  shopId: string;
  orderId: string;
  orderNumber: string;
  amount: number;
  currency: string;
  items: { name: string; quantity: number; unit_price: number }[];
  backUrl: string;
  expiresAt: string;
  /** El comercio canceló la venta (order.cancelled): no se aceptan más intentos. */
  cancelled: boolean;
  attempts: Attempt[];
  createdAt: string;
}

export interface StoredInstallation {
  installationId: string;
  storeId: string;
  storeName: string;
  scope: string;
  status: "active" | "uninstalled";
  createdAt: string;
}

interface Snapshot {
  sessions: PaymentSession[];
  installations: StoredInstallation[];
  seenEventIds: string[];
}

const MAX_SEEN_EVENTS = 1000;

export class Store {
  private sessions = new Map<string, PaymentSession>();
  private byKey = new Map<string, string>();
  private installations = new Map<string, StoredInstallation>();
  private seenEventIds: string[] = [];

  constructor(private readonly file: string) {
    try {
      const snap = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
      for (const s of snap.sessions) this.index(s);
      for (const i of snap.installations) this.installations.set(i.installationId, i);
      this.seenEventIds = snap.seenEventIds ?? [];
    } catch {
      // Primer arranque o archivo ilegible: se empieza vacío.
    }
  }

  private index(s: PaymentSession) {
    this.sessions.set(s.paymentId, s);
    this.byKey.set(s.key, s.paymentId);
  }

  /** Escritura atómica (tmp + rename) para no dejar un JSON a medias si el proceso muere. */
  save() {
    const snap: Snapshot = {
      sessions: [...this.sessions.values()],
      installations: [...this.installations.values()],
      seenEventIds: this.seenEventIds,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
    fs.renameSync(tmp, this.file);
  }

  getByKey(key: string) {
    const id = this.byKey.get(key);
    return id ? this.sessions.get(id) : undefined;
  }

  get(paymentId: string) {
    return this.sessions.get(paymentId);
  }

  findByOrder(orderId: string) {
    return [...this.sessions.values()].filter((s) => s.orderId === orderId);
  }

  add(session: PaymentSession) {
    this.index(session);
    this.save();
  }

  getInstallation(id: string) {
    return this.installations.get(id);
  }

  putInstallation(installation: StoredInstallation) {
    this.installations.set(installation.installationId, installation);
    this.save();
  }

  /** store.redact: borra todo lo del comercio. */
  deleteInstallationData(installationId: string) {
    this.installations.delete(installationId);
    for (const s of [...this.sessions.values()]) {
      if (s.installationId !== installationId) continue;
      this.sessions.delete(s.paymentId);
      this.byKey.delete(s.key);
    }
    this.save();
  }

  /** true si el evento ya se procesó (Commercy entrega al menos una vez). */
  markEventSeen(eventId: string): boolean {
    if (this.seenEventIds.includes(eventId)) return true;
    this.seenEventIds.push(eventId);
    if (this.seenEventIds.length > MAX_SEEN_EVENTS) this.seenEventIds.shift();
    this.save();
    return false;
  }
}

/**
 * Estado AGREGADO de la sesión (lo que devuelve /status):
 * `approved` si algún intento se aprobó; `in_process` si alguno está en curso;
 * `rejected` sólo si hubo intentos y ninguno está aprobado ni en curso.
 */
export function aggregateStatus(s: PaymentSession): PaymentStatus {
  const statuses = s.attempts.map((a) => a.status);
  if (statuses.includes("approved")) return "approved";
  if (statuses.includes("in_process")) return "in_process";
  if (s.cancelled) return "cancelled";
  return statuses.includes("rejected") ? "rejected" : "pending";
}

export const isExpired = (s: PaymentSession, now = Date.now()): boolean =>
  now > new Date(s.expiresAt).getTime();
