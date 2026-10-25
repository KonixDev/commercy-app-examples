/**
 * Dashboard de ventas server-rendered: la funcionalidad de la app de ejemplo.
 *
 * Trae ventas, productos y stock por la API pública de Commercy y los resume en
 * un panel: ventas del día, últimos 7 días, top productos, alertas de stock bajo
 * y el feed de webhooks recibidos en vivo.
 *
 * Todo server-rendered (sin framework ni build): la página se arma con
 * template literals y se auto-refresca con un <meta refresh>.
 */
import type { CommercyClient } from "./commercy.js";

// ── Tipos del dominio (sólo lo que la app usa) ──────────────────────────────

export interface OrderLineItem {
  product_id?: string;
  variant_id?: string | null;
  sku?: string | null;
  name: string;
  quantity: number;
  unit_price: number;
  total: number;
  is_custom?: boolean;
}

export interface Order {
  id: string;
  order_number: string;
  status: string;
  shop_id: string;
  total: number;
  discount?: number;
  currency: string;
  line_items: OrderLineItem[];
  created_at: string;
  updated_at: string;
}

export interface StockRow {
  shop_id: string;
  product_id: string;
  variant_id?: string | null;
  sku: string | null;
  on_hand: number;
  available: number;
}

export interface ProductSummary {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  is_active: boolean;
}

export interface WebhookEvent {
  id: string;
  type: string;
  storeId: string | null;
  receivedAt: string;
}

// ── Feed de webhooks en vivo ────────────────────────────────────────────────

const EVENT_FEED_MAX = 30;

export class EventFeed {
  private events: WebhookEvent[] = [];
  private counts = new Map<string, number>();

  add(event: Pick<WebhookEvent, "id" | "type" | "storeId">): void {
    // Llega ya deduplicado (el router no nos pasa duplicados).
    this.events.unshift({ ...event, receivedAt: new Date().toISOString() });
    if (this.events.length > EVENT_FEED_MAX) this.events.length = EVENT_FEED_MAX;
    this.counts.set(event.type, (this.counts.get(event.type) ?? 0) + 1);
  }

  recent(): WebhookEvent[] {
    return this.events;
  }

  byType(): { type: string; count: number }[] {
    return [...this.counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }
}

// ── Métricas ────────────────────────────────────────────────────────────────

export interface DayBucket {
  /** YYYY-MM-DD en hora local. */
  day: string;
  label: string;
  total: number;
  orders: number;
}

export interface DashboardData {
  storeName: string;
  currency: string;
  generatedAt: string;
  today: DayBucket;
  week: DayBucket[];
  weekTotal: number;
  weekOrders: number;
  avgTicket: number;
  topProducts: { name: string; units: number; revenue: number }[];
  lowStock: { sku: string | null; productId: string; available: number; onHand: number }[];
  activeProducts: number;
  totalProducts: number;
  pendingOrders: number;
  events: WebhookEvent[];
  eventCounts: { type: string; count: number }[];
  stale: boolean;
}

const LOW_STOCK_THRESHOLD = 5;
/** Cuántas páginas de 50 órdenes traemos como máximo para el rango de 7 días. */
const MAX_ORDER_PAGES = 6;
/** Los resultados se cachean este tiempo para no golpear la API en cada refresh. */
const CACHE_MS = 60_000;

const dayKey = (d: Date): string => {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const DAY_LABELS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

function lastNDays(n: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push({ key: dayKey(d), label: i === 0 ? "hoy" : (DAY_LABELS[d.getDay()] ?? "") });
  }
  return out;
}

async function fetchOrdersPage(
  client: CommercyClient,
  query: { created_since?: string; cursor?: string; limit?: string },
): Promise<{ orders: Order[]; next: string | null }> {
  const res = (await client.orders(query)) as { data: Order[]; next_cursor: string | null };
  return { orders: res.data ?? [], next: res.next_cursor };
}

/**
 * Trae las órdenes de los últimos 7 días paginando por cursor.
 * La API ordena por fecha de modificación ascendente; para la demo, un tope de
 * páginas es suficiente y mantiene la app dentro de los rate limits.
 */
async function fetchRecentOrders(client: CommercyClient, sinceIso: string): Promise<Order[]> {
  const orders: Order[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    const { orders: batch, next } = await fetchOrdersPage(
      client,
      cursor ? { created_since: sinceIso, cursor, limit: "50" } : { created_since: sinceIso, limit: "50" },
    );
    orders.push(...batch);
    if (!next) break;
    cursor = next;
  }
  return orders;
}

async function fetchStock(client: CommercyClient, shopId: string): Promise<StockRow[]> {
  const rows: StockRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 3; page++) {
    const res = (await client.stock({
      shop: shopId,
      ...(cursor ? { cursor } : {}),
      limit: "100",
    })) as { data: StockRow[]; next_cursor: string | null };
    rows.push(...(res.data ?? []));
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return rows;
}

export class DashboardService {
  private cache: { at: number; data: DashboardData } | null = null;
  private inflight: Promise<DashboardData> | null = null;

