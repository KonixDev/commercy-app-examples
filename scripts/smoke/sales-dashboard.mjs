// npm run smoke (examples/sales-dashboard). El ejemplo depende de OAuth contra Commercy, que no se
// puede hacer en CI: el smoke cubre lo que no lo necesita (webhook firmado + deduplicación, el inicio
// del flujo OAuth y el comportamiento de /dashboard y /api/* sin instalación, con y sin DASHBOARD_TOKEN).
import { assert, expectRejected, freePort, postSigned, postViaCli, randomSecret, request, run } from "./lib.mjs";

const baseEnv = (port, secret) => ({
  COMMERCY_CLIENT_ID: "app_smoke",
  COMMERCY_CLIENT_SECRET: "cs_smoke",
  COMMERCY_WEBHOOK_SECRET: secret,
  APP_BASE_URL: `http://127.0.0.1:${port}`,
});

await run("sales-dashboard", async (t) => {
  const secret = randomSecret();
  const token = "tok_smoke_" + Math.random().toString(36).slice(2);

  // ── Con DASHBOARD_TOKEN ──────────────────────────────────────────────────
  const port = await freePort();
  const app = await t.startApp({
    example: "sales-dashboard",
    port,
    dotenv: { ...baseEnv(port, secret), DASHBOARD_TOKEN: token },
  });
  const url = `${app.base}/webhooks/commercy`;
  const event = (id, type, data = {}) => ({ id, type, created_at: new Date().toISOString(), store_id: "store_smoke", data });

  await t.step("GET / sin instalación muestra el botón de instalar (200)", async () => {
    const res = await request(`${app.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/install"/);
  });

  await t.step("GET /install redirige a authorize con PKCE S256 y state", async () => {
    const res = await request(`${app.base}/install`);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.pathname, "/oauth/apps/authorize");
    assert.equal(loc.searchParams.get("client_id"), "app_smoke");
    assert.equal(loc.searchParams.get("redirect_uri"), `${app.base}/callback`);
    assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
    assert.ok(loc.searchParams.get("code_challenge"));
    assert.ok(loc.searchParams.get("state"));
  });

  await t.step("GET /callback con state inválido → 400", async () => {
    assert.equal((await request(`${app.base}/callback?code=x&state=nope`)).status, 400);
  });

  await t.step("/dashboard y /api/* sin token → 401; con token malo → 401", async () => {
    for (const p of ["/dashboard", "/api/store", "/dashboard?token=malo", "/api/orders?token=malo"]) {
      assert.equal((await request(`${app.base}${p}`)).status, 401, p);
    }
    const bad = await request(`${app.base}/dashboard`, { headers: { Authorization: "Bearer malo" } });
    assert.equal(bad.status, 401);
  });

  await t.step("con token correcto (query o Bearer) pasa la barrera y, sin instalación, manda a /install", async () => {
    const q = await request(`${app.base}/dashboard?token=${token}`);
    assert.equal(q.status, 302);
    assert.equal(q.headers.get("location"), "/install");
    const b = await request(`${app.base}/api/store`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(b.status, 302);
    assert.equal(b.headers.get("location"), "/install");
  });

  await t.step("webhook firmado válido (vía sign-request.mjs) → 200 y se recibe", async () => {
    const res = postViaCli(url, event("evt_order_1", "order.created", { id: "o1" }), secret, "webhook");
    assert.equal(res.status, 200);
    await app.waitForLog(/Webhook recibido: order\.created \(store store_smoke\)/);
  });

  await t.step("el mismo evento se deduplica: 200 y 'Duplicado ignorado'", async () => {
    const res = await postSigned(url, event("evt_order_1", "order.created", { id: "o1" }), secret, { style: "webhook" });
    assert.equal(res.status, 200);
    await app.waitForLog(/Duplicado ignorado: evt_order_1/);
    assert.equal(app.count(/Webhook recibido: order\.created/), 1);
  });

  await t.step("los 4 obligatorios responden 200", async () => {
    for (const type of ["app.uninstalled", "store.redact", "customers.redact", "customers.data_request"]) {
      const res = await postSigned(url, event(`evt_${type}`, type, {}), secret, { style: "webhook" });
      assert.equal(res.status, 200, type);
      await app.waitForLog(new RegExp(`Webhook recibido: ${type.replace(".", "\\.")}`));
    }
  });

  await expectRejected(t, url, event("evt_bad_1", "order.created", { id: "o2" }), secret, { style: "webhook" });

  await t.step("firmado válido pero JSON roto → 400", async () => {
    assert.equal((await postSigned(url, "{no es json", secret, { style: "webhook" })).status, 400);
  });

  await app.stop();

  // ── Sin DASHBOARD_TOKEN (queda abierto, con aviso) ───────────────────────
  const port2 = await freePort();
  const open = await t.startApp({ example: "sales-dashboard", port: port2, dotenv: baseEnv(port2, secret) });

  await t.step("sin DASHBOARD_TOKEN el server avisa y /dashboard responde sin pedir token (→ /install)", async () => {
    assert.match(open.logs(), /DASHBOARD_TOKEN no está seteado/);
    const res = await request(`${open.base}/dashboard`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/install");
  });
});
