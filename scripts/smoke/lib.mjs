// Helpers compartidos por los `npm run smoke` de cada ejemplo. Sin dependencias, Node >= 20.12.
//
// Un smoke levanta el server del ejemplo de verdad (con tsx), le habla por HTTP y lo apaga.
// La firma es la de scripts/sign-request.mjs:
//   X-Commercy-Signature = "v1=" + HMAC-SHA256(secreto, "<X-Commercy-Timestamp>.<cuerpo crudo>") en hex
// Los casos "felices" pasan por el propio sign-request.mjs (así también se prueba la herramienta);
// los negativos (firma mala, timestamp viejo, cuerpo alterado) los arma `buildRequest`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { assert };

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const exampleDir = (name) => path.join(REPO, "examples", name);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

/** Secreto de prueba con el formato real (`whsec_…`), distinto en cada corrida. */
export const randomSecret = () => "whsec_smoke_" + crypto.randomBytes(16).toString("hex");

/** Puerto propio: SMOKE_PORT (para fijarlo a mano) o uno libre que pide el SO. */
export function freePort() {
  if (process.env.SMOKE_PORT) return Promise.resolve(Number(process.env.SMOKE_PORT));
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── Firma ──────────────────────────────────────────────────────────────────

const hmac = (secret, timestamp, raw) =>
  "v1=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");

/**
 * Arma headers + cuerpo crudo de un request firmado.
 * Opciones: style ("app" | "webhook"), ts (timestamp en segundos), secret (para firmar con otro),
 * unsigned (sin headers de firma), installation (pisa X-Commercy-Installation).
 */
export function buildRequest(body, secret, o = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  let parsed = {};
  try {
    parsed = JSON.parse(raw); // un cuerpo roto se firma igual (para probar el 400 posterior a la firma)
  } catch {
    /* sigue */
  }
  const timestamp = String(o.ts ?? nowSec());
  const headers = { "Content-Type": "application/json" };
  if (!o.unsigned) {
    headers["X-Commercy-Timestamp"] = timestamp;
    headers["X-Commercy-Signature"] = hmac(o.secret ?? secret, timestamp, raw);
  }
  if ((o.style ?? "app") === "webhook") {
    headers["X-Commercy-Event"] = parsed.type ?? "unknown";
    headers["X-Commercy-Event-Id"] = parsed.id ?? `evt_smoke_${crypto.randomUUID()}`;
    headers["X-Commercy-Delivery"] = `dlv_smoke_${crypto.randomUUID()}`;
    if (parsed.store_id) headers["X-Commercy-Store"] = parsed.store_id;
  } else if (parsed.installation_id || o.installation) {
    headers["X-Commercy-Installation"] = o.installation ?? parsed.installation_id;
  }
  return { headers, raw };
}

/** fetch sin seguir redirects: devuelve { status, headers, text, json }. */
export async function request(url, init = {}) {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), ...init });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** POST firmado construido en proceso. `o.sendBody` envía otro cuerpo del que se firmó (cuerpo alterado). */
export function postSigned(url, body, secret, o = {}) {
  const { headers, raw } = buildRequest(body, secret, o);
  return request(url, { method: "POST", headers, body: o.sendBody ?? raw });
}

/** POST firmado pasando por scripts/sign-request.mjs (la herramienta que documenta el README). */
export function postViaCli(url, body, secret, style = "app") {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const r = spawnSync(
    process.execPath,
    [path.join(REPO, "scripts", "sign-request.mjs"), url, secret, raw, `--header-style=${style}`],
    { encoding: "utf8", timeout: 15_000 },
  );
  const match = /^HTTP (\d+)/.exec(r.stdout ?? "");
  if (!match) throw new Error(`sign-request.mjs no respondió: ${r.stdout} ${r.stderr}`);
  const text = (r.stdout ?? "").split("\n").slice(1).join("\n").trim();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: Number(match[1]), text, json };
}

/** Los rechazos que tiene que dar CUALQUIER endpoint firmado (todos deben ser 401). */
export async function expectRejected(t, url, body, secret, o = {}) {
  const send = (extra) => postSigned(url, body, secret, { ...o, ...extra });
  const at = new URL(url).pathname;
  await t.step(`${at}: firma inválida (secreto equivocado) → 401`, async () => {
    assert.equal((await send({ secret: "whsec_otro_secreto" })).status, 401);
  });
  await t.step(`${at}: cuerpo alterado después de firmar → 401`, async () => {
    const tampered = JSON.stringify({ ...JSON.parse(typeof body === "string" ? body : JSON.stringify(body)), tampered: true });
    assert.equal((await send({ sendBody: tampered })).status, 401);
  });
  await t.step(`${at}: timestamp viejo (1 h) con firma correcta → 401`, async () => {
    assert.equal((await send({ ts: nowSec() - 3600 })).status, 401);
  });
  await t.step(`${at}: sin headers de firma → 401`, async () => {
    assert.equal((await send({ unsigned: true })).status, 401);
  });
}

// ── Server del ejemplo ─────────────────────────────────────────────────────

// Variables que un shell de desarrollo podría traer y pisarían al .env de prueba.
const SCRUB = /^(COMMERCY_|APP_BASE_URL$|PORT$|DATA_FILE$|DASHBOARD_TOKEN$|DOTENV_)/;

const live = new Set();
function killGroup(child, signal) {
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    /* ya terminó */
  }
}
process.on("exit", () => live.forEach((c) => killGroup(c, "SIGKILL")));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