  constructor(private feed: EventFeed) {}

  /** Invalidá el cache cuando llega un webhook relevante, para que el panel reaccione rápido. */
  invalidate(): void {
    this.cache = null;
  }

  async get(
    client: CommercyClient,
    store: { name: string; currency: string },
    opts: { force?: boolean } = {},
  ): Promise<DashboardData> {
    if (!opts.force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.data;
    if (this.inflight) return this.inflight;

    this.inflight = this.build(client, store)
      .then((data) => {
        this.cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async build(client: CommercyClient, store: { name: string; currency: string }): Promise<DashboardData> {
    const days = lastNDays(7);
    const weekStart = new Date(
      new Date(days[0]!.key + "T00:00:00").getTime() - new Date().getTimezoneOffset() * 60_000,
    ).toISOString();

    const [orders, productsRes, storeRes] = await Promise.all([
      fetchRecentOrders(client, weekStart),
      client.products({ limit: "100" }) as Promise<{ data: ProductSummary[] }>,
      client.store(),
    ]);

    const shops = (storeRes.data.shops ?? []) as { id: string; name: string }[];
    const stockRows = shops.length ? await fetchStock(client, shops[0]!.id) : [];

    // Buckets por día (sólo ventas no canceladas; el status exacto depende del flujo de la tienda).
    const buckets = new Map<string, DayBucket>();
    for (const d of days) buckets.set(d.key, { day: d.key, label: d.label, total: 0, orders: 0 });

    const productUnits = new Map<string, { name: string; units: number; revenue: number }>();
    let pending = 0;

    for (const order of orders) {
      if (order.status === "cancelled" || order.status === "rejected" || order.status === "returned") continue;
      if (order.status === "pending") pending += 1;

      const key = dayKey(new Date(order.created_at));
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.total += order.total ?? 0;
        bucket.orders += 1;
      }

      for (const line of order.line_items ?? []) {
        const name = line.is_custom ? `${line.name} (personalizado)` : line.name;
        const acc = productUnits.get(name) ?? { name, units: 0, revenue: 0 };
        acc.units += line.quantity ?? 0;
        acc.revenue += line.total ?? 0;
        productUnits.set(name, acc);
      }
    }

    const week = days.map((d) => buckets.get(d.key)!);
    const today = week[week.length - 1] ?? { day: "", label: "hoy", total: 0, orders: 0 };
    const weekTotal = week.reduce((acc, b) => acc + b.total, 0);
    const weekOrders = week.reduce((acc, b) => acc + b.orders, 0);

    const topProducts = [...productUnits.values()].sort((a, b) => b.units - a.units).slice(0, 5);

    const lowStock = stockRows
      .filter((r) => r.available <= LOW_STOCK_THRESHOLD)
      .sort((a, b) => a.available - b.available)
      .slice(0, 8)
      .map((r) => ({ sku: r.sku ?? null, productId: r.product_id, available: r.available, onHand: r.on_hand }));

    const productData = productsRes.data ?? [];

    return {
      storeName: store.name,
      currency: store.currency,
      generatedAt: new Date().toISOString(),
      today,
      week,
      weekTotal,
      weekOrders,
      avgTicket: weekOrders > 0 ? Math.round(weekTotal / weekOrders) : 0,
      topProducts,
      lowStock,
      activeProducts: productData.filter((p) => p.is_active).length,
      totalProducts: productData.length,
      pendingOrders: pending,
      events: this.feed.recent(),
      eventCounts: this.feed.byType(),
      stale: false,
    };
  }
}

// ── Render HTML ─────────────────────────────────────────────────────────────

const esc = (s: unknown): string =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const money = (n: number, currency: string): string =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency, maximumFractionDigits: 0 }).format(n || 0);

const timeAgo = (iso: string): string => {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `hace ${secs}s`;
  if (secs < 3600) return `hace ${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `hace ${Math.floor(secs / 3600)}h`;
  return new Date(iso).toLocaleDateString("es-AR");
};

const EVENT_COLORS: Record<string, string> = {
  "order.created": "#22c55e",
  "order.paid": "#16a34a",
  "order.updated": "#3b82f6",
  "order.cancelled": "#ef4444",
  "product.created": "#a855f7",
  "product.updated": "#8b5cf6",
  "product.deleted": "#f97316",
  "stock.changed": "#eab308",
  "customer.created": "#06b6d4",
  "customer.updated": "#0891b2",
};

function kpi(label: string, value: string, sub = ""): string {
  return `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div>${
    sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""
  }</div>`;
}

export function renderDashboard(data: DashboardData): string {
  const maxDay = Math.max(...data.week.map((b) => b.total), 1);
  const bars = data.week
    .map((b) => {
      const h = Math.max(4, Math.round((b.total / maxDay) * 120));
      return `<div class="bar-wrap"><div class="bar" style="height:${h}px" title="${esc(money(b.total, data.currency))} en ${b.orders} ventas"></div><span class="bar-label${b.label === "hoy" ? " today" : ""}">${esc(b.label)}</span></div>`;
    })
    .join("");

  const topRows =
    data.topProducts.length === 0
      ? `<tr><td colspan="3" class="empty">Sin ventas en los últimos 7 días.</td></tr>`
      : data.topProducts
          .map(
            (p, i) =>
              `<tr><td class="rank">${i + 1}</td><td>${esc(p.name)}</td><td class="num">${p.units} u</td><td class="num">${esc(money(p.revenue, data.currency))}</td></tr>`,
          )
          .join("");

  const stockRows =
    data.lowStock.length === 0
      ? `<tr><td colspan="3" class="empty">Todo el stock está sano 🎉</td></tr>`
      : data.lowStock
          .map(
            (r) =>
              `<tr><td>${esc(r.sku ?? r.productId)}</td><td class="num">${r.available}</td><td class="num">${r.onHand}</td></tr>`,
          )
          .join("");

  const events =
    data.events.length === 0
      ? `<div class="empty">Todavía no llegó ningún webhook. Editá un producto o generá una venta en la tienda.</div>`
      : data.events
          .slice(0, 12)
          .map((e) => {
            const color = EVENT_COLORS[e.type] ?? "#6b7280";
            return `<div class="event"><span class="dot" style="background:${color}"></span><span class="event-type">${esc(e.type)}</span><span class="event-time">${esc(timeAgo(e.receivedAt))}</span></div>`;
          })
          .join("");

  const eventCounts =
    data.eventCounts.length === 0
      ? ""
      : data.eventCounts
          .map((c) => `<span class="chip">${esc(c.type)} · ${c.count}</span>`)
          .join("");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${esc(data.storeName)} · Commercy demo</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #f6f7f9; color: #111827; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 20px; margin: 0; }
  .meta { color: #6b7280; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 20px 0; }
  .kpi { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 16px; }
  .kpi-label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; }
  .kpi-value { font-size: 24px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .kpi-sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: 14px; margin: 0 0 12px; color: #374151; }
  .chart { display: flex; align-items: flex-end; gap: 10px; height: 150px; }
  .bar-wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; flex: 1; height: 100%; justify-content: flex-end; }
  .bar { width: 100%; max-width: 48px; background: #2563eb; border-radius: 6px 6px 2px 2px; }
  .bar-label { font-size: 11px; color: #6b7280; }
  .bar-label.today { font-weight: 700; color: #2563eb; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: #6b7280; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 8px; border-bottom: 1px solid #f3f4f6; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.rank { color: #9ca3af; width: 24px; }
  .empty { color: #9ca3af; font-style: italic; }
  .event { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f3f4f6; font-size: 13px; }
  .event:last-child { border-bottom: none; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .event-type { font-weight: 600; }
  .event-time { margin-left: auto; color: #9ca3af; }
  .chip { display: inline-block; background: #f3f4f6; border-radius: 999px; padding: 3px 10px; font-size: 12px; margin: 0 6px 6px 0; }
  .warn { color: #b45309; }
  footer { margin-top: 24px; color: #9ca3af; font-size: 12px; text-align: center; }
  footer a { color: inherit; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0f17; color: #e5e7eb; }
    .kpi, .card { background: #111827; border-color: #1f2937; }
    .card h2 { color: #9ca3af; }
    th, td { border-color: #1f2937; }
    td { border-color: #111827; }
    .chip { background: #1f2937; }
    .bar { background: #60a5fa; }
    .bar-label.today { color: #60a5fa; }
    .event { border-color: #1f2937; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>📊 ${esc(data.storeName)}</h1>
    <span class="meta">Actualizado ${esc(timeAgo(data.generatedAt))} · se refresca solo cada 60 s</span>
  </header>

  <div class="grid">
    ${kpi("Ventas de hoy", money(data.today.total, data.currency), `${data.today.orders} ventas`)}
    ${kpi("Últimos 7 días", money(data.weekTotal, data.currency), `${data.weekOrders} ventas`)}
    ${kpi("Ticket promedio", money(data.avgTicket, data.currency), "7 días")}
    ${kpi("Pendientes", `${data.pendingOrders}`, "ventas por confirmar")}
    ${kpi("Productos activos", `${data.activeProducts}`, `de ${data.totalProducts} totales`)}
    ${kpi("Stock bajo", `${data.lowStock.length}`, `≤ ${LOW_STOCK_THRESHOLD} unidades`)}
  </div>

  <div class="card">
    <h2>Ventas por día (7 días)</h2>
    <div class="chart">${bars}</div>
  </div>

  <div class="card">
    <h2>Top productos (unidades vendidas, 7 días)</h2>
    <table>
      <thead><tr><th></th><th>Producto</th><th style="text-align:right">Unidades</th><th style="text-align:right">Facturado</th></tr></thead>
      <tbody>${topRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>⚠️ Stock bajo (sucursal principal)</h2>
    <table>
      <thead><tr><th>SKU</th><th style="text-align:right">Disponible</th><th style="text-align:right">Físico</th></tr></thead>
      <tbody>${stockRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>⚡ Webhooks en vivo</h2>
    <div>${eventCounts || ""}</div>
    <div>${events}</div>
  </div>

  <footer>
    App de ejemplo de la <a href="https://docs.commercy.com.ar">API de Commercy</a> ·
    OAuth PKCE + API pública + webhooks firmados · <a href="/install">reinstalar</a>
  </footer>
</div>
</body>
</html>`;
}
