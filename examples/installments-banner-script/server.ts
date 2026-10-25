// Sirve dist/ como lo exige Commercy para un script de tienda:
//   - 200 directo, sin redirects
//   - Access-Control-Allow-Origin: *   (la tienda lo carga con crossorigin="anonymous")
//   - Content-Type: text/javascript
//   - URL versionada + Cache-Control inmutable (el contenido de una URL nunca cambia)
//
//   npm run serve
//   cloudflared tunnel --url http://localhost:8788
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';

try {
  process.loadEnvFile('.env');
} catch {
  // Sin .env: usa el entorno.
}

const PORT = Number(process.env.PORT) || 8788;
const dist = resolve('dist');
const testPage = resolve('test.html');

const app = express();
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Página de prueba local (ver README). No forma parte del script publicado.
app.get('/test.html', (_req, res) => {
  res.sendFile(testPage);
});

app.use(
  express.static(dist, {
    index: false,
    redirect: false, // un redirect rompe la verificación SRI
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        // manifest.json lo usa test.html: ese sí cambia en cada build.
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

if (!existsSync(dist)) console.warn('No existe dist/. Corré `npm run build` primero.');

app.listen(PORT, () => {
  console.log(`Sirviendo ${dist} en http://localhost:${PORT}`);
  console.log(`Página de prueba:    http://localhost:${PORT}/test.html`);
});