/**
 * Levanta `tsx <entry>` del ejemplo.
 *  - `dotenv`: genera un .env de prueba en un directorio temporal y lo apunta con DOTENV_CONFIG_PATH
 *    (no toca el .env del desarrollador). El server corre con ese directorio como cwd, así que el
 *    `.data/` que escriba también queda ahí y se borra al terminar.
 *  - sin `dotenv`: el server corre en el directorio del ejemplo (los servers de scripts de tienda
 *    leen `dist/` y `test.html` relativos al cwd) y recibe `env` por el entorno.
 */
export async function startApp({ example, entry = "src/index.ts", port, dotenv, env = {} }) {
  const dir = exampleDir(example);
  const tsx = path.join(dir, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsx)) throw new Error(`Falta node_modules en ${dir}: corré \`npm ci\` primero.`);

  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.test(k)));
  let cwd = dir;
  let tmp = null;
  if (dotenv) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), `commercy-smoke-${example}-`));
    const file = path.join(tmp, ".env");
    fs.writeFileSync(file, Object.entries({ PORT: port, ...dotenv }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    childEnv.DOTENV_CONFIG_PATH = file;
    cwd = tmp;
  }
  Object.assign(childEnv, env);

  const child = spawn(
    process.execPath,
    [tsx, "--tsconfig", path.join(dir, "tsconfig.json"), path.join(dir, entry)],
    { cwd, env: childEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
  );
  live.add(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => (output += d));
  let exited = null;
  const exitPromise = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      live.delete(child);
      resolve();
    }),
  );

  const base = `http://127.0.0.1:${port}`;
  const app = {
    base,
    logs: () => output,
    count: (re) => (output.match(new RegExp(re.source, "g")) ?? []).length,
    async waitForLog(re, ms = 5_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (re.test(output)) return;
        await sleep(25);
      }
      throw new Error(`El server no logueó ${re} en ${ms} ms.\n--- logs ---\n${output}`);
    },
    async stop() {
      if (!exited) {
        killGroup(child, "SIGTERM");
        await Promise.race([exitPromise, sleep(3_000)]);
        if (!exited) killGroup(child, "SIGKILL");
        await Promise.race([exitPromise, sleep(2_000)]);
      }
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    },
  };

  // Espera a que responda HTTP (cualquier status) o a que muera.
  const end = Date.now() + 30_000;
  for (;;) {
    if (exited) {
      await app.stop();
      throw new Error(`El server terminó al arrancar (code ${exited.code}).\n--- logs ---\n${output}`);
    }
    try {
      await fetch(`${base}/`, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
      return app;
    } catch {
      if (Date.now() > end) {
        await app.stop();
        throw new Error(`El server no levantó en 30 s.\n--- logs ---\n${output}`);
      }
      await sleep(100);
    }
  }
}

/** Stub de la API de Commercy: registra lo que le llega (lo usa payment-provider para su webhook de salida). */
export async function startStub(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const call = { method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks).toString("utf8") };
      calls.push(call);
      const status = handler ? handler(call) : 200;
      res.statusCode = status;
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    async waitForCalls(n, ms = 5_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (calls.length >= n) return;
        await sleep(25);
      }
      throw new Error(`El stub esperaba ${n} llamada(s) y recibió ${calls.length}.`);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Verifica la firma de un request que le llegó al stub (mismo esquema, ventana de 5 min). */
export function stubSignatureOk(call, secret) {
  const ts = call.headers["x-commercy-timestamp"];
  const sig = call.headers["x-commercy-signature"];
  return (
    /^\d+$/.test(ts ?? "") && Math.abs(nowSec() - Number(ts)) <= 300 && sig === hmac(secret, ts, call.raw)
  );
}

// ── Runner ─────────────────────────────────────────────────────────────────

/**
 * run("nombre", async (t) => { await t.step("qué se prueba", async () => { ...asserts... }); })
 * Corre todos los pasos aunque alguno falle, apaga lo que se haya levantado y sale con 1 si algo falló.
 */
export async function run(name, body) {
  const cleanups = [];
  const failures = [];
  let steps = 0;
  const t = {
    onCleanup: (fn) => cleanups.push(fn),
    async startApp(opts) {
      const app = await startApp(opts);
      cleanups.push(() => app.stop());
      t.lastApp = app;
      return app;
    },
    async startStub(handler) {
      const stub = await startStub(handler);
      cleanups.push(() => stub.close());
      return stub;
    },
    async step(title, fn) {
      steps += 1;
      try {
        await fn();
        console.log(`  ok   ${title}`);
      } catch (err) {
        failures.push(title);
        console.log(`  FAIL ${title}\n       ${String(err?.message ?? err).split("\n").join("\n       ")}`);
        if (t.lastApp) console.log(`       --- logs del server ---\n${t.lastApp.logs().trimEnd().split("\n").map((l) => "       " + l).join("\n")}`);
      }
    },
  };

  const hardTimeout = setTimeout(() => {
    console.error(`smoke ${name}: timeout global de 120 s`);
    process.exit(1);
  }, 120_000);
  hardTimeout.unref();

  console.log(`smoke ${name}`);
  try {
    await body(t);
  } catch (err) {
    failures.push("setup");
    console.log(`  FAIL ${String(err?.message ?? err)}`);
  } finally {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  }
  console.log(failures.length ? `smoke ${name}: ${failures.length} fallo(s) de ${steps} pasos` : `smoke ${name}: ${steps} pasos OK`);
  process.exit(failures.length ? 1 : 0);
}
