// npm run smoke (examples/webhooks-starter): firma, ventana de tiempo, deduplicación y los 4 obligatorios.
import { assert, expectRejected, freePort, postSigned, postViaCli, randomSecret, request, run } from "./lib.mjs";

await run("webhooks-starter", async (t) => {
  const secret = randomSecret();
  const port = await freePort();
  const app = await t.startApp({
    example: "webhooks-starter",
    port,
    dotenv: { COMMERCY_WEBHOOK_SECRET: secret },
  });
  const url = `${app.base}/webhooks/commercy`;
  const event = (id, type, data = {}) => ({
    id,
    type,
    created_at: new Date().toISOString(),
    store_id: "store_smoke",
    data,
    meta: {},
  });

  await t.step("GET / responde 200", async () => {
    const res = await request(`${app.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.text, /commercy-webhooks-starter ok/);
  });

  await t.step("evento firmado válido (vía sign-request.mjs) → 200 y se procesa", async () => {
    const res = postViaCli(url, event("evt_ping_1", "ping", { app_id: "app_smoke" }), secret, "webhook");
    assert.equal(res.status, 200);
    await app.waitForLog(/\[ping\] ok, app app_smoke/);
  });

  await t.step("el mismo X-Commercy-Event-Id se deduplica: 200 y no se procesa de nuevo", async () => {
    const res = await postSigned(url, event("evt_ping_1", "ping", { app_id: "app_smoke" }), secret, { style: "webhook" });
    assert.equal(res.status, 200);
    await app.waitForLog(/\[dedupe\] evt_ping_1/);
    assert.equal(app.count(/\[ping\] ok/), 1);
  });

  await t.step("un evento sin handler responde 200 (se ignora)", async () => {
    const res = await postSigned(url, event("evt_unknown_1", "algo.nuevo"), secret, { style: "webhook" });
    assert.equal(res.status, 200);
    await app.waitForLog(/\[algo\.nuevo\] sin handler/);
  });

  await t.step("los 4 obligatorios + stock.changed llegan a su handler", async () => {
    const cases = [
      ["app.uninstalled", { installation_id: "inst_1" }, /\[app\.uninstalled\] tienda store_smoke/],
      ["store.redact", {}, /\[store\.redact\] borrar todos los datos de la tienda store_smoke/],
      ["customers.redact", { customer_id: "c1", email_hash: "h1" }, /\[customers\.redact\] cliente c1/],
      ["customers.data_request", { customer_id: "c2" }, /\[customers\.data_request\] cliente c2/],
      ["stock.changed", { sku: "SKU-1", available: 2 }, /\[stock\.changed\] stock bajo: SKU-1/],
    ];
    for (const [type, data, log] of cases) {
      const res = await postSigned(url, event(`evt_${type}`, type, data), secret, { style: "webhook" });
      assert.equal(res.status, 200, type);
      await app.waitForLog(log);
    }
  });

  await expectRejected(t, url, event("evt_bad_1", "ping", { app_id: "x" }), secret, { style: "webhook" });

  await t.step("un rechazo por firma NO quema el id: el mismo evento bien firmado se procesa", async () => {
    const body = event("evt_poison_1", "ping", { app_id: "app_poison" });
    assert.equal((await postSigned(url, body, secret, { style: "webhook", secret: "whsec_otro" })).status, 401);
    assert.equal((await postSigned(url, body, secret, { style: "webhook" })).status, 200);
    await app.waitForLog(/\[ping\] ok, app app_poison/);
  });

  await t.step("firmado válido pero JSON roto → 400", async () => {
    assert.equal((await postSigned(url, "{no es json", secret, { style: "webhook" })).status, 400);
  });
});
