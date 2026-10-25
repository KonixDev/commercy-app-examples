#!/usr/bin/env node
// Calcula el hash SRI (sha384) de un script de tienda de Commercy.
//
//   node scripts/sri.mjs dist/widget.v1.0.0.js
//   node scripts/sri.mjs https://cdn.tuapp.com/widget.v1.0.0.js
//
// - Archivo local: imprime `sha384-<base64>`.
// - URL: además chequea lo que el navegador y la revisión de Commercy exigen:
//   respuesta 200 directa (sin redirects), `Access-Control-Allow-Origin` y
//   `Content-Type: text/javascript`. Si algo falla, avisa por stderr y sale con
//   código 1 (el hash igual se imprime cuando se puede calcular).
//
// Sin dependencias. Node >= 20.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const MAX_SUGGESTED_BYTES = 256 * 1024;

const target = process.argv[2];
if (!target || target === '-h' || target === '--help') {
  console.error('Uso: node scripts/sri.mjs <archivo|URL>');
  process.exit(target ? 0 : 2);
}

/** @param {Uint8Array} bytes */
const sri = (bytes) => `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

/** @type {string[]} */
const warnings = [];
const warn = (msg) => warnings.push(msg);
/** @type {string[]} */
const notes = [];

/** @param {string} value */
const isHttpUrl = (value) => /^https?:\/\//i.test(value);

async function fromFile(path) {
  return new Uint8Array(await readFile(path));
}

async function fromUrl(rawUrl) {
  const url = new URL(rawUrl);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocal) {
    warn('La URL no es https. Commercy sólo acepta http://localhost en borrador; para revisión y producción tiene que ser https.');
  }

  // `redirect: 'manual'` devuelve el 3xx tal cual (Node no lo sigue): así lo vemos.
  const res = await fetch(url, { redirect: 'manual', headers: { Origin: 'https://tienda-ejemplo.com' } });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    const where = location ? new URL(location, url).href : '(sin header Location)';
    console.error(
      `ERROR: la URL responde ${res.status} y redirige a ${where}.\n` +
        'Un redirect rompe la verificación SRI y la revisión lo rechaza. ' +
        `Servila con 200 directo (probá con la URL final: ${where}).`,
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`ERROR: la URL responde ${res.status} ${res.statusText}. Tiene que responder 200.`);
    process.exit(1);
  }

  const acao = res.headers.get('access-control-allow-origin');
  if (!acao) {
    warn(
      'Falta el header Access-Control-Allow-Origin. Cargamos el script con crossorigin="anonymous": ' +
        'sin CORS el navegador no lo ejecuta. Agregá `Access-Control-Allow-Origin: *`.',
    );
  } else if (acao !== '*') {
    warn(`Access-Control-Allow-Origin es "${acao}". Tiene que ser "*": el script se carga desde el dominio de cada tienda.`);
  }

  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!/(text|application)\/(x-)?javascript/.test(type)) {
    warn(`Content-Type es "${type || 'vacío'}". Tiene que ser text/javascript.`);
  }

  if (!/[.-]v\d/i.test(url.pathname)) {
    warn('La URL no parece versionada (ej. widget.v1.0.0.js). Si pisás el archivo en la misma URL, todas las tiendas dejan de cargarlo hasta que apruebe la revisión.');
  }
  if (url.search) warn('La URL tiene query string. Usá una URL versionada por path, sin parámetros.');

  const cache = res.headers.get('cache-control');
  if (!cache || !/immutable|max-age=\d{5,}/.test(cache)) {
    notes.push('Cache-Control no es de larga duración. Recomendado: `public, max-age=31536000, immutable` (la URL es versionada).');
  }

  return new Uint8Array(await res.arrayBuffer());
}

let bytes;
try {
  bytes = isHttpUrl(target) ? await fromUrl(target) : await fromFile(target);
} catch (err) {
  console.error(`ERROR: no pude leer ${target}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

if (bytes.byteLength > MAX_SUGGESTED_BYTES) {
  warn(`El archivo pesa ${(bytes.byteLength / 1024).toFixed(1)} KB; lo sugerido es hasta 256 KB.`);
}

console.log(sri(bytes));
for (const n of notes) console.error(`AVISO: ${n}`);

if (warnings.length > 0) {
  for (const w of warnings) console.error(`ADVERTENCIA: ${w}`);
  process.exit(1);
}
if (isHttpUrl(target)) console.error('OK: 200 directo, con CORS y Content-Type de JavaScript.');
