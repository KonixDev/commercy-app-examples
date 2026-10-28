import crypto from "node:crypto";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { notifyCommercy, verifyCommercyRequest, type Notify } from "./commercy.js";
import { isSafeDeviceId, type AppConfig } from "./config.js";
import { Store, type CreateBody, type Payment } from "./store.js";

export interface AppOptions {
  config: AppConfig;
  /** Cómo se le avisa a Commercy. Por defecto, el aviso firmado de verdad; los tests inyectan uno propio. */
  notify?: Notify;
  log?: (...args: unknown[]) => void;
}

interface CommercyBody {
  installation_id?: string;
  [key: string]: unknown;
}
type CommercyRequest = Request & { commercy: CommercyBody };

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `payment_ref` lo genera Commercy (32 caracteres [a-z0-9]), pero se aceptan hasta 36 [A-Za-z0-9_-] para que el contrato pueda evolucionar. */
const REF_RE = /^[A-Za-z0-9_-]{1,36}$/;
const MONEY_RE = /^\d{1,10}\.\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Motivo del primer campo inválido de la creación, o `null`. */
function createProblem(b: Record<string, unknown>): string | null {
  if (!isStr(b.installation_id)) return "installation_id";
  if (!isStr(b.shop_id)) return "shop_id";
  if (!isStr(b.payment_ref) || !REF_RE.test(b.payment_ref)) return "payment_ref";
  const order = b.order;
  if (!isObj(order) || !isStr(order.id) || !isStr(order.number)) return "order { id, number }";
  if (typeof b.amount !== "string" || !MONEY_RE.test(b.amount) || Number(b.amount) <= 0) return 'amount (string con dos decimales, p. ej. "1234.50")';
  if (b.currency !== "ARS") return "currency (siempre ARS)";
  if (b.mode !== "device" && b.mode !== "qr" && b.mode !== "none") return "mode";
  if (b.mode === "device" && !isStr(b.device_id)) return "device_id (obligatorio en modo device)";
  if (b.device_id !== undefined && !isSafeDeviceId(b.device_id)) return "device_id (1 a 128 caracteres A-Z a-z 0-9 _ . : -, sin \"..\")";
  if (typeof b.expires_at !== "string" || !ISO_RE.test(b.expires_at) || Number.isNaN(Date.parse(b.expires_at))) return "expires_at (ISO-8601 con zona)";
  if (typeof b.display_title !== "string" || !b.display_title || Array.from(b.display_title).length > 20) return "display_title (1 a 20 caracteres)";
  if (b.print_ticket !== undefined && typeof b.print_ticket !== "boolean") return "print_ticket";
  if (b.installments !== undefined) {
    const i = b.installments;
    if (!isObj(i) || !Number.isInteger(i.count) || (i.count as number) < 1 || (i.count as number) > 24 || (i.cost !== "buyer" && i.cost !== "seller")) {
      return "installments { count (1 a 24), cost (buyer | seller) }";
    }
  }
  return null;
}

/** Error del contrato: `{ error: { code, message } }`. Un 4xx con código del contrato quiere decir "no se hizo nada". */
const sendError = (res: Response, httpStatus: number, code: string, message: string) =>
  void res.status(httpStatus).json({ error: { code, message } });

