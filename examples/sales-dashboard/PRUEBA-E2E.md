# Guía de prueba end to end — app demo Commercy

Con la app corriendo (`npm run dev`) y el túnel de cloudflared activo:

```bash
cd examples/sales-dashboard
npm run dev

# En otra terminal:
cloudflared tunnel --url http://localhost:3000
```

Copiá la URL pública que imprime cloudflared y ponela en `.env` como `APP_BASE_URL`
(cambia cada vez que reiniciás cloudflared: si lo reiniciás, actualizá `APP_BASE_URL`
en `.env` y las URLs registradas en el portal).

## 1. Configuración en el portal de developers

En el portal de developers, con las credenciales de tu app:

- **Redirect URI a registrar**: `https://TU-TUNNEL.trycloudflare.com/callback`
- **Webhook URL a registrar**: `https://TU-TUNNEL.trycloudflare.com/webhooks/commercy`
- **Scopes** (los que usa esta app): `read_products read_orders read_stock` (`read_shops` viene siempre)

Desde el portal, mandá un **ping de prueba**: la app verifica el HMAC y responde
`200`. El log del server muestra `Webhook recibido: ping`.

## 2. Instalar en una tienda

Abrí en el navegador:

```
http://localhost:3000/install
```

La app genera el par PKCE, te manda a la pantalla de consentimiento de Commercy
y al aceptar canjea el `code` por tokens. Te muestra la tienda, el `installation_id`
y los scopes concedidos; los tokens quedan sólo en el servidor.

## 3. Probar la API

Con la instalación activa:

- `http://localhost:3000/api/store` — datos del comercio
- `http://localhost:3000/api/shops` — sucursales
- `http://localhost:3000/api/products` — productos
- `http://localhost:3000/api/orders` — ventas

Cada request usa el access token; si venció, la app lo renueva sola con el
refresh token rotativo y repite el request.

## 4. Probar webhooks reales

Generá actividad en la tienda instalada (crear un producto, una venta, etc.) y
mirá el log del server: cada evento aparece con su tipo y id. Enviá dos veces
el mismo evento (replay desde el portal) y verificá que el segundo se loguea
como `Duplicado ignorado`.

## 5. Desinstalar

Desinstalá la app desde el panel del comerciante: la app recibe
`app.uninstalled`, descarta los tokens y lo loguea.

## Script de verificación rápida (sin portal)

Con el server corriendo, podés probar la verificación de la firma sin pasar por
el portal:

```bash
# Desde examples/sales-dashboard, con el secreto de tu .env:
node ../../scripts/sign-request.mjs http://localhost:3000/webhooks/commercy whsec_TU_WEBHOOK_SECRET \
  '{"id":"evt_manual_1","type":"ping","created_at":"2026-10-25T12:00:00.000Z","store_id":null,"data":{"app_id":"app_test"}}'
# → HTTP 200. Con otro secreto → 401. El mismo id otra vez → 200 y "Duplicado ignorado".
```
