/**
 * Persistencia mínima en un JSON (`.data/state.json`) para que el ejemplo sobreviva a un reinicio.
 *
 * ⚠️ Es una DEMO: escritura síncrona de un archivo entero, sin locks ni cifrado.
 * En producción guardá los envíos en tu base de datos (con un índice único por
 * `idempotency_key`) y los tokens de las instalaciones cifrados.
 */
import fs from "node:fs";
import path from "node:path";

export type ShipmentStatus = "created" | "preparing" | "shipped" | "delivered" | "canceled";

export interface Shipment {
  code: string;
  idempotencyKey: string;
  installationId: string;
  shopId: string;
  orderId: string;
  orderNumber: string | null;
  methodId: string | null;
  trackingNumber: string;
  trackingUrl: string;
  status: ShipmentStatus;
  createdAt: string;
}

export interface Installation {
  installationId: string;
  storeId: string;
  storeName: string;
  scope: string;
  accessToken: string;
  refreshToken: string;
}

interface State {
  seq: number;
  /** idempotency_key → envío */
  shipments: Record<string, Shipment>;
  installations: Record<string, Installation>;
}

const FILE = path.resolve(process.cwd(), ".data", "state.json");

function load(): State {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as State;
  } catch {
    return { seq: 0, shipments: {}, installations: {} };
  }
}

const state = load();

function save(): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export const shipments = {
  byKey: (key: string) => state.shipments[key],
  byCode: (code: string) => Object.values(state.shipments).find((s) => s.code === code),
  byTrackingNumber: (tn: string) => Object.values(state.shipments).find((s) => s.trackingNumber === tn),
  byOrder: (orderId: string) => Object.values(state.shipments).filter((s) => s.orderId === orderId),
  /** Reserva el próximo número de envío. */
  nextSeq(): number {
    state.seq += 1;
    return state.seq;
  },
  put(shipment: Shipment): void {
    state.shipments[shipment.idempotencyKey] = shipment;
    save();
  },
};

export const installations = {
  get: (id: string) => state.installations[id],
  put(inst: Installation): void {
    state.installations[inst.installationId] = inst;
    save();
  },
  remove(id: string): void {
    delete state.installations[id];
    save();
  },
};
