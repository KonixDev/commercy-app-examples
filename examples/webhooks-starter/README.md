# Webhooks starter para Commercy

El receptor de webhooks **mínimo y correcto**, en un solo archivo (`src/index.ts`).
Es el punto de partida para cualquier integración: copiá el archivo y reemplazá
los handlers por tu lógica.

## Qué hace bien (y por qué)

| Qué | Por qué |
| - | - |
| Lee el **cuerpo crudo** (`express.raw` sólo en la ruta del webhook) | La firma se calcula sobre los bytes originales; si parseás y re-serializás, no coincide. |
| Verifica `v1=HMAC-SHA256(secreto, "<timestamp>.<cuerpo>")` con `timingSafeEqual` | Comparación en tiempo constante. |
| Rechaza timestamps a más de 5 minutos de tu reloj | Protección contra replay. |
| Deduplica por `X-Commercy-Event-Id` (después de autenticar) | La entrega es "al menos una vez". |
| Responde `200` enseguida y procesa después | Commercy espera 5 segundos como máximo. |
| Handlers de los 4 obligatorios: `app.uninstalled`, `store.redact`, `customers.redact`, `customers.data_request` | Se entregan siempre y sin ellos no podés publicar la app. |
| Un evento de negocio de ejemplo: `stock.changed` (avisa si queda stock bajo) | Muestra el patrón para cualquier otro evento. |

Los handlers sólo **loguean**; hacer algo real con cada evento (borrar datos,
guardar la orden, etc.) es tu parte.

## Setup

```bash
cp .env.example .env     # pegá tu secreto de webhook (portal → tu app → Webhooks)
npm install
npm run dev
```

Verificá tipos con `npm run typecheck`.

## Probarlo con tu cuenta de developer

Commercy sólo llama a URLs `https` públicas, así que exponé el puerto local con un túnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

1. Copiá la URL que imprime (p. ej. `https://algo.trycloudflare.com`).
2. En el portal de developers, cargá como **Webhook URL**
   `https://algo.trycloudflare.com/webhooks/commercy` y suscribite a los eventos que quieras
   (para `stock.changed` hace falta el scope `read_stock`).
3. Mandá un **ping de prueba** desde el portal: tenés que ver `[ping] ok` en la consola.

## Probarlo en local, sin túnel

`scripts/sign-request.mjs` firma un request igual que Commercy y lo manda a tu servidor:

```bash
# Evento válido -> 200 y se loguea
node ../../scripts/sign-request.mjs http://localhost:3000/webhooks/commercy whsec_TU_SECRETO \
  '{"id":"evt_1","type":"stock.changed","created_at":"2026-10-25T12:00:00.000Z","store_id":"6710b3c2e4a1f20012ab34ce","data":{"sku":"REM-001","available":3}}'

# El mismo comando otra vez -> 200 pero "ya procesado" (misma id de evento)
# Con otro secreto -> 401 (firma inválida)
```

Con `--print` sólo imprime los headers y un `curl` equivalente.

## Antes de ir a producción

- Guardá los ids de eventos vistos en tu base o en Redis con TTL (acá es un `Map` en memoria y
  se pierde al reiniciar). Los reintentos de Commercy duran unas 44 horas.
- Guardá el evento en una cola y procesalo en un worker, en vez de `setImmediate`.
- Los eventos no vienen en orden: guiate por el estado que trae `data`, y si necesitás el estado
  exacto, pedilo por la API.

Más en la [documentación de webhooks](https://docs.commercy.com.ar/webhooks.md).
