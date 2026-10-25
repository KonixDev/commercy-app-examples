// npm run smoke (examples/shipping-carrier): cotizar, alta idempotente, cancelar, seguimiento y webhooks.
import { assert, expectRejected, freePort, postSigned, postViaCli, randomSecret, request, run } from "./lib.mjs";

await run("shipping-carrier", async (t) => {
  const secret = randomSecret();
  const port = await freePort();
  const app = await t.startApp({
    example: "shipping-carrier",
    port,
    dotenv: { COMMERCY_WEBHOOK_SECRET: secret, APP_BASE_URL: `http://127.0.0.1:${port}` },
  });
  const ctx = { installation_id: "inst_smoke", shop_id: "shop_smoke" };
  const quoteUrl = `${app.base}/commercy/shipping/quote`;
  const createUrl = `${app.base}/commercy/shipping/shipments`;
  const cancelUrl = `${app.base}/commercy/shipping/shipments/cancel`;
  const create = (key, orderId) => ({
    ...ctx,
    idempotency_key: key,
    method_id: "standard",
    order: { id: orderId, number: "1001" },
  });

  await t.step("cotizar (vía sign-request.mjs): CABA ofrece estándar y express con precio numérico", async () => {
    const res = postViaCli(quoteUrl, { ...ctx, postal_code: "1425", items: [{ quantity: 2, weight: { value: 400, unit: "g" } }] }, secret);
    assert.equal(res.status, 200);
    const ids = res.json.methods.map((m) => m.method_id);
    assert.deepEqual(ids, ["standard", "express"]);
    for (const m of res.json.methods) {
      assert.equal(typeof m.price, "number");
      assert.ok(m.price > 0);
      assert.ok(m.name);
    }
  });

  await t.step("cotizar al interior: sólo estándar; con items vacío no falla", async () => {
    const res = await postSigned(quoteUrl, { ...ctx, postal_code: "5000", items: [] }, secret);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.methods.map((m) => m.method_id), ["standard"]);
  });

  await t.step("cotizar con código postal inválido → 400 (firmado)", async () => {
    assert.equal((await postSigned(quoteUrl, { ...ctx, postal_code: "ABCD", items: [] }, secret)).status, 400);
  });

  await t.step("installation_id del cuerpo distinto al del header → 401", async () => {
    const res = await postSigned(quoteUrl, { ...ctx, postal_code: "1425" }, secret, { installation: "inst_otra" });
    assert.equal(res.status, 401);
  });

  await expectRejected(t, quoteUrl, { ...ctx, postal_code: "1425", items: [] }, secret);
  await expectRejected(t, createUrl, create("key_rej", "order_rej"), secret);

  let first;
  await t.step("alta de envío: devuelve code, tracking_number y tracking_url", async () => {
    const res = await postSigned(createUrl, create("key_1", "order_1"), secret);
    assert.equal(res.status, 200);
    first = res.json;
    assert.match(first.code, /^EE-\d{6}$/);
    assert.match(first.tracking_number, /^EE\d{6}AR$/);
    assert.equal(first.tracking_url, `${app.base}/seguimiento/${first.tracking_number}`);
  });

  await t.step("alta repetida con la misma idempotency_key devuelve el MISMO envío", async () => {
    const res = await postSigned(createUrl, create("key_1", "order_1"), secret);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, first);
  });

  await t.step("otra idempotency_key crea otro envío", async () => {
    const res = await postSigned(createUrl, create("key_2", "order_2"), secret);
    assert.equal(res.status, 200);
    assert.notEqual(res.json.code, first.code);
    assert.notEqual(res.json.tracking_number, first.tracking_number);
  });

  await t.step("alta sin idempotency_key u order.id → 400", async () => {
    assert.equal((await postSigned(createUrl, { ...ctx, order: { id: "o" } }, secret)).status, 400);
    assert.equal((await postSigned(createUrl, { ...ctx, idempotency_key: "k" }, secret)).status, 400);
  });

  await t.step("el seguimiento público muestra 'Envío creado'; uno inexistente es 404", async () => {
    const ok = await request(first.tracking_url);
    assert.equal(ok.status, 200);
    assert.match(ok.text, /Envío creado/);
    assert.equal((await request(`${app.base}/seguimiento/EE999999AR`)).status, 404);
  });

  await t.step("cancelar es idempotente; un code inexistente es 404", async () => {
    const body = { ...ctx, code: first.code };
    assert.deepEqual((await postSigned(cancelUrl, body, secret)).json, { canceled: true });
    assert.deepEqual((await postSigned(cancelUrl, body, secret)).json, { canceled: true });
    assert.match((await request(first.tracking_url)).text, /Cancelado/);
    assert.equal((await postSigned(cancelUrl, { ...ctx, code: "EE-000000" }, secret)).status, 404);
  });

  // ── Webhooks ───────────────────────────────────────────────────────────────
  const hook = `${app.base}/webhooks/commercy`;
  const event = (id, type, data) => ({ id, type, created_at: new Date().toISOString(), store_id: "store_smoke", data });

  await t.step("webhook order.cancelled cancela los envíos de esa venta; el duplicado se ignora", async () => {
    const second = (await postSigned(createUrl, create("key_2", "order_2"), secret)).json;
    assert.match((await request(second.tracking_url)).text, /Envío creado/);
    const ev = event("evt_cancel_1", "order.cancelled", { id: "order_2" });
    assert.equal((await postSigned(hook, ev, secret, { style: "webhook" })).status, 200);
    assert.match((await request(second.tracking_url)).text, /Cancelado/);
    assert.equal((await postSigned(hook, ev, secret, { style: "webhook" })).status, 200);
    await app.waitForLog(/Duplicado ignorado: evt_cancel_1/);
  });

  await t.step("webhook app.uninstalled (obligatorio) → 200", async () => {
    const res = postViaCli(hook, event("evt_unins_1", "app.uninstalled", { installation_id: "inst_smoke" }), secret, "webhook");
    assert.equal(res.status, 200);
  });

  await expectRejected(t, hook, event("evt_bad_1", "ping", {}), secret, { style: "webhook" });

  await t.step("/install sin credenciales OAuth → 500 con mensaje claro (el resto sigue andando)", async () => {
    const res = await request(`${app.base}/install`);
    assert.equal(res.status, 500);
    assert.match(res.text, /COMMERCY_CLIENT_ID/);
  });
});
