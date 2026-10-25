// Genera dist/installments-banner.v<version>.js (URL versionada), calcula el hash SRI
// y deja listo el bloque JSON para la pestaña «Scripts» del portal de developers.
//
//   npm run build
//
// La configuración (cuotas, compra mínima, ancla) se lee de `.env` o del entorno y queda
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

const installments = Number(env('INSTALLMENTS_COUNT', '6'));
const minAmount = Number(env('INSTALLMENTS_MIN_AMOUNT', '20000'));
const anchor = env('BANNER_ANCHOR', '');
const position = env('BANNER_POSITION', 'left');
const mobileBottomOffset = Number(env('MOBILE_BOTTOM_OFFSET', '72'));
const baseUrl = env('SCRIPT_BASE_URL', 'https://cdn.tuapp.com').replace(/\/+$/, '');

if (!Number.isInteger(installments) || installments < 2 || installments > 48) {
  throw new Error(`INSTALLMENTS_COUNT inválido ("${installments}"): un entero entre 2 y 48.`);
}
if (!Number.isFinite(minAmount) || minAmount < 0) {
  throw new Error(`INSTALLMENTS_MIN_AMOUNT inválido ("${minAmount}"): un número >= 0.`);
}
if (position !== 'left' && position !== 'right') {
  throw new Error(`BANNER_POSITION inválido ("${position}"): usá "left" o "right".`);
}
if (!Number.isInteger(mobileBottomOffset) || mobileBottomOffset < 0 || mobileBottomOffset > 300) {
  throw new Error(`MOBILE_BOTTOM_OFFSET inválido ("${mobileBottomOffset}"): un entero de píxeles entre 0 y 300.`);
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const fileName = `installments-banner.v${version}.js`;

const result = await build({
  entryPoints: ['src/banner.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2018',
  minify: true,
  legalComments: 'none',
  write: false,
  define: {
    '__CONFIG__.installments': JSON.stringify(installments),
    '__CONFIG__.minAmount': JSON.stringify(minAmount),
    '__CONFIG__.anchor': JSON.stringify(anchor),
    '__CONFIG__.position': JSON.stringify(position),
    '__CONFIG__.mobileBottomOffset': JSON.stringify(mobileBottomOffset),
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
  handle: 'installments-banner',
  name: 'Banner de cuotas',
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
