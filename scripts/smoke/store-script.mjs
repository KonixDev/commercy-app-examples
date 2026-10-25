// npm run smoke (scripts de tienda: whatsapp-widget-script, installments-banner-script).
// Compila con `npm run build`-equivalente, verifica que el hash SRI de dist/ coincida con el del
// manifest (calculado por scripts/sri.mjs, que es la herramienta que documenta el README) y que el
// server de ejemplo sirva el archivo como exige la revisión de Commercy.
//
//   node ../../scripts/smoke/store-script.mjs <nombre-del-ejemplo>
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { REPO, assert, exampleDir, freePort, request, run } from "./lib.mjs";

const example = process.argv[2];
if (!example) {
  console.error("Uso: node scripts/smoke/store-script.mjs <ejemplo>");
  process.exit(2);
}

await run(example, async (t) => {
  const dir = exampleDir(example);
  const sri = (target) => {
    const r = spawnSync(process.execPath, [path.join(REPO, "scripts", "sri.mjs"), target], { cwd: dir, encoding: "utf8" });
    return { code: r.status, hash: r.stdout.trim(), stderr: r.stderr };
  };
  let manifest;
  let file;

  await t.step("build: genera dist/<archivo>.js y dist/manifest.json", async () => {
    const tsx = path.join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    const r = spawnSync(process.execPath, [tsx, "build.ts"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, `build falló:\n${r.stdout}\n${r.stderr}`);
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "dist", "manifest.json"), "utf8"));
    file = path.join("dist", manifest.file);
    assert.ok(fs.existsSync(path.join(dir, file)), `no existe ${file}`);
  });

  await t.step("el archivo está versionado (<handle>.v<version>.js) y la versión es la de package.json", async () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.equal(manifest.version, version);
    assert.match(manifest.file, new RegExp(`\\.v${version.replaceAll(".", "\\.")}\\.js$`));
    assert.ok(manifest.src.endsWith(`/${manifest.file}`), "manifest.src no apunta al archivo");
  });

  await t.step("scripts/sri.mjs sobre dist/ coincide con el hash del manifest y con sha384 calculado aparte", async () => {
    const r = sri(file);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.hash, /^sha384-[A-Za-z0-9+/]+=*$/);
    assert.equal(r.hash, manifest.integrity);
    const independent = "sha384-" + crypto.createHash("sha384").update(fs.readFileSync(path.join(dir, file))).digest("base64");
    assert.equal(r.hash, independent);
  });

  await t.step("el bundle es JavaScript válido y pesa menos de 256 KB", async () => {
    const code = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(Buffer.byteLength(code) < 256 * 1024);
    new vm.Script(code, { filename: manifest.file }); // sólo parsea, no ejecuta
  });

  const port = await freePort();
  await t.startApp({ example, entry: "server.ts", port, env: { PORT: String(port) } });
  const base = `http://127.0.0.1:${port}`;

  await t.step("server de ejemplo: 200 directo, CORS *, text/javascript, caché inmutable", async () => {
    const res = await request(`${base}/${manifest.file}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("content-type"), /^text\/javascript/);
    assert.match(res.headers.get("cache-control"), /immutable/);
  });

  await t.step("scripts/sri.mjs sobre la URL servida: sin avisos, mismo hash", async () => {
    const r = sri(`${base}/${manifest.file}`);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.hash, manifest.integrity);
  });

  await t.step("test.html se sirve; un archivo inexistente es 404 (sin redirects)", async () => {
    assert.equal((await request(`${base}/test.html`)).status, 200);
    assert.equal((await request(`${base}/no-existe.v9.js`)).status, 404);
  });
});
