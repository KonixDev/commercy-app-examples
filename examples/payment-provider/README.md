# Pagos Ejemplo · app de pago para Commercy

Pasarela de pagos de ejemplo, **completa y funcional**, que muestra de punta a punta cómo
una app cobra en el checkout de una tienda de Commercy: sesión de cobro, página de pago
hospedada, consulta de estado y webhook firmado.

Es una pasarela **de juguete**: el comprador elige «Pagar» o «Rechazar» en una tarjeta de
prueba. No se conecta a ningún procesador real. Lo que sí es real es el contrato con Commercy,
así que sirve de base para copiar y reemplazar la parte del medio de pago por la tuya.

Contrato completo: [Apps de pago](https://docs.commercy.com.ar/payment-apps).

## El flujo

```text
Comprador        Tienda / Commercy                       Tu app (Pagos Ejemplo)
   │  confirma la compra ─►│                                      │
   │                       │── POST /commercy/payments/session ──►│  (firmado) crea la sesión
   │                       │◄── { payment_id, checkout_url } ─────│
   │◄── redirige a checkout_url ──────────────────────────────────│
   │  GET /pay/:payment_id  (elige Pagar / Rechazar) ────────────►│  guarda el intento
   │                       │◄── POST /api/v1/app-webhooks/:inst ──│  payment.updated (firmado)
   │                       │── POST /commercy/payments/status ───►│  "¿cómo está pay_xxx?"
   │                       │◄── { payment_id, order_id, status,   │
   │                       │      amount, currency } ─────────────│
   │                       │  verifica estado, monto y moneda;    │
   │                       │  si es `approved` confirma la venta  │
   │◄── redirige a back_url (confirmación de la tienda) ──────────│
```

1. **Sesión.** Commercy te llama (`POST /commercy/payments/session`) con la venta. La app crea
   la sesión y responde `payment_id` + `checkout_url`. Es **idempotente**: la misma
   `idempotency_key` (el id de la venta) devuelve siempre la misma sesión.
2. **Checkout.** Mandamos al comprador a `checkout_url` (`/pay/:payment_id`). Ahí elige el
   resultado; la app guarda el intento y lo redirige al `back_url` de la tienda.
3. **Webhook.** La app le avisa a Commercy con `payment.updated`, firmado con tu secreto de
   webhook. **El webhook no lleva el estado**, sólo dice qué sesión cambió.
4. **Verificación.** Commercy consulta tu `POST /commercy/payments/status` y **comprueba que
   `payment_id` y `order_id` correspondan a la venta, y que `amount` y `currency` (`ARS`)
   coincidan con el total** antes de confirmarla. Por eso `/status` devuelve siempre los
   cinco campos y con valores exactos.

### Estados

| `status` | Cuándo lo devuelve esta app |
| - | - |
| `pending` | La sesión se abrió y nadie intentó pagar. |
| `in_process` | Algún intento quedó «en revisión» (botón «Dejar en revisión»). Commercy espera y vuelve a consultar, hasta 72 horas desde que se creó la venta. |
| `approved` | Algún intento se aprobó. |
| `rejected` | Hubo intentos y **ninguno** está aprobado ni en curso. La venta sigue abierta hasta que venza la sesión, por si el comprador reintenta. |
| `cancelled` | El comercio canceló la venta (webhook `order.cancelled`) y no hay un pago aprobado. Commercy lo trata como `rejected`. |

El estado es **agregado por sesión**: el `payment_id` no cambia aunque el comprador reintente
con otra tarjeta, y un intento rechazado después de uno aprobado no pisa el `approved`.

## Qué muestra de la plataforma

| Pieza | Dónde |
| - | - |
| Verificación de la firma `v1=HMAC_SHA256(secreto, "<ts>.<cuerpo crudo>")` con `timingSafeEqual` y ventana de ±5 min | `src/commercy.ts` → `verifyCommercyRequest` |
| Cuerpo crudo (`express.raw`) y chequeo `installation_id` del cuerpo = header | `src/index.ts` → `commercyAuth` |
| Sesión idempotente, `payment_id` estable, `checkout_url` en tu dominio | `src/index.ts` → `/commercy/payments/session` |
| Estado agregado con los 5 campos exactos | `src/store.ts` → `aggregateStatus`, `/commercy/payments/status` |
| Checkout hospedado, vencimiento (`expires_at`) respetado | `src/checkout.ts`, `src/index.ts` → `/pay/:id` |
| Webhook `payment.updated` firmado, con reintentos ante 5xx | `src/commercy.ts` → `notifyCommercy` |
| Eventos de la app (`order.cancelled` + los 4 obligatorios) con deduplicación | `src/index.ts` → `/webhooks/commercy` |
| OAuth 2.0 + PKCE para guardar el `installation_id` | `src/commercy.ts`, `/install` y `/callback` |

## Requisitos

- Node 20+
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (o ngrok) para exponer la app en local: Commercy sólo llama a URLs `https` públicas.

## Setup

```bash
npm install
cp .env.example .env
# Completá .env con los datos de tu app (portal de developers de Commercy)
```

| Variable | Qué es |
| - | - |
| `COMMERCY_WEBHOOK_SECRET` | El `whsec_...` completo de tu app. Firma los requests de Commercy y el webhook que le mandás. |
| `APP_BASE_URL` | URL pública de la app, la misma que cargás como `appUrl`. De acá sale el `checkout_url`. |
| `COMMERCY_CLIENT_ID` / `COMMERCY_CLIENT_SECRET` | Credenciales OAuth. Sólo para `/install`. |
| `COMMERCY_API_BASE` | API de Commercy (`https://api.commercy.com.ar`). |
| `PORT` | Puerto local, por defecto 3000. |
| `DATA_FILE` | Archivo JSON de estado, por defecto `.data/state.json`. |

## Correr

```bash
npm run dev                                        # terminal 1: http://localhost:3000
cloudflared tunnel --url http://localhost:3000     # terminal 2: túnel público
```

Con la URL del túnel (p. ej. `https://algo.trycloudflare.com`):

1. Ponela en `APP_BASE_URL` y reiniciá.
2. En el portal cargá: `appUrl` = esa URL, **Redirect URI** = `<url>/callback` y **Webhook URL** = `<url>/webhooks/commercy` (suscribite a `order.cancelled`).
3. Abrí `<url>/install` con el usuario dueño de la tienda para instalar la app.

> **Dominio del checkout.** El `checkout_url` tiene que ser `https` y compartir el dominio
> registrable del `appUrl`. Esta app lo arma siempre con `APP_BASE_URL`, así que se cumple solo
> mientras sean la misma URL. Los dominios compartidos de hosting (`*.vercel.app`, etc.) no
> cuentan como el mismo dominio.

## Cómo pedir la capability `paymentCheckout`

Una app no se ofrece como medio de pago sola: **Commercy la tiene que habilitar**.

1. Guardá el secreto de webhook y cargá el `appUrl` en el portal.
2. Escribile a soporte pidiendo habilitar tu app como medio de pago (`paymentCheckout`). Pasale
   el **id de tu app** y la **URL base de tu API** (`apiBaseUrl`): `https` y pública, por ejemplo
   `https://pagos.tuapp.com`. Commercy le concatena `/commercy/payments/session` y
   `/commercy/payments/status`.
3. El comercio instala la app y la prende en **Ajustes > Cobros** de su tienda.

Mientras la app esté en borrador, la habilitamos sólo en la tienda de desarrollo de tu cuenta,
para que pruebes el flujo completo.

## Probar sin Commercy

Con la app corriendo (`COMMERCY_WEBHOOK_SECRET` en `.env`), firmá requests con el script del repo.
`--header-style=app` agrega el header `X-Commercy-Installation`, que esta app exige:

```bash
INST=6710b3c2e4a1f20012ab34cd
SECRET=whsec_TU_WEBHOOK_SECRET

# 1. Abrir la sesión
node ../../scripts/sign-request.mjs http://localhost:3000/commercy/payments/session $SECRET \
  '{"installation_id":"'$INST'","shop_id":"s1","idempotency_key":"venta-1","order":{"id":"venta-1","number":"1042"},"amount":25000,"currency":"ARS","items":[{"name":"Remera lisa","quantity":2,"unit_price":12500}],"back_url":"http://localhost:3000/health","expires_at":"2099-01-01T00:00:00.000Z"}' \
  --header-style=app
# → {"payment_id":"pay_...","checkout_url":"http://localhost:3000/pay/pay_..."}
#   Repetí el mismo comando: devuelve el mismo payment_id.

# 2. Consultar el estado → "pending"
node ../../scripts/sign-request.mjs http://localhost:3000/commercy/payments/status $SECRET \
  '{"installation_id":"'$INST'","payment_id":"pay_..."}' --header-style=app

# 3. Abrir el checkout_url en el navegador y tocar «Pagar» (o:)
curl -i -d action=approve http://localhost:3000/pay/pay_...
#   Consultá el estado de nuevo → "approved".
```

Una firma inválida, un timestamp de hace más de 5 minutos o un `installation_id` que no coincide
con el header dan `401`.

El webhook hacia Commercy se manda a `COMMERCY_API_BASE/api/v1/app-webhooks/<installation_id>`.
Para ver lo que sale sin Commercy, poné `COMMERCY_API_BASE` apuntando a un receptor local tuyo
(cualquier servidor que loguee el request) y verificá la firma con el mismo secreto: es el mismo
esquema que `verifyCommercyRequest`.

## Endpoints

| Ruta | Quién la llama | Qué hace |
| - | - | - |
| `POST /commercy/payments/session` | Commercy (firmado) | Abre la sesión. Idempotente por `idempotency_key`. |
| `POST /commercy/payments/status` | Commercy (firmado) | Estado agregado de la sesión. |
| `GET /pay/:id` · `POST /pay/:id` | El comprador | Checkout hospedado: pagar, rechazar o dejar en revisión. |
| `POST /pay/:id/resolve` | El comprador (simulador) | Resuelve una revisión `in_process` a aprobada o rechazada. |
| `POST /webhooks/commercy` | Commercy (firmado) | Eventos de la app: `order.cancelled` y los 4 obligatorios. |
| `GET /install` · `GET /callback` | El comerciante | OAuth + PKCE: registra el `installation_id`. |

## Reembolsos

**Los reembolsos se hacen desde tu app, no desde Commercy.** Commercy no tiene un endpoint para
informar reembolsos e ignora el estado `refunded` de `/status`.

- Si el comercio cancela o devuelve la venta desde Commercy, la plata **no se mueve**: tu app
  recibe `order.cancelled` y tiene que devolverle al comprador en su plataforma. Esta app sólo
  lo deja logueado (`ya estaba cobrada: reembolsar...`); en producción acá disparás la
  devolución en tu procesador.
- Si el comercio intenta reembolsar desde Commercy un cobro de tu app, ve el aviso «Los pagos
  registrados por una app se reembolsan desde esa app» y no pasa nada.
- Un cobro que se informa después de que la venta se canceló (incluido el tope de 72 horas) es un
  cobro tardío: Commercy lo registra y avisa al comercio, pero no reabre la venta ni devuelve la plata.

## Notas de implementación

- **Persistencia.** Memoria + un JSON (`DATA_FILE`) que se reescribe entero en cada cambio: es un
  ejemplo. En producción usá una base con índices únicos en `idempotency_key` (por instalación)
  y en `payment_id`.
- **Webhook en segundo plano.** El comprador no espera la verificación de Commercy: el webhook sale
  con reintentos (1, 2, 4, 8 y 16 s) ante un `5xx` o un error de red. Si el proceso se cae a mitad
  de los reintentos se pierden; en producción usá una cola. Igual no se pierde el cobro: Commercy
  también consulta cuando el comprador vuelve a la tienda y al vencer la sesión.
- **`/status` no se bloquea.** Commercy responde el webhook *después* de consultar tu `/status`:
  el servidor atiende ambos a la vez (Node, sin trabajo bloqueante).
- **No hay tokens guardados.** Esta app no usa la API pública de Commercy, así que descarta el
  access/refresh token del canje OAuth y sólo conserva el `installation_id`. Si tu app sí la usa,
  guardá los tokens cifrados (mirá `sales-dashboard`).
- **Instalación.** Acepta sesiones de cualquier instalación con firma válida. Una pasarela real
  rechaza las que no tengan alta (el «proceso de alta» propio del que habla el contrato) y mapea
  cada `installation_id` a la cuenta del comercio en tu procesador.
- **Rotación del secreto.** Si rotás el `whsec_...` en el portal, actualizá `COMMERCY_WEBHOOK_SECRET`
  al mismo tiempo: hasta entonces las sesiones en curso no se pueden verificar.

## Checklist de producción

- [ ] **PCI.** Nunca recibas, loguees ni guardes datos de tarjeta en Commercy ni en esta app de
  ejemplo. Los datos de tarjeta los toma tu procesador (hosted fields o redirección), no el HTML de
  tu checkout. Commercy no guarda credenciales de tu procesador.
- [ ] **HTTPS** en todo, con el `checkout_url` en el mismo dominio registrable que el `appUrl`.
- [ ] La firma se verifica sobre el **cuerpo crudo**, en tiempo constante, con ventana de 5 minutos,
  y el `installation_id` del cuerpo coincide con el header.
- [ ] **Idempotencia**: la misma `idempotency_key` devuelve la misma sesión; el `payment_id` es
  estable durante toda la sesión, aunque el comprador reintente.
- [ ] `/status` devuelve los cinco campos, con `order_id`, `amount` y `currency` exactos.
- [ ] No aceptás pagos después de `expires_at` ni de una cancelación.
- [ ] Mandás `payment.updated` con `Content-Type: application/json` y reintentás ante un `500`
  con espera creciente.
- [ ] Un `in_process` se resuelve (`approved` o `rejected`) antes de las **72 horas**; si no, la
  venta se cancela y un pago posterior es un cobro tardío.
- [ ] Los reembolsos los hacés en tu plataforma al recibir `order.cancelled`.
- [ ] Atendés `/status` y tus webhooks aun después de que el comercio desinstale la app: las
  sesiones abiertas se siguen reconciliando.
- [ ] Los 4 webhooks obligatorios (`app.uninstalled`, `store.redact`, `customers.redact`,
  `customers.data_request`) están implementados.

## Documentación

- [Apps de pago](https://docs.commercy.com.ar/payment-apps)
- [Webhooks](https://docs.commercy.com.ar/webhooks)
- [Autenticación OAuth](https://docs.commercy.com.ar/oauth)
- [Scopes y permisos](https://docs.commercy.com.ar/scopes)
