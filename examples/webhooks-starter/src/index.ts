// Receptor mínimo de webhooks de Commercy. Un solo archivo, sin base de datos.
// Docs: https://docs.commercy.com.ar/webhooks.md
import "dotenv/config";
import crypto from "node:crypto";
import express from "express";

const SECRET = process.env.COMMERCY_WEBHOOK_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 3000);
const TOLERANCE_SECONDS = 300; // ventana de ±5 minutos contra replays
const DEDUPE_TTL_MS = 48 * 60 * 60 * 1000; // los reintentos duran ~44 h
const LOW_STOCK = 5;

if (!SECRET) {
  console.error("Falta COMMERCY_WEBHOOK_SECRET (copiá .env.example a .env).");
  process.exit(1);
}

interface CommercyEvent {
  id: string;
  type: string;
  created_at: string;
  store_id: string | null;
  data: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

// HMAC-SHA256(secreto, "<timestamp>.<cuerpo crudo>") en hex, con prefijo "v1=".
function verifySignature(raw: Buffer, timestamp?: string, signature?: string): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;
  const expected = "v1=" + crypto.createHmac("sha256", SECRET).update(`${timestamp}.`).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b); // tiempo constante
}

// Deduplicación por X-Commercy-Event-Id. Es entrega "al menos una vez": en producción
// guardalo en tu base (o Redis con TTL) para que sobreviva a reinicios y réplicas.
const seen = new Map<string, number>();
function alreadySeen(eventId: string): boolean {
  const now = Date.now();
  for (const [id, at] of seen) if (now - at > DEDUPE_TTL_MS) seen.delete(id);
  if (seen.has(eventId)) return true;
  seen.set(eventId, now);
  return false;
}

const handlers: Record<string, (e: CommercyEvent) => void | Promise<void>> = {
  // --- Los 4 obligatorios: se entregan siempre, sin suscribirte ---
  "app.uninstalled": (e) => {
    // Dejá de sincronizar y descartá los tokens de esta tienda.
    console.log(`[app.uninstalled] tienda ${e.store_id}, desinstalada por ${e.meta?.uninstalled_by}`);
  },
  "store.redact": (e) => {
    // 48 h después de desinstalar sin reinstalar: borrá TODOS los datos de la tienda.
    console.log(`[store.redact] borrar todos los datos de la tienda ${e.store_id}`);
  },
  "customers.redact": (e) => {
    // Borrá o anonimizá al cliente. email_hash es el SHA-256 del email en minúsculas.
    console.log(`[customers.redact] cliente ${e.data.customer_id} (email_hash ${e.data.email_hash})`);
  },
  "customers.data_request": (e) => {
    // Reuní los datos del cliente y entregáselos al comerciante.
    console.log(`[customers.data_request] cliente ${e.data.customer_id}, pedido ${e.meta?.request_id}`);
  },

  // --- De negocio: necesita el scope read_stock y la suscripción en el portal ---
  "stock.changed": (e) => {
    const { sku, available } = e.data as { sku?: string; available?: number };
    if (typeof available === "number" && available <= LOW_STOCK) {
      console.warn(`[stock.changed] stock bajo: ${sku ?? "(sin SKU)"} → ${available} disponibles`);
    } else {
      console.log(`[stock.changed] ${sku ?? "(sin SKU)"} → ${available} disponibles`);
    }
  },

  // Evento de prueba que enviás desde el portal.
  ping: (e) => console.log(`[ping] ok, app ${e.data.app_id}`),
};

async function handleEvent(event: CommercyEvent): Promise<void> {
  const handler = handlers[event.type];
  if (!handler) return console.log(`[${event.type}] sin handler, ignorado`);
  await handler(event);
}

const app = express();

// express.raw SOLO en esta ruta: necesitamos los bytes tal cual llegaron para la firma.
app.post("/webhooks/commercy", express.raw({ type: "application/json", limit: "300kb" }), (req, res) => {
  const raw = req.body;
  if (!Buffer.isBuffer(raw)) return void res.sendStatus(400);

  if (!verifySignature(raw, req.get("x-commercy-timestamp"), req.get("x-commercy-signature"))) {
    return void res.sendStatus(401);
  }

  let event: CommercyEvent;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return void res.sendStatus(400);
  }

  // Deduplicamos recién después de autenticar, para que nadie llene el Map con ids falsos.
  const eventId = req.get("x-commercy-event-id") ?? event.id;
  if (alreadySeen(eventId)) {
    console.log(`[dedupe] ${eventId} (${event.type}) ya procesado`);
    return void res.sendStatus(200);
  }

  // Respondemos 200 ya (Commercy espera máx. 5 s) y procesamos después.
  res.sendStatus(200);
  setImmediate(() => {
    handleEvent(event).catch((err) => console.error(`[error] ${event.type} ${eventId}`, err));
  });
});

app.get("/", (_req, res) => void res.send("commercy-webhooks-starter ok"));

app.listen(PORT, () => console.log(`Escuchando en http://localhost:${PORT}/webhooks/commercy`));
