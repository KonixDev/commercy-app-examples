// Banner «Hasta N cuotas sin interés de $X» para la ficha de producto.
//
// Usa sólo `window.Commercy`: el precio y la moneda llegan en el evento
// `product_viewed`, y `page_viewed` avisa cuándo salimos de la ficha para ocultarlo.
//
// Política de scripts de Commercy: todo en un closure (IIFE, lo arma esbuild), CSS en
// shadow DOM, sin leer formularios/cookies/localStorage, y sin tocar el DOM de la
// tienda salvo para insertar su propio contenedor.
//
// IMPORTANTE: el banner informa un plan de cuotas. Tiene que coincidir con lo que tu
// procesador de pagos realmente ofrece en el checkout; si no, es publicidad engañosa.

/** Lo inyecta `build.ts` (esbuild `define`) a partir de las variables de entorno. */
declare const __CONFIG__: {
  installments: number;
  minAmount: number;
  anchor: string;
  position: 'left' | 'right';
  mobileBottomOffset: number;
};

const HOST_ID = 'commercy-app-installments';

const CSS = `
:host { all: initial; }
.banner {
  box-sizing: border-box;
  font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: #0f3d24; background: #e8f5ec;
  border: 1px solid #5da97b; border-radius: 8px;
  padding: 10px 14px; margin: 8px 0;
}
.banner.fixed {
  position: fixed; z-index: 99980; margin: 0;
  ${__CONFIG__.position}: calc(16px + env(safe-area-inset-${__CONFIG__.position}, 0px));
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  max-width: min(420px, calc(100vw - 96px));
  box-shadow: 0 4px 14px rgba(0, 0, 0, .2);
}
/* Celulares: el cartel fijo deja libre la franja de abajo (barra de navegación de la tienda,
   MOBILE_BOTTOM_OFFSET) y la columna del lado opuesto (16 + 56 + 12 px) para el botón de
   WhatsApp, así no tapa controles ni se pisa con él. */
@media (max-width: 767px) {
  .banner.fixed {
    bottom: calc(${__CONFIG__.mobileBottomOffset}px + env(safe-area-inset-bottom, 0px));
    max-width: calc(100vw - 32px - 68px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
  }
}
p { margin: 0; }
strong { font-weight: 700; }
@media print { .banner.fixed { display: none; } }
`;

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency }).format(amount);
  } catch {
    // Moneda que Intl no conoce: mostramos el código tal cual.
    return `${currency} ${amount.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

/** Monto de cada cuota, redondeado al centavo. */
function installmentAmount(price: number, count: number): number {
  return Math.round((price * 100) / count) / 100;
}

function start(C: NonNullable<Window['Commercy']>): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CSS;

  const banner = document.createElement('div');
  banner.className = 'banner';
  const text = document.createElement('p');
  banner.appendChild(text);
  shadow.append(style, banner);

  // Fuera de la ficha (o con un precio que no califica) el banner directamente no está en el DOM.
  function hide(): void {
    host.remove();
  }

  function show(price: number, currency: string): void {
    const eligible = Number.isFinite(price) && price > 0 && price >= __CONFIG__.minAmount;
    if (!eligible) return hide();

    const count = __CONFIG__.installments;
    const amount = document.createElement('strong');
    // textContent: el monto nunca se interpreta como HTML.
    amount.textContent = formatMoney(installmentAmount(price, count), currency);
    text.replaceChildren(`Hasta ${count} cuotas sin interés de `, amount);

    let anchor: Element | null = null;
    try {
      anchor = __CONFIG__.anchor ? document.querySelector(__CONFIG__.anchor) : null;
    } catch {
      // Selector inválido (BANNER_ANCHOR mal escrito): cae al lugar por defecto, flotante abajo (a un costado).
    }
    banner.classList.toggle('fixed', !anchor);
    if (anchor) anchor.insertAdjacentElement('afterend', host);
    else if (host.parentNode !== document.body) document.body.appendChild(host);
  }

  C.on('product_viewed', (p) => show(p.price, p.currency));
  // En la ficha, page_viewed llega antes que product_viewed: por eso sólo ocultamos
  // cuando la página NO es de producto.
  C.on('page_viewed', (p) => {
    if (p.type !== 'product') hide();
  });
}

(function main(): void {
  const C = window.Commercy;
  if (!C || typeof C.on !== 'function') return;
  if (document.body) start(C);
  else document.addEventListener('DOMContentLoaded', () => start(C), { once: true });
})();
