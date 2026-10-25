# Envíos Ejemplo · app de envío para Commercy

App de ejemplo de un **carrier** («Envíos Ejemplo») para la plataforma de apps de
Commercy: cotiza el envío en el checkout, crea y cancela envíos cuando el comercio
lo pide, y le informa a Commercy cómo avanza la entrega.

La integración es HTTP en los dos sentidos: **Commercy te llama** (requests firmados)
y **vos llamás a la API pública** para empujar el seguimiento. Contrato completo:
[Apps de envío](https://docs.commercy.com.ar/shipping-apps.md).

## Qué hace

| Dirección | Ruta | Qué hace |
| - | - | - |
| Commercy → app | `POST /commercy/shipping/quote` | Tarifas por zona (CABA / GBA / interior) y peso. Responde en memoria, muy por debajo del tope de 3 s. |
| Commercy → app | `POST /commercy/shipping/shipments` | Alta de envío **idempotente** por `idempotency_key`. |
| Commercy → app | `POST /commercy/shipping/shipments/cancel` | Cancela el envío por `code`. |
| Commercy → app | `POST /webhooks/commercy` | Opcional: deduplica por `X-Commercy-Event-Id`, cancela el envío en `order.cancelled` y descarta los tokens en `app.uninstalled`. |
| app → Commercy | `POST /orders/:id/status` y `/fulfillment` | Empuja `preparing` → `shipped` (+ tracking) → `delivered`. |
| comprador | `GET /seguimiento/:tracking_number` | Página pública de seguimiento (la del `tracking_url`). |

## Qué muestra de la plataforma

| Pieza | Dónde |
| - | - |
| Firma `X-Commercy-Signature` (`v1=` + HMAC-SHA256 de `"<timestamp>.<cuerpo crudo>"`), comparación con `timingSafeEqual` y ventana de ±5 min | `src/signature.ts` |
| Cuerpo crudo con `express.raw` + chequeo de que `installation_id` del cuerpo coincida con `X-Commercy-Installation` | `src/index.ts` → `commercyAuth` |
| Respuesta de cotización con `method_id` estable y `price` numérico; `items` vacío y productos sin peso | `src/rates.ts` |
| Alta idempotente: misma key, mismo `code`; key nueva (`:2`), envío nuevo | `src/index.ts` → `/commercy/shipping/shipments` |
| OAuth 2.0 + PKCE y refresh rotativo (mismo patrón que [`sales-dashboard`](../sales-dashboard)) | `src/commercy.ts`, `src/tracking.ts` |
| Empujar el seguimiento con la API pública (scope `write_orders`) y manejar los `409` (`order_closed`, `payment_confirmation_required`) | `src/tracking.ts`, `src/index.ts` → `/demo/...` |

## Requisitos

- Node 20+
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (o ngrok) para que Commercy llegue a tu máquina.

## Setup

```bash
npm install
cp .env.example .env
```

| Variable | Qué es |
| - | - |
| `COMMERCY_WEBHOOK_SECRET` | El `whsec_...` completo de tu app (portal → Webhooks). Con él Commercy firma los requests a `/commercy/shipping/*`. **Obligatoria.** |
| `COMMERCY_CLIENT_ID` / `COMMERCY_CLIENT_SECRET` | Credenciales OAuth de la app. Hacen falta para instalar y empujar seguimiento, no para cotizar/crear/cancelar. |
| `APP_BASE_URL` | URL pública de esta app (la del túnel). Es la base de los `tracking_url` y, sin la barra final, tu `apiBaseUrl`. |
| `PORT` | Puerto local, por defecto 3000. |
| `COMMERCY_API_BASE` | API de Commercy. **Por defecto apunta a PRODUCCIÓN** (`https://api.commercy.com.ar`): para probar contra otro entorno (staging, local) tenés que setearla, si no el OAuth y el seguimiento van a producción. Sin barra final. |
| `COMMERCY_API_VERSION` | Versión de la API pública (`2026-10`). |

En el portal pedí el scope **`write_orders`** (incluye `read_orders`): sin `read_orders`
no te mandamos cotizaciones ni altas, y sin `write_orders` no podés informar el seguimiento.
Cargá la redirect URI `https://tu-tunel.trycloudflare.com/callback`.

## Correr

```bash
npm run dev                                       # terminal 1: http://localhost:3000
cloudflared tunnel --url http://localhost:3000    # terminal 2: túnel público
```

Copiá la URL del túnel en `APP_BASE_URL` y reiniciá.

## Pedir que habiliten tu app como carrier

Una app no es carrier por defecto: **la habilita el staff de Commercy**. Escribile a
soporte con:

1. El **id de tu app** (el de la URL de tu app en el portal).
2. Tu **`apiBaseUrl`**: la URL base `https` y pública de tu API, sin barra final
   (acá, el `APP_BASE_URL`, por ejemplo `https://api.tuapp.com`). Commercy le
   concatena `/commercy/shipping/quote`, `/commercy/shipping/shipments` y
   `/commercy/shipping/shipments/cancel`.

Mientras tu app esté en borrador, la habilitamos sólo en la tienda de desarrollo de
tu cuenta. Después abrí `http://localhost:3000/install` e instalala con el dueño de la
tienda; desde ahí aparece como opción de envío en el checkout.

## Probar en local sin Commercy

El script `scripts/sign-request.mjs` del repo firma un request igual que Commercy y lo envía.
Los comandos se corren parados en `examples/shipping-carrier`; `--header-style=app` agrega el
header `X-Commercy-Installation`, que esta app exige:

```bash
# Cotizar (CABA, 2 productos de 450 g)
node ../../scripts/sign-request.mjs http://localhost:3000/commercy/shipping/quote whsec_TU_SECRETO \
  '{"installation_id":"inst1","shop_id":"shop1","postal_code":"1425","items":[{"quantity":2,"weight":{"value":450,"unit":"g"}}]}' \
  --header-style=app

# Alta (repetila: devuelve el mismo envío)
node ../../scripts/sign-request.mjs http://localhost:3000/commercy/shipping/shipments whsec_TU_SECRETO \
  '{"installation_id":"inst1","shop_id":"shop1","idempotency_key":"ORD1:1","method_id":"standard","order":{"id":"ORD1","number":"A-1","items":[],"shipping_address":{"street":"Av. Santa Fe","postal_code":"1425"}}}' \
  --header-style=app

# Cancelar
node ../../scripts/sign-request.mjs http://localhost:3000/commercy/shipping/shipments/cancel whsec_TU_SECRETO \
  '{"installation_id":"inst1","shop_id":"shop1","code":"EE-000001"}' \
  --header-style=app
```

Qué tenés que ver: firma válida → `200` con la forma del contrato; firma inválida o con un
timestamp de hace más de 5 minutos → `401`; alta repetida con la misma `idempotency_key` → el mismo `code`.

Sin el script, firmás a mano:

```bash
BODY='{"installation_id":"inst1","shop_id":"shop1","postal_code":"1425","items":[]}'
TS=$(date +%s)
SIG="v1=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$COMMERCY_WEBHOOK_SECRET" -hex | awk '{print $NF}')"
curl -X POST localhost:3000/commercy/shipping/quote \
  -H 'Content-Type: application/json' \
  -H 'X-Commercy-Installation: inst1' -H "X-Commercy-Timestamp: $TS" -H "X-Commercy-Signature: $SIG" \
  -d "$BODY"
```

(El `installation_id` del cuerpo tiene que coincidir con el header `X-Commercy-Installation`.)

## Demo del seguimiento

Con la app **instalada** (hace falta el token de la instalación) y un envío creado desde
una venta real en Commercy («Enviar con tu app»), simulá que avanza. Cada llamada da un paso:

```bash
curl -X POST localhost:3000/demo/shipments/EE-000001/advance   # → preparing
curl -X POST localhost:3000/demo/shipments/EE-000001/advance   # → shipped (+ tracking en la venta)
curl -X POST localhost:3000/demo/shipments/EE-000001/advance   # → delivered (cierra la venta)
```

`delivered` **cierra la venta** (descuenta stock, mueve la caja, genera el asiento
contable): en una app real mandalo sólo cuando el paquete se entregó. Si Commercy
rechaza el paso (`409 order_closed`, `409 payment_confirmation_required`...) la demo
lo devuelve tal cual y no avanza el estado local, así que podés reintentar.

## Notas de implementación

- **Persistencia de demo**: los envíos y las instalaciones se guardan en `.data/state.json`
  (ignorado por git). Es un archivo entero reescrito en cada cambio, sin locks ni cifrado.
  En producción usá una base, con un índice **único** por `idempotency_key`.
- **La key identifica un intento de envío, no la venta**: tras cancelar, el siguiente alta
  de esa venta trae `:2`, y ahí se crea un envío nuevo.
- El refresh token es rotativo: cada uno se usa una vez y se guarda el nuevo.
  Los refreshes se serializan por instalación.
- Tarifas y zonas son inventadas (`src/rates.ts`): reemplazalas por tu tarificador,
  pero mantené la respuesta rápida (tope de 3 s para cotizar, 15 s para crear/cancelar).

## Checklist de producción

- [ ] Verificás la firma sobre el cuerpo crudo y que `installation_id` coincida con el header.
- [ ] Cotizás en menos de 3 segundos y con `price` numérico; los `method_id` son estables.
- [ ] El alta devuelve el mismo `code` para la misma `idempotency_key` (índice único en tu base).
- [ ] El `tracking_url` es `https`.
- [ ] Cancelás el envío cuando recibís `order.cancelled`, y sabés qué hacer con `app.uninstalled`.
- [ ] Empujás `preparing`, `shipped`, `delivered` y el seguimiento con la API.
- [ ] Sacaste la ruta `/demo/...` (no tiene autenticación) y guardás los tokens cifrados.
- [ ] Servís por `https` en una dirección pública, sin redirects.
- [ ] Soporte habilitó tu app como carrier con tu `apiBaseUrl`.

## Documentación

- [Apps de envío](https://docs.commercy.com.ar/shipping-apps.md)
- [Webhooks](https://docs.commercy.com.ar/webhooks.md)
- [Referencia de la API](https://docs.commercy.com.ar/api-reference.md)
- [Scopes y permisos](https://docs.commercy.com.ar/scopes.md)
