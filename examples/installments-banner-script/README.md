# Banner de cuotas para la ficha de producto · script de ejemplo

Script de tienda **completo y funcional** para la plataforma de apps de Commercy:
en la ficha de un producto muestra «Hasta N cuotas sin interés de $X», calculado
con el **precio y la moneda** que la tienda le da por `window.Commercy`. Es el
ejemplo de [scripts en la tienda](https://docs.commercy.com.ar/store-scripts.md) que
usa los **eventos** (`product_viewed`, `page_viewed`): declaración, SRI, URL
versionada, CORS y `window.Commercy`.

## Qué hace

- Escucha `product_viewed` (`{ productId, name, price, currency }`) y muestra el
  banner con la cuota calculada: `precio / cuotas`, redondeada al centavo y
  formateada en **es-AR** con `Intl.NumberFormat` (`$ 14.999,83`, `US$ 40.000,00`).
- Escucha `page_viewed` y **saca el banner** de cualquier página que no sea una
  ficha de producto (inicio, catálogo, carrito…). Como la tienda es una SPA,
  navegar de un producto a otro lo recalcula y navegar a otra página lo oculta.
- Si el precio es menor a la **compra mínima** configurada, no se muestra.
- **Configurable al compilar** (queda dentro del archivo): cantidad de cuotas,
  monto mínimo y, opcionalmente, dónde insertarlo.

| Producto | Config | Resultado |
| - | - | - |
| $ 89.999 | 6 cuotas, mínimo $ 20.000 | `Hasta 6 cuotas sin interés de $ 14.999,83` |
| $ 12.500,50 | 6 cuotas, mínimo $ 20.000 | (nada: no llega al mínimo) |
| Catálogo | — | (nada) |

> **Ojo con lo que prometés.** El banner sólo muestra un plan de cuotas: tiene que
> coincidir con lo que tu procesador de pagos realmente ofrece en el checkout. Si
> el banner dice 6 cuotas sin interés y el checkout no las da, es publicidad
> engañosa. Configurá `INSTALLMENTS_COUNT` y `INSTALLMENTS_MIN_AMOUNT` según el plan real.

## Dónde aparece

- **Cartel fijo** (por defecto): una tarjeta chica abajo a la izquierda, que deja
  libre la esquina derecha para un botón de chat. Funciona en cualquier tema.
- **Inline** (con `BANNER_ANCHOR`): se inserta justo después de un elemento de la
  ficha (por ejemplo el precio). Cada tema tiene su HTML: mirá el de tu tienda de
  prueba y poné un selector, como `.product-price`. Si el selector no existe, usa
  el cartel fijo. El script sólo **inserta** su contenedor; no lee ni cambia el
  resto de la página.

Todo vive en un **shadow DOM** dentro de `#commercy-app-installments`: el CSS de
la tienda no lo afecta y el nuestro no se filtra. El monto entra con
`textContent`, nunca como HTML. Si `window.Commercy` no existe, no hace nada.
Contraste del texto: `#0f3d24` sobre `#e8f5ec` = 10,9:1.

## Requisitos

- Node 20.12+ (usa `process.loadEnvFile`) y npm.
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  (o ngrok) para probarlo en tu tienda de desarrollo.
- Una app en el portal de developers de Commercy con el scope `storefront_scripts`.

## Estructura

```text
src/banner.ts        el script (TypeScript, se compila a un solo .js)
src/commercy.d.ts    tipos de window.Commercy y de sus eventos
build.ts             compila con esbuild, calcula el SRI y arma el bloque JSON
server.ts            sirve dist/ con CORS y caché inmutable (para probar con un túnel)
test.html            tienda falsa con window.Commercy para desarrollar sin Commercy
dist/                salida: installments-banner.v<version>.js + manifest.json
```

## Compilar

```bash
npm install
cp .env.example .env     # ajustá cuotas y mínimo
npm run build
```

| Variable | Qué es |
| - | - |
| `INSTALLMENTS_COUNT` | Cantidad de cuotas (entero de 2 a 48). Por defecto 6. |
| `INSTALLMENTS_MIN_AMOUNT` | Compra mínima, en la moneda de la tienda. Por defecto 20000. `0` = siempre. |
| `BANNER_ANCHOR` | Selector CSS opcional para insertarlo inline. Vacío = cartel fijo. |
| `SCRIPT_BASE_URL` | URL pública donde servís `dist/`. Sólo se usa para armar el bloque JSON. |

`npm run build` genera `dist/installments-banner.v<version>.js` (la versión sale
del `package.json`) y muestra el hash y el bloque para el portal:

```text
OK  dist/installments-banner.v1.0.0.js  (1.8 KB)
SRI sha384-w610EfBR46T9Ixt6Qrz5bFFCeGqfgtTxfiqR4gozNOVLYi6yIhhGI1K279B04kLX

{
  "handle": "installments-banner",
  "name": "Banner de cuotas",
  "src": "https://cdn.tuapp.com/installments-banner.v1.0.0.js",
  "integrity": "sha384-w610EfBR46T9Ixt6Qrz5bFFCeGqfgtTxfiqR4gozNOVLYi6yIhhGI1K279B04kLX",
  "loading": "interaction",
  "consent": "necessary"
}
```

(El hash depende de tu configuración: con otras cuotas vas a ver otro.)

## Servirlo

```bash
npm run serve                                   # terminal 1: http://localhost:8788
cloudflared tunnel --url http://localhost:8788  # terminal 2: https://algo.trycloudflare.com
```

`server.ts` responde cada archivo con lo que exige Commercy: `200` directo **sin
redirects**, `Access-Control-Allow-Origin: *`, `Content-Type: text/javascript` y
`Cache-Control: public, max-age=31536000, immutable`.

Verificá el archivo servido con el script del repo, que calcula el hash y
chequea redirects y CORS:

```bash
node ../../scripts/sri.mjs https://algo.trycloudflare.com/installments-banner.v1.0.0.js
```

El hash tiene que coincidir con el que imprimió el build. Si falta CORS, hay un
redirect o la URL no parece versionada, avisa y sale con código 1.

## Probarlo en local (sin tienda)

Con `npm run serve` andando, abrí <http://localhost:8788/test.html>. Es una
tienda falsa que define un `window.Commercy` **congelado** con la forma
documentada y tiene botones para navegar (inicio, catálogo, tres productos con
distinto precio y moneda, carrito) emitiendo `page_viewed` y `product_viewed`
como lo hace la tienda real, incluido el reenvío del último evento al
suscribirse. Carga tu script con `integrity` y `crossorigin="anonymous"` después
de la primera interacción (un scroll alcanza); si el hash no coincide, el
navegador lo bloquea y lo ves en el log. `?commercy=0` prueba sin `window.Commercy`.

Para probar el modo inline, compilá con `BANNER_ANCHOR='#price'` (la página de
prueba tiene un `<p id="price">`).

## Declararlo en el portal

1. En tu app, **Scopes** → pedí `storefront_scripts`.
2. **Scripts** → agregá una fila con los valores del bloque que imprimió el build:

   | Campo | Valor |
   | - | - |
   | `handle` | `installments-banner` |
   | `name` | `Banner de cuotas` (lo ve el comercio) |
   | `src` | `https://cdn.tuapp.com/installments-banner.v1.0.0.js` (https, mismo dominio que tu `appUrl`) |
   | `integrity` | el `sha384-...` del build (o el botón **Calcular hash** del portal) |
   | `loading` | `interaction`: se carga tras el primer toque o scroll y no pesa en el Lighthouse |
   | `consent` | `necessary`: es la función que el comercio instaló y no hace perfilado |

   También se puede por API, dentro de `storefrontScripts` en
   `PATCH /api/v1/developers/apps/:id`.
3. Pedile a soporte que habilite los scripts en tu app (en borrador).

## Probarlo en una tienda de desarrollo

Mientras tu app está en borrador los scripts sólo corren en tu **tienda de
desarrollo** y en tus **tiendas demo**.

1. Instalá la app en esa tienda aceptando el scope «Agregar código a tu tienda online».
2. Con el túnel andando, poné su URL en `SCRIPT_BASE_URL`, corré `npm run build` y
   copiá `src` e `integrity` al portal. En borrador también podés usar
   `http://localhost:8788/...` como `src`.
3. Abrí la ficha de un producto, hacé scroll y mirá la consola. Si algo falla el
   navegador lo bloquea y la tienda avisa: `[Commercy] No se pudo cargar el script "installments-banner"…`
   (hash que no coincide, falta CORS o hay un redirect).

El banner **no** aparece en `/checkout`, `/cuenta`, `/login`, `/registro`, la vista
previa del editor ni en las demás rutas excluidas: ahí `window.Commercy` no existe.

## Publicar una versión nueva

El hash está atado al contenido, así que **nunca pises el archivo en la misma URL**
(todas las tiendas dejarían de cargarlo hasta que apruebe la revisión). `npm run build`
te avisa si el archivo de esa versión ya existía con otro contenido.

1. Subí `version` en `package.json` (por ejemplo a `1.1.0`).
2. `npm run build`: genera `installments-banner.v1.1.0.js` y su hash. **El v1.0.0 queda donde está.**
3. Publicá el archivo nuevo y dejá **vivo el viejo**: las tiendas siguen cargándolo
   hasta que se apruebe el cambio.
4. En el portal cambiá `src` e `integrity`. Si tu app está publicada, el cambio pasa
   por revisión y se aplica al aprobarlo.
5. Con el cambio aprobado y unos minutos de margen, retirá el archivo viejo.

Cambiar las cuotas, el mínimo o el ancla también es una versión nueva: la
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
- [ ] El plan de cuotas que anuncia coincide con el que ofrece el checkout.
- [ ] Pesa poco (acá, ~1,8 KB; lo sugerido es hasta 256 KB) y no empeora el Lighthouse mobile.

## Límites del ejemplo

- Usa el precio que informa `product_viewed` y sólo reacciona a los eventos
  documentados. Si tu tienda cambia el precio al elegir una variante, el banner no
  lo sigue salvo que la tienda vuelva a emitir el evento.
- Muestra un único plan, el mismo para todos los productos y medios de pago.
- El cálculo es `precio / cuotas`: «sin interés» no incluye costo financiero, pero
  si tu procesador cobra un recargo, ajustá el texto.

## Documentación

- [Scripts en la tienda](https://docs.commercy.com.ar/store-scripts.md)
- [Scopes y permisos](https://docs.commercy.com.ar/scopes.md)
- [Revisión y publicación](https://docs.commercy.com.ar/revision.md)

Commercy no cobra comisión por las apps (0 %) y todo lo que probás en borrador
funciona en tu propia tienda y en tus tiendas demo, sin plan pago.
