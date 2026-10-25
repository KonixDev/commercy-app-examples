# Dashboard de ventas para Commercy · app de ejemplo

App de ejemplo **completa y funcional** para la plataforma de apps de Commercy:
un dashboard de ventas server-rendered que muestra, de punta a punta, cómo
integrarse con la API pública, OAuth y webhooks.

## Qué hace

Un panel para comercios con:

- **KPIs**: ventas de hoy, últimos 7 días, ticket promedio, ventas pendientes,
  productos activos y alertas de stock bajo.
- **Gráfico de ventas por día** (7 días).
- **Top productos** por unidades vendidas y facturación.
- **Alertas de stock bajo** (disponible ≤ 5 unidades) por SKU.
- **Feed de webhooks en vivo** con contadores por tipo de evento.

Demo en vivo: instalá la app en tu tienda (o en una demo) y andá a `/dashboard`.

## Qué muestra de la plataforma

| Pieza | Dónde |
| - | - |
| OAuth 2.0 authorization code + PKCE (S256), cliente confidencial | `src/commercy.ts` → `buildAuthorizeUrl`, `exchangeCode` |
| Refresh token rotativo (un solo uso) con serialización de refreshes | `src/index.ts` → `withFreshToken` |
| API pública versionada por fecha, paginación por cursor e `updated_since` | `src/commercy.ts` → `CommercyClient` |
| Webhooks: verificación HMAC-SHA256 (`v1=`), tolerancia de 5 minutos, deduplicación por `X-Commercy-Event-Id` | `src/commercy.ts` → `verifyWebhookSignature`, `src/index.ts` |
| Los 4 webhooks obligatorios (`app.uninstalled`, `store.redact`, `customers.redact`, `customers.data_request`) | `src/index.ts` |
| Cache corto + invalidación por webhook (el webhook avisa, la API confirma) | `src/dashboard.ts` → `DashboardService` |
| Manejo de `403 insufficient_scope` con mensaje accionable | `src/index.ts` → `/dashboard` |
| Errores OAuth (RFC 6749) vs envelope de la API | `src/commercy.ts` |

La UI es server-rendered con template literals y CSS, **sin framework ni build**:
ideal para copiar y adaptar.

## Requisitos

- Node 20+
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (o ngrok) para exponer webhooks en local.

## Setup

```bash
npm install
cp .env.example .env
# Completá .env con las credenciales de tu app (portal de developers de Commercy)
```

| Variable | Qué es |
| - | - |
| `COMMERCY_CLIENT_ID` | El `app_...` de tu app (no es secreto). |
| `COMMERCY_CLIENT_SECRET` | El `cs_...` de tu app. Se muestra una sola vez en el portal. |
| `COMMERCY_WEBHOOK_SECRET` | El `whsec_...` del webhook, para verificar la firma. |
| `APP_BASE_URL` | La URL pública de esta app (la del túnel). Tiene que coincidir EXACTO con la redirect URI registrada. |
| `PORT` | Puerto local, por defecto 3000. |
| `DASHBOARD_TOKEN` | Opcional. **Demo: protegelo antes de exponerlo.** Si está seteado, `/dashboard` y `/api/*` exigen `?token=...` o `Authorization: Bearer ...`; si no, quedan sin autenticación y el server loguea un warning al arrancar. |

## Correr

```bash
npm run dev        # terminal 1: la app en http://localhost:3000
cloudflared tunnel --url http://localhost:3000   # terminal 2: túnel público
```

Copiá la URL que imprime cloudflared (p. ej. `https://algo.trycloudflare.com`)
en `APP_BASE_URL` y en el portal:

1. **Redirect URI**: `https://algo.trycloudflare.com/callback`
2. **Webhook URL**: `https://algo.trycloudflare.com/webhooks/commercy`
3. Mandá un **ping de prueba** desde el portal: la app verifica el HMAC y responde `200`.

Después abrí `http://localhost:3000/install`, aceptá el consentimiento con el
usuario dueño de la tienda, y el dashboard queda en `http://localhost:3000/dashboard`.

## Endpoints

| Ruta | Qué hace |
| - | - |
| `GET /install` | Arranca el flujo OAuth (genera PKCE + state). |
| `GET /callback` | Canjea el `code` por tokens y guarda la instalación. |
| `GET /dashboard` | El panel de ventas. |
| `GET /api/store` · `/api/shops` · `/api/products` · `/api/orders` | Proxies de ejemplo a la API pública. |
| `POST /webhooks/commercy` | Receptor de webhooks: firma + dedupe + 4 obligatorios. |

## Scopes que usa la app

```text
read_products read_orders read_stock
```

Son sólo los que la app lee (productos, ventas y stock). `read_shops` está siempre incluido.
Pedí únicamente los scopes que tu app usa: cada scope extra se revisa en la homologación. La app degrada con gusto: si falta un scope,
el dashboard muestra qué falta y cómo pedirlo.

## Notas de implementación

- El estado (instalación activa y tokens) se guarda **en memoria**: es un
  ejemplo. En producción guardá los tokens cifrados en tu base.
- El refresh es **rotativo**: cada refresh token se usa una vez y el nuevo
  reemplaza al anterior. Si dos procesos refrescan a la vez, Commercy tiene una
  ventana de gracia de 10 segundos; igualmente esta app serializa los refreshes.
- Si la API responde `401`, la app renueva el token y repite el request una vez.
- La verificación de la firma exige leer el **cuerpo crudo**: el parser
  `express.raw` del webhook va antes del parser JSON global. Si el body llega
  re-serializado, la firma no coincide (error clásico).
- Los resultados del dashboard se cachean 60 s y se invalidan al llegar un
  webhook, para no golpear la API en cada refresh.

## Documentación

- [Primeros pasos](https://docs.commercy.com.ar/quickstart.md)
- [Autenticación OAuth](https://docs.commercy.com.ar/oauth.md)
- [Referencia de la API](https://docs.commercy.com.ar/api-reference.md)
- [Webhooks](https://docs.commercy.com.ar/webhooks.md)
- [Scopes y permisos](https://docs.commercy.com.ar/scopes.md)

---

Commercy no cobra comisión por las apps (0 %) y todo lo que probás en borrador
funciona en tu propia tienda y en tus tiendas demo, sin plan pago.
