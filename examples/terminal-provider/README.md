# Terminal Ejemplo · app de cobro presencial para Commercy

App de **cobro presencial** de ejemplo, completa y funcional, que muestra de punta a punta cómo un
procesador de pagos se integra como medio de cobro del **POS y el kiosco** de Commercy: lista los
lectores del comercio, crea el cobro, responde su estado, lo cancela y le avisa a Commercy cuando se resuelve.

Es un procesador **de juguete**: no se conecta a ninguna red de tarjetas. El cliente "paga" cuando alguien
(vos, o el QA) aprueba el cobro desde un endpoint protegido por token (`/admin`, ver [Simulador](#simulador-el-procesador-de-juguete)).
Lo que sí es real es el contrato con Commercy, así que sirve de base para copiar y reemplazar la parte del medio por la tuya.

Contrato completo: [Apps de cobro presencial](https://docs.commercy.com.ar/pos-payment-apps).

## El flujo

```text
Cajero / cliente        Commercy                               Tu app (Terminal Ejemplo)
   │  elige «Terminal Ejemplo» ─►│                                    │
   │                             │── POST /commercy/pos/devices ─────►│  (firmado) lectores de la sucursal
   │                             │── POST /commercy/pos/payments ────►│  crea el cobro (idempotente)
   │                             │◄── { payment_id, status, expires_at, display } ─│
   │  paga en el lector / escanea el QR / transfiere                   │
   │                             │◄── POST /api/v1/app-webhooks/:inst ─│  pos_payment.updated (firmado)
   │                             │── POST /commercy/pos/payments/status ►│  "¿cómo está este payment_ref?"
   │                             │◄── { status, amount_requested, amount_paid, ... } ─│
   │                             │  verifica y recién ahí confirma la venta            │
   │                             │── POST /commercy/pos/payments/cancel ►│  si el cajero cancela o vence
```

1. **Crear.** Commercy te manda `payment_ref` (único, **nuevo por cada intento**), el monto como string
   (`"1234.50"`), el modo y, en un lector, el `device_id`. Es **idempotente** por `payment_ref`: el mismo cuerpo
   devuelve siempre el mismo `payment_id`; otro cuerpo con el mismo `payment_ref` es `idempotency_conflict`.
2. **Display.** Según el modo, la respuesta lleva lo que Commercy muestra: nada en `device`, un **QR EMVCo** en
   `qr`, e instrucciones + **datos de transferencia** (CVU, alias, titular, CUIT) en `none`.
3. **Aviso.** Cuando el estado cambia le mandás `pos_payment.updated` firmado. **El aviso no lleva el estado**:
   sólo dice qué cobro cambió. Commercy lo consulta con tu `status` y **nunca aplica el contenido del aviso**.
4. **Verificación.** `status` se resuelve **sólo por `payment_ref`** (el `payment_id` es opcional: la creación puede
   haberse cortado por timeout antes de que Commercy lo recibiera) y devuelve `amount_paid` como **total bruto
   cobrado**, con recargo y propina, antes de las comisiones.

### Estados

| `status` | Cuándo lo devuelve esta app |
| - | - |
| `pending` | El cobro se creó y nadie pagó todavía. |
| `in_process` | El simulador lo pasó "en marcha" (tarjeta presentada, verificación pendiente). |
| `approved` | Cobrado. `amount_paid` = total + propina + recargo. |
| `partial` | Se cobró menos que el total. Commercy no aplica nada y avisa al comercio. |
| `rejected` | Rechazado, con `error.code` (`declined`, `customer_canceled`, ...). `amount_paid` = `"0.00"`. |
| `cancel_requested` | Con `CANCEL_MODE=async`: la cancelación está pedida pero no confirmada. |
| `cancelled` / `expired` | Cancelado o vencido sin cobro. `amount_paid` = `"0.00"`. |
| `refunded` / `partially_refunded` | Se devolvió (parte de) lo cobrado; lleva `refunded_amount`. La devolución la hacés vos en tu plataforma: Commercy sólo la registra. |

Un cobro `approved` sólo puede pasar a `refunded` o `partially_refunded`: cualquier otra transición posterior
(volver a `pending` o a `rejected`, por ejemplo) Commercy la ignora y alerta. El simulador respeta la misma regla.

## Qué muestra de la plataforma

| Pieza | Dónde |
| - | - |
| Verificación de la firma `v1=HMAC_SHA256(secreto, "<ts>.<cuerpo crudo>")` con `timingSafeEqual`, ventana de ±5 min y **dos secretos** (vigente y anterior) | `src/commercy.ts` → `verifyCommercyRequest` |
| Cuerpo crudo (`express.raw`) y chequeo `installation_id` del cuerpo = header | `src/app.ts` → `commercyAuth` |
| Idempotencia por `payment_ref`, `payment_not_found` (404) → `payment_ref_consumed`, errores tipados | `src/store.ts` → `create`, `find` |
| Montos como string con dos decimales, comparados en centavos; `amount_paid` bruto | `src/money.ts`, `src/store.ts` → `transition` |
| QR EMVCo con CRC-16 sobre bytes UTF-8, CVU con dígito verificador, CUIT, alias | `src/display.ts` |
| Cancelación síncrona (`cancelled`) o asíncrona (`cancel_requested`), idempotente por `cancel_ref` | `src/store.ts` → `cancel` |
| Aviso `pos_payment.updated` firmado, con reintentos ante 5xx / 429 | `src/commercy.ts` → `notifyCommercy` |
| Simulador del procesador protegido por token | `src/app.ts` → `/admin` |

## Requisitos

- Node 20.12+
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (o ngrok) para exponer la app en local: Commercy sólo llama a URLs `https` públicas.

## Setup

```bash
npm install
cp .env.example .env
# Completá .env con los datos de tu app (portal de developers de Commercy)
```

| Variable | Qué es |
| - | - |
| `COMMERCY_WEBHOOK_SECRET` | **Obligatoria.** El `whsec_...` completo de tu app. Firma los requests de Commercy y el aviso que le mandás. |
| `COMMERCY_WEBHOOK_SECRET_PREVIOUS` | Sólo mientras rotás el secreto: se aceptan requests firmados con cualquiera de los dos. Borrala pasadas las 72 horas. |
| `COMMERCY_API_BASE` | API de Commercy. **Por defecto apunta a PRODUCCIÓN** (`https://api.commercy.com.ar`): para probar contra otro entorno (staging, local) tenés que setearla, si no los avisos van a producción. |
| `ADMIN_TOKEN` | Token del simulador (`/admin`). Sin él, `/admin` está apagado (404). |
| `MODES` | Modos que aceptás, separados por coma: `device,qr,none` (default: los tres). Un modo que no está acá da `not_available`. |
| `CANCEL_MODE` | `sync` (default), `async` o `unsupported`. Tiene que coincidir con `cancel` en la declaración. |
| `AMOUNT_MIN` / `AMOUNT_MAX` | Rango de monto, strings con dos decimales (default `1.00` y `500000.00`). Fuera de él: `amount_out_of_range`. |
| `DEVICES` | JSON con los lectores: `[{"id":"reader_01","label":"Caja 1","status":"online"}]`. Default: `reader_01` y `reader_02`. |
| `MERCHANT_NAME` / `MERCHANT_CITY` | Nombre (hasta 25) y ciudad (hasta 15) que van dentro del QR EMVCo. El default lleva «Ñ» a propósito. |
| `TRANSFER_CVU` / `TRANSFER_ALIAS` / `TRANSFER_HOLDER_NAME` / `TRANSFER_HOLDER_CUIT` | Datos de la transferencia del modo `none`. Los defaults son válidos pero **de mentira**. |
| `PORT` | Puerto local, por defecto 3000. |

Los datos de transferencia y el nombre del comercio se **validan al arrancar** con las mismas reglas que usa Commercy:
si el CVU no tiene dígito verificador o el CUIT está mal, la app no levanta (Commercy rechazaría el `display` entero).

## Correr

```bash
npm run dev                                        # terminal 1: http://localhost:3000
cloudflared tunnel --url http://localhost:3000     # terminal 2: túnel público
```

Con la URL del túnel (p. ej. `https://algo.trycloudflare.com`):

1. En el portal cargá `appUrl` (tiene que ser un dominio propio, no una IP ni `localhost`) y pedile a soporte que habilite
   el cobro presencial de tu app pasándole el **id de tu app** y la **URL base de tu API** (`apiBaseUrl`): la URL del
   túnel. Commercy le concatena `/commercy/pos/devices`, `/commercy/pos/payments`, etc.
2. Cargá la declaración de abajo en la pestaña **Cobro presencial** del portal y pedí el permiso `pos_payments` en Scopes.
3. Instalá la app en tu tienda de desarrollo, **aceptá «Cobrar en tu punto de venta»** y, en **Ajustes > sucursal > Cobros**,
   vinculá los lectores (`reader_01`, `reader_02`). Después prendé «Tu app presencial» en **Medios de pago del POS**.

Mientras la app esté en borrador, Commercy la habilita sólo en la tienda de desarrollo de tu cuenta.

## La declaración

Pegala en el portal (pestaña **Cobro presencial**). Es fiel a los defaults de esta app: si cambiás `MODES`, `CANCEL_MODE`
o `AMOUNT_MIN` / `AMOUNT_MAX`, cambiá también acá lo que corresponda, porque Commercy revisa la declaración contra lo que la app hace.

```json
{
  "displayName": "Terminal Ejemplo",
  "modes": ["device", "qr", "none"],
  "listsDevices": true,
  "sendsWebhooks": true,
  "cancel": "sync",
  "expirySeconds": { "min": 60, "max": 259200 },
  "amount": { "min": "1.00", "max": "500000.00" },
  "installments": { "mode": "pos", "counts": [3, 6, 12], "costChoice": true },
  "printTicket": false,
  "contractVersion": "2026-10"
}
```

Esta app respeta el vencimiento (`expires_at`) que pide Commercy, de ahí el rango amplio de `expirySeconds`
(en el modo `none` el POS puede dejar el cobro pendiente hasta 72 horas). Las cuotas del POS se aceptan y se devuelven en
`details.installments`; el recargo, si lo hay, lo informás en `amount_extra.surcharge`.

## Simulador: el procesador de juguete

En producción el cliente paga en el lector y tu procesador te avisa. Acá no hay procesador, así que el pago se simula
"desde afuera" con el token de `ADMIN_TOKEN`:

```bash
BASE=http://localhost:3000
AUTH="Authorization: Bearer $ADMIN_TOKEN"

curl -s -H "$AUTH" $BASE/admin/payments                       # cobros y payment_ref consumidos
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"tip":"50.00","surcharge":"15.50"}' \
  $BASE/admin/payments/<payment_ref>/approve                  # cobrado: amount_paid = total + 65.50
```

| Acción (`POST /admin/payments/:payment_ref/:action`) | Cuerpo opcional | Qué hace |
| - | - | - |
| `approve` | `{ "tip": "50.00", "surcharge": "15.50" }` | `approved`. `amount_paid` = total + propina + recargo (bruto). |
| `reject` | `{ "code": "declined" }` | `rejected` (`declined`, `customer_canceled`, `device_busy`, `device_offline`, `other`). |
| `partial` | `{ "amount_paid": "500.00" }` | `partial`: se cobró menos que el total. |
| `in-process` | | `in_process`. |
| `expire` | | `expired`. Esta app **no vence sola**: el vencimiento lo dispara el simulador (o tu procesador). |
| `cancel-done` | | Confirma una cancelación asíncrona (`cancel_requested` → `cancelled`). |
| `refund` | `{ "amount": "100.00" }` | `refunded` / `partially_refunded`. Sin `amount`, devuelve lo que quede. |

Cada acción **le avisa a Commercy** (`pos_payment.updated`) y devuelve el resultado del aviso en `webhook`;
con `{ "notify": false }` cambia el estado sin avisar, para probar que Commercy también lo detecta consultando.
Los montos van siempre como string.

Para el estado de un lector: `POST /admin/devices/reader_01` con `{ "status": "offline" }` (o `online`, `busy`, `unknown`)
y el próximo cobro en ese lector da `device_offline`. Un lector con un cobro vivo se lista como `busy` y da `device_busy`.

## Probar sin Commercy

Con la app corriendo (`COMMERCY_WEBHOOK_SECRET` en `.env`), firmá requests con el script del repo.
`--header-style=app` agrega el header `X-Commercy-Installation`, que esta app exige:

```bash
INST=6710b3c2e4a1f20012ab34cd
SECRET=whsec_TU_WEBHOOK_SECRET
REF=k3x9a1b7q2m5z8c4v6n0d2f5h7j9l1p3

# 1. Lectores
node ../../scripts/sign-request.mjs http://localhost:3000/commercy/pos/devices $SECRET \
  '{"installation_id":"'$INST'","shop_id":"s1"}' --header-style=app

# 2. Crear un cobro con transferencia (modo none)
node ../../scripts/sign-request.mjs http://localhost:3000/commercy/pos/payments $SECRET \
  '{"installation_id":"'$INST'","shop_id":"s1","payment_ref":"'$REF'","order":{"id":"o1","number":"1042"},"amount":"1234.50","currency":"ARS","mode":"none","expires_at":"2099-01-01T00:00:00.000Z","display_title":"Venta 1042"}' \
  --header-style=app
# → {"payment_id":"pay_...","status":"pending",...,"display":{"instructions":"...","transfer":{"cvu":"...",...}}}
#   Repetí el mismo comando: devuelve el mismo payment_id.

# 3. Estado → "pending"
node ../../scripts/sign-request.mjs http://localhost:3000/commercy/pos/payments/status $SECRET \
  '{"installation_id":"'$INST'","shop_id":"s1","payment_ref":"'$REF'"}' --header-style=app

# 4. Aprobar desde el simulador y consultar de nuevo → "approved", amount_paid "1234.50"
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/admin/payments/$REF/approve
```

Una firma inválida, un timestamp de hace más de 5 minutos o un `installation_id` que no coincide con el header dan `401`.

El aviso hacia Commercy se manda a `COMMERCY_API_BASE/api/v1/app-webhooks/<installation_id>`. Para ver lo que sale sin
Commercy, poné `COMMERCY_API_BASE` apuntando a un receptor local tuyo (cualquier servidor que loguee el request) y
verificá la firma con el mismo secreto: es el mismo esquema que `verifyCommercyRequest`.

## Endpoints

| Ruta | Quién la llama | Qué hace |
| - | - | - |
| `POST /commercy/pos/devices` | Commercy (firmado) | Lista los lectores de la sucursal. |
| `POST /commercy/pos/payments` | Commercy (firmado) | Crea el cobro. Idempotente por `payment_ref`. |
| `POST /commercy/pos/payments/status` | Commercy (firmado) | Estado del cobro, por `payment_ref`. `404 payment_not_found` si no lo conoce. |
| `POST /commercy/pos/payments/cancel` | Commercy (firmado) | Cancela el intento. Idempotente por `cancel_ref`. |
| `GET /admin/payments` · `POST /admin/payments/:ref/:action` · `POST /admin/devices/:id` | Vos / el QA (`Bearer ADMIN_TOKEN`) | El simulador. |
| `GET /health` | Cualquiera | `{ "ok": true }`. |

## Tests

```bash
npm test            # unitarios y de contrato (node:test + tsx, sin dependencias nuevas)
npm run typecheck
npm run smoke       # levanta el server, le habla con requests firmados y lo apaga (necesita el repo entero)
```

## Notas de implementación

- **Persistencia.** Todo vive en memoria: reiniciar la app borra los cobros y los `payment_ref` consumidos. En producción
  usá una base con índice único en `payment_ref` y **retené la clave al menos 72 horas más el vencimiento del cobro**; si tu
  procesador no tiene idempotencia, guardá el `payment_ref` **antes** de llamarlo.
- **`payment_ref_consumed`.** Cuando contestás `payment_not_found` a un `status` o `cancel`, ese `payment_ref` queda
  rechazado para siempre. Así un reintento de creación que todavía viaja por la red no puede crear el cobro después de que
  Commercy lo dio por inexistente. Un cobro de **otra instalación** se contesta igual `payment_not_found` pero no se consume.
- **`status` y `cancel` tienen que funcionar siempre**, no sólo mientras el cobro está en curso: Commercy los usa para
  reconciliar, para reintentar y para decidir si da un intento por vencido. Seguí atendiéndolos aun si el comercio
  desinstala la app.
- **Datos del comprador.** Tu app nunca los recibe: sólo el número de venta, el monto, las cuotas y el modo.
- **Instalación.** Acepta cobros de cualquier instalación con firma válida. Un procesador real rechaza (`not_available`) las
  que no tengan alta y mapea cada `installation_id` a la cuenta del comercio en tu procesador; un `device_id` que no
  pertenece a esa cuenta es `invalid_device`.
- **Display.** Se muestra siempre como texto o como un QR que dibuja Commercy, nunca como HTML ni imagen remota. En el modo `qr`
  también sirve una URL `https` de tu mismo dominio registrable que el `appUrl` (esta app usa un QR EMVCo porque un túnel de
  desarrollo no comparte dominio con nada).
- **Rotación del secreto.** Mientras desplegás el secreto nuevo, definí `COMMERCY_WEBHOOK_SECRET_PREVIOUS`. Lo que te manda
  Commercy se firma con el secreto nuevo desde el momento de la rotación, y tus avisos se aceptan con cualquiera de los dos durante 72 horas.
- **Aviso en segundo plano.** El primer intento va en el momento; si falla por un `5xx`, un `429` o la red, se reintenta con
  espera creciente. Si el proceso cae a mitad de los reintentos se pierden; en producción usá una cola. Igual no se pierde
  el cobro: Commercy consulta el estado mientras el POS espera y su barrido sigue todo cobro que no terminó.

## Checklist de producción

- [ ] La firma se verifica sobre el **cuerpo crudo**, en tiempo constante, con ventana de 5 minutos, que `installation_id`
  coincida con el header, y se aceptan los dos secretos mientras rotás.
- [ ] Los montos van y vienen como **string con dos decimales**; `amount_paid` es el bruto cobrado.
- [ ] La creación es **idempotente por `payment_ref`** (72 h + vencimiento) y responde `idempotency_conflict` ante otro cuerpo.
- [ ] `status` resuelve por `payment_ref` aunque no haya `payment_id` y devuelve `payment_not_found` (**HTTP 404**), rechazando
  después la creación con `payment_ref_consumed`.
- [ ] `cancel` es idempotente por `cancel_ref` y devuelve `not_cancellable` si el cobro ya avanzó.
- [ ] El `display` cumple las validaciones: QR EMVCo con CRC sobre UTF-8 (o URL `https` de tu dominio), instrucciones de hasta
  280 caracteres, transferencia con CVU, alias y CUIT válidos.
- [ ] Tus errores son `4xx` con código del contrato cuando no se creó nada; ante la duda, `5xx`.
- [ ] Mandás `pos_payment.updated` con `Content-Type: application/json` y reintentás ante un `5xx` o `429` con espera creciente.
- [ ] **PCI.** Nunca recibas, loguees ni guardes datos de tarjeta en Commercy ni en esta app de ejemplo: `details.card_last4` son
  exactamente 4 dígitos, nunca el número. Commercy no guarda credenciales de tu procesador.
- [ ] **HTTPS** en todo y `apiBaseUrl` público.
- [ ] Declaraste el cobro presencial, pediste el permiso `pos_payments` y probaste el flujo completo en una sucursal de prueba.

## Documentación

- [Apps de cobro presencial](https://docs.commercy.com.ar/pos-payment-apps)
- [Apps de pago online](https://docs.commercy.com.ar/payment-apps) (el monto va como número; acá va como string)
- [Webhooks](https://docs.commercy.com.ar/webhooks)
- [Scopes y permisos](https://docs.commercy.com.ar/scopes)
