# Apps de ejemplo para Commercy

[![CI](https://github.com/KonixDev/commercy-app-examples/actions/workflows/ci.yml/badge.svg)](https://github.com/KonixDev/commercy-app-examples/actions/workflows/ci.yml)

Apps de ejemplo **completas y funcionales** para la [plataforma de apps de Commercy](https://commercy.com.ar/developers), el e-commerce + punto de venta + ERP argentino. Cada carpeta de `examples/` es independiente: la copiás, completás el `.env` y la corrés.

- Portal de developers: <https://dev.commercy.com.ar>
- Documentación: <https://docs.commercy.com.ar>
- Docs para pasarle a tu IA (Claude, Codex, Cursor): <https://docs.commercy.com.ar/llms-full.txt>

Crear y probar apps es gratis, y Commercy **no cobra comisión** por las apps: si tu app es paga, le cobrás directo al comercio.

## Ejemplos

| Ejemplo | Qué muestra | Docs |
|---|---|---|
| [`sales-dashboard`](examples/sales-dashboard) | Dashboard de ventas: OAuth 2.0 con PKCE, refresh rotativo, API pública con paginación y webhooks firmados (incluidos los 4 obligatorios). | [OAuth](https://docs.commercy.com.ar/oauth) · [API](https://docs.commercy.com.ar/api-reference) |
| [`webhooks-starter`](examples/webhooks-starter) | El receptor de webhooks mínimo y correcto: firma HMAC, ventana de tiempo, deduplicación por `X-Commercy-Event-Id` y los 4 webhooks obligatorios. Punto de partida para cualquier integración. | [Webhooks](https://docs.commercy.com.ar/webhooks) |
| [`shipping-carrier`](examples/shipping-carrier) | App de envíos: cotiza en el checkout, crea y cancela envíos de forma idempotente, y empuja el seguimiento a Commercy. | [Apps de envío](https://docs.commercy.com.ar/shipping-apps) |
| [`payment-provider`](examples/payment-provider) | App de cobros: sesión de pago, checkout hospedado, webhook firmado hacia Commercy y estados `pending` / `approved` / `rejected` / `in_process`. | [Apps de pago](https://docs.commercy.com.ar/payment-apps) |
| [`whatsapp-widget-script`](examples/whatsapp-widget-script) | Script para la tienda: botón flotante de WhatsApp que arma el mensaje con el producto que mira el comprador (`window.Commercy` + eventos). | [Scripts en la tienda](https://docs.commercy.com.ar/store-scripts) |
| [`installments-banner-script`](examples/installments-banner-script) | Script para la tienda: banner «Hasta N cuotas sin interés de $X» en las fichas de producto. | [Scripts en la tienda](https://docs.commercy.com.ar/store-scripts) |

## Herramientas

| Script | Para qué |
|---|---|
| [`scripts/sri.mjs`](scripts/sri.mjs) | `node scripts/sri.mjs <archivo|URL>` calcula el hash SRI (`sha384-…`) que pide el portal para un script de tienda. Con una URL, además avisa si hay redirect, si falta CORS o si la URL no está versionada. |
| [`scripts/sign-request.mjs`](scripts/sign-request.mjs) | `node scripts/sign-request.mjs <url> <secret> '<json>'` firma un pedido igual que Commercy (`X-Commercy-Signature` + `X-Commercy-Timestamp`) y lo envía. Sirve para probar tus endpoints sin una tienda real. |

## Tests de humo

Cada ejemplo tiene un `npm run smoke` que levanta su server con un `.env` de prueba (secretos falsos, sin red hacia Commercy), le habla con requests firmados como los de Commercy y lo apaga: firma válida → 2xx, firma inválida o timestamp viejo → 401, y lo propio de cada app (idempotencia, deduplicación, estados de pago). Los dos scripts de tienda compilan y verifican que el hash SRI de `dist/` coincida con el del manifest. El CI corre typecheck, build y smoke de los seis ejemplos en Node 20.12 y 22.

Los smokes usan `scripts/` de este repo (`../../scripts/smoke`): si copiás un ejemplo solo, `npm run smoke` no está disponible, el resto funciona igual.

## Requisitos

- Node **20.12 o superior**.
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (o ngrok) para exponer tu app con HTTPS mientras desarrollás.
- Una cuenta de Commercy y el alta de developer en el [portal](https://dev.commercy.com.ar). Mientras la app está en borrador se instala en tu propia tienda o en tus tiendas demo, sin plan pago.

## Cómo empezar

```bash
git clone https://github.com/KonixDev/commercy-app-examples.git
cd commercy-app-examples/examples/sales-dashboard   # o el ejemplo que quieras
npm install
cp .env.example .env    # completalo con las credenciales de tu app
npm run dev
```

Los dos scripts de tienda no tienen `dev`: se compilan con `npm run build` y se sirven con `npm run serve`.

Cada ejemplo tiene su README con el paso a paso: qué completar en el portal, cómo exponerlo con `cloudflared` y cómo probarlo.

## Capabilities que habilita Commercy

Algunas integraciones necesitan que el equipo de Commercy habilite una capability en tu app, después de revisarla:

- **Envíos** (`shippingCarrier`) y **cobros** (`paymentCheckout`): requieren `apiBaseUrl`.
- **Scripts en la tienda** (`storefrontScripts`): requiere que los scripts declarados pasen la revisión (archivo con SRI, en tu dominio, sin redirects y con URL versionada).

Escribinos desde el portal cuando tu app esté lista para probar.

## Licencia

[MIT](LICENSE).
