// Botón flotante de WhatsApp para la tienda de un comercio.
//
// Reglas de la política de scripts de Commercy que cumple este archivo:
//  - Todo va dentro de un closure (IIFE, lo arma esbuild): no deja globales.
//  - No depende de jQuery ni del JS/CSS del tema: el CSS vive en un shadow DOM.
//  - No lee formularios, cookies ni localStorage, y no toca el DOM de la tienda
//    fuera de su propio contenedor.
//  - Si `window.Commercy` no existe (ruta excluida, vista previa), no hace nada.

/** Lo inyecta `build.ts` (esbuild `define`) a partir de las variables de entorno. */
declare const __CONFIG__: {
  number: string;
  message: string;
  messageProduct: string;
  position: 'left' | 'right';
};

const HOST_ID = 'commercy-app-whatsapp';
const LABEL = 'Escribinos por WhatsApp';

// Verde oscuro para que el ícono blanco tenga contraste >= 4.5:1 (el verde de
// marca #25D366 con blanco da apenas 2:1).
const CSS = `
:host { all: initial; }
.wrap {
  position: fixed;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  ${__CONFIG__.position}: calc(16px + env(safe-area-inset-${__CONFIG__.position}, 0px));
  z-index: 2147483000;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
a {
  display: flex; align-items: center; justify-content: center;
  width: 56px; height: 56px; box-sizing: border-box;
  border-radius: 50%;
  background: #0b6b3a; color: #fff;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .3);
  text-decoration: none;
  transition: transform .15s ease, background-color .15s ease;
}
a:hover { background: #095630; transform: scale(1.05); }
a:focus-visible { outline: 3px solid #fff; outline-offset: 0; box-shadow: 0 0 0 6px #111; }
svg { width: 30px; height: 30px; fill: currentColor; display: block; }
@media (prefers-reduced-motion: reduce) { a { transition: none; } a:hover { transform: none; } }
@media print { .wrap { display: none; } }
`;

// Ícono de teléfono (Material Design, Apache-2.0). Reemplazalo por el logo oficial si tu app cumple con la guía de marca de WhatsApp.
const ICON_PATH =
  'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z';

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(store|product)\}/g, (_, key: string) => values[key] ?? '');
}

function start(C: NonNullable<Window['Commercy']>): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CSS;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const link = document.createElement('a');
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', LABEL);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATH);
  svg.appendChild(path);

  link.appendChild(svg);
  wrap.appendChild(link);
  shadow.append(style, wrap);

  let productName: string | null = null;

  function render(): void {
    const values = { store: C.store.name, product: productName ?? '' };
    const text = fill(productName ? __CONFIG__.messageProduct : __CONFIG__.message, values);
    link.href = `https://wa.me/${__CONFIG__.number}?text=${encodeURIComponent(text)}`;
  }

  // El store reenvía el último page_viewed / product_viewed al suscribirse.
  C.on('page_viewed', (page) => {
    if (page.type !== 'product') {
      productName = null;
      render();
    }
  });
  C.on('product_viewed', (product) => {
    productName = product.name;
    render();
  });

  render();
  document.body.appendChild(host);
}

(function main(): void {
  const C = window.Commercy;
  if (!C || typeof C.on !== 'function' || !C.store) return;
  if (document.body) start(C);
  else document.addEventListener('DOMContentLoaded', () => start(C), { once: true });
})();
