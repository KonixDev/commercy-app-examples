// Genera dist/whatsapp-widget.v<version>.js (URL versionada), calcula el hash SRI
// y deja listo el bloque JSON para la pestaña «Scripts» del portal de developers.
//
//   npm run build
//
// La configuración (número, mensajes, lado) se lee de `.env` o del entorno y queda
// "horneada" dentro del archivo: cambiar un valor = archivo nuevo + hash nuevo.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

try {
  process.loadEnvFile('.env');
} catch {
  // Sin .env: se usa el entorno y los valores por defecto.
}

const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

const number = env('WHATSAPP_NUMBER', '5491112345678');
const message = env('WHATSAPP_MESSAGE', 'Hola {store}! Quería hacerles una consulta.');
const messageProduct = env('WHATSAPP_MESSAGE_PRODUCT', 'Hola {store}! Quería consultar por {product}.');
const position = env('WIDGET_POSITION', 'right');
const baseUrl = env('SCRIPT_BASE_URL', 'https://cdn.tuapp.com').replace(/\/+$/, '');

if (!/^\d{10,15}$/.test(number)) {
  throw new Error(`WHATSAPP_NUMBER inválido ("${number}"): sólo dígitos, formato internacional, sin "+". Ej. 5491112345678`);
}
if (position !== 'left' && position !== 'right') {
  throw new Error(`WIDGET_POSITION inválido ("${position}"): usá "left" o "right".`);
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const fileName = `whatsapp-widget.v${version}.js`;

const result = await build({
  entryPoints: ['src/widget.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2018',
  minify: true,
  legalComments: 'none',
  write: false,
  define: {
    '__CONFIG__.number': JSON.stringify(number),
    '__CONFIG__.message': JSON.stringify(message),
    '__CONFIG__.messageProduct': JSON.stringify(messageProduct),
    '__CONFIG__.position': JSON.stringify(position),
  },
});

const output = result.outputFiles[0];
if (!output) throw new Error('esbuild no generó salida');
const code = output.contents;

mkdirSync('dist', { recursive: true });

const outPath = `dist/${fileName}`;
if (existsSync(outPath) && !readFileSync(outPath).equals(code)) {
  console.warn(
    `⚠ ${outPath} ya existía con OTRO contenido: su hash cambió. Si esa versión ya está declarada o aprobada en el portal,\n` +
      '  no la pises (las tiendas dejarían de cargarla): subí "version" en package.json y generá un archivo nuevo.\n',
  );
}
writeFileSync(`dist/${fileName}`, code);

const integrity = `sha384-${createHash('sha384').update(code).digest('base64')}`;
const script = {
  handle: 'whatsapp-widget',
  name: 'Botón de WhatsApp',
  src: `${baseUrl}/${fileName}`,
  integrity,
  loading: 'interaction',
  consent: 'necessary',
};
writeFileSync('dist/manifest.json', JSON.stringify({ version, file: fileName, ...script }, null, 2) + '\n');

console.log(`OK  dist/${fileName}  (${(code.byteLength / 1024).toFixed(1)} KB)`);
console.log(`SRI ${integrity}\n`);
console.log('Bloque para la pestaña «Scripts» del portal (o para storefrontScripts[] en la API):\n');
console.log(JSON.stringify(script, null, 2));
if (baseUrl === 'https://cdn.tuapp.com') {
  console.log('\nOjo: SCRIPT_BASE_URL es el valor de ejemplo. Poné la URL pública real donde servís dist/.');
}
