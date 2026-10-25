# Botón de WhatsApp para la tienda · script de ejemplo

Script de tienda **completo y funcional** para la plataforma de apps de Commercy:
agrega un botón flotante de WhatsApp a las páginas públicas de la tienda del
comercio. Es el ejemplo más chico del contrato de [scripts en la tienda](https://docs.commercy.com.ar/store-scripts.md):
declaración, SRI, URL versionada, CORS y `window.Commercy`.

## Qué hace

- Muestra un botón redondo (esquina inferior derecha o izquierda) que abre
  `https://wa.me/<número>?text=<mensaje>` en una pestaña nueva.
- El mensaje sale de `window.Commercy`: usa el **nombre de la tienda**
  (`Commercy.store.name`) y, si el visitante está mirando un producto, el
  **nombre del producto** (evento `product_viewed`). Al salir de la ficha vuelve
  al mensaje general (evento `page_viewed`).
- Número, textos y lado de la pantalla se **configuran al compilar**: quedan
  "horneados" en el archivo.

Ejemplos del mensaje en una tienda llamada «Casa Lola»:

| Dónde está el visitante | Mensaje |
| - | - |
| Inicio, catálogo, carrito | `Hola Casa Lola! Quería hacerles una consulta.` |
| Ficha de «Zapatillas Urbanas» | `Hola Casa Lola! Quería consultar por Zapatillas Urbanas.` |

## Cómo se ve

Un círculo verde oscuro de 56 px con un ícono de teléfono blanco, fijo en la
esquina inferior derecha. Para ver cómo queda sin una tienda, corré el ejemplo
y abrí la página de prueba (ver «Probarlo en local»).

### Accesibilidad y convivencia con la tienda

- **Nombre accesible**: `aria-label="Escribinos por WhatsApp"`; el ícono es
  `aria-hidden`.
- **Teclado y foco**: es un `<a>` real, se alcanza con `Tab` y muestra un anillo
  de foco doble (blanco + negro) visible sobre cualquier fondo.
- **Contraste**: ícono blanco sobre `#0b6b3a` = 6,6:1 (el verde de marca
  `#25D366` con blanco da ~2:1 y no pasa WCAG).
- **Target táctil** de 56 px, respeta `safe-area-inset` en iPhone, el movimiento
  reducido (`prefers-reduced-motion`) y no se imprime.
- **Sin choques**: todo vive en un **shadow DOM** dentro de un único contenedor
  `#commercy-app-whatsapp`. El CSS de la tienda no lo afecta y el nuestro no se
  filtra. No depende de jQuery ni del tema, y el código va en un closure (IIFE).
- **Seguro**: el nombre del producto entra con `encodeURIComponent` y nunca se
  interpreta como HTML. Si `window.Commercy` no existe, el script no hace nada.

## Requisitos

- Node 20.12+ (usa `process.loadEnvFile`) y npm.
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  (o ngrok) para probarlo en tu tienda de desarrollo.
- Una app en el portal de developers de Commercy con
  el scope `storefront_scripts` (ver más abajo).

## Estructura

```text
src/widget.ts        el script (TypeScript, se compila a un solo .js)
src/commercy.d.ts    tipos de window.Commercy
build.ts             compila con esbuild, calcula el SRI y arma el bloque JSON
server.ts            sirve dist/ con CORS y caché inmutable (para probar con un túnel)
test.html            tienda falsa con window.Commercy para desarrollar sin Commercy
dist/                salida: whatsapp-widget.v<version>.js + manifest.json
```

## Compilar

```bash
npm install
cp .env.example .env     # completá tu número
npm run build
```

| Variable | Qué es |
| - | - |
| `WHATSAPP_NUMBER` | Número en formato internacional, sólo dígitos, sin `+` (ej. `5491112345678`). |
| `WHATSAPP_MESSAGE` | Mensaje general. `{store}` = nombre de la tienda. |
| `WHATSAPP_MESSAGE_PRODUCT` | Mensaje en la ficha de producto. `{store}` y `{product}`. |
| `WIDGET_POSITION` | `right` (por defecto) o `left`. |
| `SCRIPT_BASE_URL` | URL pública donde servís `dist/`. Sólo se usa para armar el bloque JSON. |

`npm run build` genera `dist/whatsapp-widget.v<version>.js` (la versión sale del
`package.json`) y muestra algo así:

```text
OK  dist/whatsapp-widget.v1.0.0.js  (2.5 KB)
SRI sha384-qbJYD4q0Qx+TEo6J0DHGLzuSGgzRk8yXmTzViCPlL8sPteQg7ewBEPfNcfHf3SqW

{
  "handle": "whatsapp-widget",
  "name": "Botón de WhatsApp",
  "src": "https://cdn.tuapp.com/whatsapp-widget.v1.0.0.js",
  "integrity": "sha384-qbJYD4q0Qx+TEo6J0DHGLzuSGgzRk8yXmTzViCPlL8sPteQg7ewBEPfNcfHf3SqW",
  "loading": "interaction",
  "consent": "necessary"
}
```

(El hash depende de tu configuración: con otro número vas a ver otro.)

## Servirlo

```bash
npm run serve                                   # terminal 1: http://localhost:8787
cloudflared tunnel --url http://localhost:8787  # terminal 2: https://algo.trycloudflare.com
```

`server.ts` responde cada archivo con lo que exige Commercy: `200` directo **sin
redirects**, `Access-Control-Allow-Origin: *`, `Content-Type: text/javascript` y
`Cache-Control: public, max-age=31536000, immutable`.

Verificá el archivo servido con el script del repo, que calcula el hash y
chequea redirects y CORS:

```bash
node ../../scripts/sri.mjs https://algo.trycloudflare.com/whatsapp-widget.v1.0.0.js
```

El hash tiene que coincidir con el que imprimió el build. Si falta CORS, hay un
redirect o la URL no parece versionada, avisa y sale con código 1.

## Probarlo en local (sin tienda)

Con `npm run serve` andando, abrí <http://localhost:8787/test.html>. Es una
tienda falsa que define un `window.Commercy` **congelado** con la forma
documentada, emite los eventos (`page_viewed`, `product_viewed`) con los botones
de la página y carga tu script como lo hace el loader real: con `integrity` y
`crossorigin="anonymous"`, después de la primera interacción (un scroll alcanza).
Si el hash no coincide, el navegador lo bloquea y lo ves en el log.
`?commercy=0` prueba la página sin `window.Commercy`.

## Declararlo en el portal

1. En tu app, **Scopes** → pedí `storefront_scripts`.
2. **Scripts** → agregá una fila con los valores del bloque que imprimió el build:

   | Campo | Valor |
   | - | - |
   | `handle` | `whatsapp-widget` |
   | `name` | `Botón de WhatsApp` (lo ve el comercio) |
   | `src` | `https://cdn.tuapp.com/whatsapp-widget.v1.0.0.js` (https, mismo dominio que tu `appUrl`) |
   | `integrity` | el `sha384-...` del build (o el botón **Calcular hash** del portal) |
   | `loading` | `interaction`: se carga tras el primer toque o scroll y no pesa en el Lighthouse |
   | `consent` | `necessary`: sin él no anda el botón que el comercio instaló, y no hace perfilado |

   También se puede por API, dentro de `storefrontScripts` en
   `PATCH /api/v1/developers/apps/:id`.
3. Pedile a soporte que habilite los scripts en tu app (en borrador).

## Probarlo en una tienda de desarrollo

Mientras tu app está en borrador los scripts sólo corren en tu **tienda de
desarrollo** y en tus **tiendas demo**.

1. Instalá la app en esa tienda aceptando el scope «Agregar código a tu tienda online».
2. Con el túnel andando, poné la URL del túnel en `SCRIPT_BASE_URL`, corré
   `npm run build` y copiá `src` e `integrity` al portal. En borrador también
   podés usar `http://localhost:8787/...` como `src`.
3. Abrí la tienda, hacé scroll y mirá la consola. Si algo falla el navegador lo
   bloquea y la tienda avisa: `[Commercy] No se pudo cargar el script "whatsapp-widget"…`
   (hash que no coincide, falta CORS o hay un redirect).

El botón **no** aparece en `/checkout`, `/cuenta`, `/login`, `/registro`, la vista
previa del editor ni en las demás rutas excluidas: ahí `window.Commercy` no existe.

## Publicar una versión nueva

El hash está atado al contenido, así que **nunca pises el archivo en la misma URL**
(todas las tiendas dejarían de cargarlo hasta que apruebe la revisión). `npm run build`
te avisa si el archivo de esa versión ya existía con otro contenido.

1. Subí `version` en `package.json` (por ejemplo a `1.1.0`).
2. `npm run build`: genera `whatsapp-widget.v1.1.0.js` y su hash. **El v1.0.0 queda donde está.**
3. Publicá el archivo nuevo y dejá **vivo el viejo**: las tiendas siguen cargándolo
   hasta que se apruebe el cambio.
4. En el portal cambiá `src` e `integrity`. Si tu app está publicada, el cambio pasa
   por revisión y se aplica al aprobarlo.
5. Con el cambio aprobado y unos minutos de margen, retirá el archivo viejo.

Cambiar el número, el mensaje o el lado también es una versión nueva: la
configuración está dentro del archivo.

## Checklist para la revisión

- [ ] El `integrity` coincide con el archivo servido (`node ../../scripts/sri.mjs <URL>`).
- [ ] Responde `200` directo: **sin redirects**.
- [ ] Lleva `Access-Control-Allow-Origin: *` y `Content-Type: text/javascript`.
- [ ] La URL es **versionada** y el contenido de esa URL no cambia nunca.
- [ ] `https`, y en el mismo dominio registrable que el `appUrl` de tu app.
- [ ] `loading: interaction` (si usás `idle`, justificá por qué).
- [ ] Sin datos personales: no lee formularios, cookies ni `localStorage`, y no manda nada a ningún lado.
- [ ] No toca el checkout ni las rutas excluidas.
- [ ] Todo en un closure, sin `document.write`, sin jQuery ni dependencia del tema.
- [ ] Pesa poco (acá, ~2,5 KB; lo sugerido es hasta 256 KB) y no empeora el Lighthouse mobile.

## Adaptarlo

- **Un número por comercio**: este ejemplo hornea un solo número en el archivo. Si
  tu app atiende a muchos comercios, el número tiene que venir de tu backend según
  la tienda, y eso es un `fetch` a tu servidor con `Commercy.store.domain`:
  revisá qué datos mandás y que sigas cumpliendo la política (nada de PII).
- **Otro ícono**: reemplazá `ICON_PATH` en `src/widget.ts`. Si usás el logo oficial
  de WhatsApp, seguí su guía de marca.

## Documentación

- [Scripts en la tienda](https://docs.commercy.com.ar/store-scripts.md)
- [Scopes y permisos](https://docs.commercy.com.ar/scopes.md)
- [Revisión y publicación](https://docs.commercy.com.ar/revision.md)

Commercy no cobra comisión por las apps (0 %) y todo lo que probás en borrador
funciona en tu propia tienda y en tus tiendas demo, sin plan pago.