export function createApp({ config, notify, log = console.log }: AppOptions) {
  const store = new Store(config);
  const sendNotice: Notify = notify ?? ((payment) => notifyCommercy(config.apiBase, config.secrets[0] ?? "", payment, { log }));

  const app = express();
  app.disable("x-powered-by");

  // ── Autenticación de los requests de Commercy ────────────────────────────

  /**
   * 1. Cuerpo CRUDO (express.raw, antes de cualquier parser JSON).
   * 2. Firma en tiempo constante con el secreto vigente o el anterior, y ventana de 5 minutos.
   * 3. El installation_id del cuerpo tiene que ser el del header: la firma cubre el cuerpo, no la URL, así que el
   *    recurso viaja en el cuerpo.
   */
  function commercyAuth(req: Request, res: Response, next: NextFunction) {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!verifyCommercyRequest(raw, req.headers, config.secrets)) {
      log(`${req.path}: firma inválida o fuera de ventana`);
      return sendError(res, 401, "invalid_signature", "firma inválida o fuera de ventana");
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return sendError(res, 400, "invalid_request", "JSON inválido");
    }
    if (!isObj(body)) return sendError(res, 400, "invalid_request", "el cuerpo tiene que ser un objeto");
    if (body.installation_id !== req.headers["x-commercy-installation"]) {
      return sendError(res, 401, "invalid_installation", "installation_id no coincide con el header");
    }
    (req as CommercyRequest).commercy = body;
    next();
  }
  const rawJson = express.raw({ type: "application/json", limit: "64kb" });
  const bodyOf = (req: Request) => (req as CommercyRequest).commercy;

  // ── Commercy → esta app ──────────────────────────────────────────────────

  // Lectores de la sucursal. Un fallo acá sólo impide listar.
  app.post("/commercy/pos/devices", rawJson, commercyAuth, (req, res) => {
    const b = bodyOf(req);
    if (!isStr(b.shop_id)) return sendError(res, 400, "invalid_request", "shop_id es obligatorio");
    res.json({ devices: store.listDevices(b.installation_id as string) });
  });

  // Crear el cobro. Idempotente por payment_ref.
  app.post("/commercy/pos/payments", rawJson, commercyAuth, (req, res) => {
    const b = bodyOf(req);
    const problem = createProblem(b);
    if (problem) return sendError(res, 400, "invalid_request", `campo inválido: ${problem}`);

    const out = store.create(b as unknown as CreateBody);
    if (!out.ok) return sendError(res, out.httpStatus, out.code, out.message);
    res.json(createResponse(out.payment));
  });

  // Estado del cobro. Se resuelve sólo por payment_ref: payment_id es opcional.
  app.post("/commercy/pos/payments/status", rawJson, commercyAuth, (req, res) => {
    const p = lookup(req, res);
    if (p) res.json(statusResponse(p));
  });

  // Cancelar el INTENTO de cobro (no la venta). Idempotente por cancel_ref.
  app.post("/commercy/pos/payments/cancel", rawJson, commercyAuth, (req, res) => {
    const b = bodyOf(req);
    if (typeof b.cancel_ref !== "string" || !REF_RE.test(b.cancel_ref)) {
      return sendError(res, 400, "invalid_request", "cancel_ref (hasta 36 caracteres [A-Za-z0-9_-])");
    }
    const p = lookup(req, res);
    if (p) res.json({ result: store.cancel(p, b.cancel_ref) });
  });

  /**
   * Busca el cobro de un `status` o `cancel`. Si no lo conocés, 404 `payment_not_found`, y desde ese momento el
   * `payment_ref` queda consumido (crearlo da `payment_ref_consumed`). Siempre HTTP 404: con otro status Commercy no
   * lo toma como "no existe".
   */
  function lookup(req: Request, res: Response): Payment | null {
    const b = bodyOf(req);
    if (!isStr(b.shop_id)) {
      sendError(res, 400, "invalid_request", "shop_id es obligatorio");
      return null;
    }
    if (!isStr(b.payment_ref) || !REF_RE.test(b.payment_ref)) {
      sendError(res, 400, "invalid_request", "payment_ref inválido");
      return null;
    }
    const p = store.find(b.installation_id as string, b.payment_ref);
    if (!p) {
      sendError(res, 404, "payment_not_found", "no conozco ese cobro");
      return null;
    }
    return p;
  }

  function createResponse(p: Payment) {
    return {
      payment_id: p.paymentId,
      status: p.status, // Commercy NO lo aplica: el estado lo verifica con `status`
      expires_at: p.expiresAt, // el vencimiento REAL
      ...(p.display ? { display: p.display } : {}),
    };
  }

  function statusResponse(p: Payment) {
    return {
      payment_id: p.paymentId,
      payment_ref: p.paymentRef,
      status: p.status,
      amount_requested: p.amount,
      amount_paid: p.amountPaid, // BRUTO: con recargo y propina, antes de las comisiones
      ...(p.amountExtra ? { amount_extra: p.amountExtra } : {}),
      ...(p.refundedAmount !== undefined ? { refunded_amount: p.refundedAmount } : {}),
      currency: "ARS",
      ...(p.errorCode ? { error: { code: p.errorCode, message: p.errorCode } } : {}),
      ...(p.details ? { details: p.details } : {}),
      expires_at: p.expiresAt,
    };
  }

  // ── Simulador del procesador (/admin) ────────────────────────────────────
  //
  // En producción esto es tu procesador: el cliente paga en el lector o escanea el QR y vos te enterás. Acá no hay
  // procesador, así que alguien lo hace "desde afuera" con un token. Sin ADMIN_TOKEN está apagado (404).

  const admin = express.Router();
  admin.use((req, res, next) => {
    if (!config.adminToken) return void res.status(404).json({ error: "simulador apagado: definí ADMIN_TOKEN" });
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    // Se comparan los hashes: mismo largo siempre y tiempo constante.
    const digest = (s: string) => crypto.createHash("sha256").update(s).digest();
    if (!crypto.timingSafeEqual(digest(given), digest(config.adminToken))) return void res.status(401).json({ error: "token inválido" });
    next();
  });
  admin.use(express.json({ limit: "16kb" }));

  const view = (p: Payment) => ({
    ...statusResponse(p),
    installation_id: p.installationId,
    shop_id: p.shopId,
    mode: p.mode,
    ...(p.deviceId ? { device_id: p.deviceId } : {}),
    ...(p.installments ? { installments: p.installments } : {}),
    ...(p.display ? { display: p.display } : {}),
  });

  admin.get("/payments", (_req, res) => void res.json({ payments: store.all().map(view), consumed: store.consumedRefs() }));

  admin.get("/payments/:ref", (req, res) => {
    const p = store.get(req.params.ref);
    if (!p) return void res.status(404).json({ error: "payment_ref desconocido" });
    res.json({ payment: view(p) });
  });

  // approve | reject | partial | in-process | expire | cancel-done | refund. Después de cambiar el estado avisa a
  // Commercy (`pos_payment.updated`); con { "notify": false } no.
  admin.post("/payments/:ref/:action", async (req, res) => {
    const p = store.get(req.params.ref);
    if (!p) return void res.status(404).json({ error: "payment_ref desconocido" });
    const input: Record<string, unknown> = isObj(req.body) ? req.body : {};
    const out = store.transition(p, req.params.action, input);
    if (!out.ok) return void res.status(out.httpStatus).json({ error: { code: out.code, message: out.message } });
    const webhook = input.notify === false ? null : await sendNotice({ installationId: p.installationId, paymentId: p.paymentId, paymentRef: p.paymentRef });
    res.json({ payment: view(p), webhook });
  });

  // Estado de conexión de un lector: { "status": "online" | "offline" | "busy" | "unknown", "label"?: "Caja 3", "installation_id"?: "..." }.
  // Con `installation_id` crea el lector de esa instalación si no existe; sin él cambia el que ya existe con ese id, en todas.
  admin.post("/devices/:id", (req, res) => {
    if (!isSafeDeviceId(req.params.id)) return void res.status(400).json({ error: "id de lector inválido: 1 a 128 caracteres A-Z a-z 0-9 _ . : -, sin \"..\"" });
    const status = isObj(req.body) ? req.body.status : undefined;
    if (status !== "online" && status !== "offline" && status !== "busy" && status !== "unknown") {
      return void res.status(400).json({ error: "status: online | offline | busy | unknown" });
    }
    const label = isObj(req.body) && typeof req.body.label === "string" ? req.body.label : undefined;
    const installation = isObj(req.body) && isStr(req.body.installation_id) ? req.body.installation_id : undefined;
    if (!store.setDevice(req.params.id, status, label, installation)) {
      return void res.status(404).json({ error: "lector desconocido: pasá installation_id para crearlo en esa instalación" });
    }
    res.json({ devices: store.listDevices(installation ?? "") });
  });

  app.use("/admin", admin);

  app.get("/health", (_req, res) => void res.json({ ok: true }));

  // Cualquier otra cosa: 404 propio.
  app.use((_req, res) => void res.status(404).json({ error: { code: "not_found", message: "ruta desconocida" } }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) return sendError(res, status, "invalid_request", "request inválido");
    log("error inesperado", err);
    sendError(res, 500, "internal_error", "error interno");
  });

  return { app, store };
}
