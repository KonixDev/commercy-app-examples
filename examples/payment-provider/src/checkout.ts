/** Página de checkout hospedada: HTML server-rendered, sin framework ni build. */
import { aggregateStatus, isExpired, type PaymentSession } from "./store.js";

const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (amount: number, currency: string): string =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency }).format(amount);

const page = (title: string, body: string): string => `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · Pagos Ejemplo</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; margin: 0; background: #f4f4f5; color: #18181b; }
    main { max-width: 440px; margin: 2rem auto; padding: 0 1rem; }
    .card { background: #fff; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 4px #0002; }
    h1 { font-size: 1.1rem; margin: 0 0 .25rem; } .brand { color: #6b7280; font-size: .85rem; margin-bottom: 1rem; }
    .total { font-size: 2rem; font-weight: 700; margin: .5rem 0 1rem; }
    ul { padding-left: 1.1rem; color: #52525b; font-size: .9rem; }
    .test { background: #fef9c3; border-radius: 8px; padding: .75rem; font-size: .85rem; margin: 1rem 0; }
    button { width: 100%; font-size: 1rem; padding: .75rem; border-radius: 8px; border: 0; cursor: pointer; margin-top: .5rem; }
    .pay { background: #16a34a; color: #fff; } .reject { background: #dc2626; color: #fff; }
    .review { background: #e4e4e7; color: #18181b; }
    .ok { color: #16a34a; } .bad { color: #dc2626; } .muted { color: #6b7280; font-size: .85rem; }
    a.back { display: block; text-align: center; margin-top: 1rem; }
    @media (prefers-color-scheme: dark) {
      body { background: #18181b; color: #f4f4f5; } .card { background: #27272a; } ul { color: #a1a1aa; }
      .test { background: #422006; } .review { background: #3f3f46; color: #f4f4f5; }
    }
  </style>
</head>
<body><main><div class="card">
  <div class="brand">Pagos Ejemplo · pasarela de prueba</div>
  ${body}
</div></main></body>
</html>`;

const summary = (s: PaymentSession): string => `
  <h1>Compra #${esc(s.orderNumber || s.orderId)}</h1>
  <div class="total">${esc(money(s.amount, s.currency))}</div>
  ${
    s.items.length
      ? `<ul>${s.items.map((i) => `<li>${esc(i.quantity)} × ${esc(i.name)}</li>`).join("")}</ul>`
      : ""
  }`;

const backLink = (s: PaymentSession, label = "Volver a la tienda"): string =>
  `<a class="back" href="${esc(s.backUrl)}">${esc(label)}</a>`;

export function renderCheckout(s: PaymentSession): string {
  const status = aggregateStatus(s);
  const action = `/pay/${esc(s.paymentId)}`;

  if (status === "approved") {
    return page("Pago aprobado", `${summary(s)}<p class="ok"><strong>Pago aprobado.</strong> Gracias por tu compra.</p>${backLink(s)}`);
  }
  if (status === "in_process") {
    return page(
      "Pago en revisión",
      `${summary(s)}<p><strong>Tu pago está en revisión.</strong> Te avisamos cuando se resuelva.</p>
       <div class="test"><strong>Simulador:</strong> resolvé la verificación del banco.
         <form method="post" action="${action}/resolve">
           <button class="pay" name="action" value="approve">Aprobar la revisión</button>
           <button class="reject" name="action" value="reject">Rechazar la revisión</button>
         </form></div>${backLink(s)}`,
    );
  }
  if (status === "cancelled") {
    return page("Compra cancelada", `${summary(s)}<p class="bad"><strong>La compra fue cancelada por el comercio.</strong></p>${backLink(s)}`);
  }
  if (isExpired(s)) {
    return page("Sesión vencida", `${summary(s)}<p class="bad"><strong>Esta sesión de pago venció.</strong> Volvé a la tienda para intentarlo de nuevo.</p>${backLink(s)}`);
  }

  return page(
    "Pagar",
    `${summary(s)}
     ${status === "rejected" ? `<p class="bad"><strong>El pago anterior fue rechazado.</strong> Podés intentar de nuevo.</p>` : ""}
     <div class="test"><strong>Tarjeta de prueba:</strong> esta pasarela es un ejemplo, no pide ni guarda datos de tarjeta reales.
       Elegí qué resultado querés simular.</div>
     <form method="post" action="${action}">
       <button class="pay" name="action" value="approve">Pagar ${esc(money(s.amount, s.currency))}</button>
       <button class="reject" name="action" value="reject">Rechazar (tarjeta de prueba)</button>
       <button class="review" name="action" value="review">Dejar en revisión (in_process)</button>
     </form>
     <p class="muted">La sesión vence el ${esc(new Date(s.expiresAt).toLocaleString("es-AR"))}.</p>
     ${backLink(s, "Cancelar y volver a la tienda")}`,
  );
}

export const renderMessage = (title: string, message: string): string =>
  page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
