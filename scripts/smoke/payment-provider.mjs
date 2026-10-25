// npm run smoke (examples/payment-provider): sesión idempotente, estado, checkout, webhook firmado
// hacia Commercy (contra un stub local de la API) y webhooks entrantes.
import {
  assert,
  expectRejected,
  freePort,
  postSigned,
  postViaCli,
  randomSecret,
  request,
  run,
  stubSignatureOk,
} from "./lib.mjs";

await run("payment-provider", async (t) => {
  const secret = randomSecret();
  const commercyApi = await t.startStub(); // recibe los `payment.updated` que la app le manda a Commercy
  const port = await freePort();
  const app = await t.startApp({
    example: "payment-provider",
    port,
    dotenv: {
      COMMERCY_WEBHOOK_SECRET: secret,
      APP_BASE_URL: `http://127.0.0.1:${port}`,
      COMMERCY_API_BASE: commercyApi.base,
      DATA_FILE: ".data/state.json",
    },
  });
  const sessionUrl = `${app.base}/commercy/payments/session`;
  const statusUrl = `${app.base}/commercy/payments/status`;
  const inst = "inst_smoke";
  const sessionBody = (orderId, extra = {}) => ({
    installation_id: inst,
    shop_id: "shop_smoke",
    idempotency_key: orderId,
    order: { id: orderId, number: "1001" },
    amount: 15000,
    currency: "ARS",
    items: [{ name: "Remera", quantity: 1, unit_price: 15000 }],
    back_url: "https://tienda.example/gracias",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...extra,
  });
  const status = async (paymentId, installation = inst) =>
    postSigned(statusUrl, { installation_id: installation, payment_id: paymentId }, secret);
  const form = (path, action) =>
    request(`${app.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `action=${action}`,
    });

  let s1;
  await t.step("sesión (vía sign-request.mjs): payment_id y checkout_url armado con APP_BASE_URL", async () => {
    const res = postViaCli(sessionUrl, sessionBody("order_1"), secret);
    assert.equal(res.status, 200);
    s1 = res.json;
    assert.match(s1.payment_id, /^pay_[a-f0-9]{24}$/);
    assert.equal(s1.checkout_url, `${app.base}/pay/${s1.payment_id}`);
  });

  await t.step("misma idempotency_key → MISMA sesión (mismo payment_id)", async () => {
    const res = await postSigned(sessionUrl, sessionBody("order_1"), secret);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, s1);
  });

  await t.step("otra idempotency_key → otra sesión", async () => {
    const res = await postSigned(sessionUrl, sessionBody("order_other"), secret);
    assert.notEqual(res.json.payment_id, s1.payment_id);
  });

  await t.step("sesión inválida (monto 0, moneda USD, sin back_url) → 422", async () => {
    for (const extra of [{ amount: 0 }, { currency: "USD" }, { back_url: "no-es-url" }]) {
      assert.equal((await postSigned(sessionUrl, sessionBody("order_bad", extra), secret)).status, 422, JSON.stringify(extra));
    }
  });

  await expectRejected(t, sessionUrl, sessionBody("order_rej"), secret);

  await t.step("installation_id del cuerpo distinto al del header → 401", async () => {
    assert.equal((await postSigned(sessionUrl, sessionBody("order_x"), secret, { installation: "inst_otra" })).status, 401);
  });

  await t.step("status: pending, con los 5 campos exactos", async () => {
    const res = await status(s1.payment_id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      payment_id: s1.payment_id,
      order_id: "order_1",
      status: "pending",
      amount: 15000,
      currency: "ARS",
    });
  });

  await expectRejected(t, statusUrl, { installation_id: inst, payment_id: "pay_x" }, secret);

  await t.step("status de una sesión ajena o inexistente → 404 (no se filtra entre comercios)", async () => {
    assert.equal((await status(s1.payment_id, "inst_otra")).status, 404);
    assert.equal((await status("pay_" + "0".repeat(24))).status, 404);
  });

  await t.step("el checkout hospedado responde 200 con no-store; un id inválido es 404", async () => {
    const res = await request(s1.checkout_url);
    assert.equal(res.status, 200);
    assert.match(res.text, /Pagar/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await request(`${app.base}/pay/no-existe`)).status, 404);
  });

  await t.step("pagar → 303 a back_url, status approved y webhook payment.updated FIRMADO a Commercy", async () => {
    const res = await form(`/pay/${s1.payment_id}`, "approve");
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "https://tienda.example/gracias");
    assert.equal((await status(s1.payment_id)).json.status, "approved");

    await commercyApi.waitForCalls(1);
    const call = commercyApi.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url, `/api/v1/app-webhooks/${inst}`);
    assert.deepEqual(JSON.parse(call.raw), { type: "payment.updated", payment_id: s1.payment_id });
    assert.ok(stubSignatureOk(call, secret), "la firma del webhook hacia Commercy no verifica");
  });

  await t.step("un pago aprobado no se repite (vuelve al checkout, no suma intentos)", async () => {
    const before = commercyApi.calls.length;
    const res = await form(`/pay/${s1.payment_id}`, "reject");
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/pay/${s1.payment_id}`);
    assert.equal((await status(s1.payment_id)).json.status, "approved");
    assert.equal(commercyApi.calls.length, before);
  });

  await t.step("rechazar → rejected; revisión (in_process) → se resuelve a rejected", async () => {
    const rej = (await postSigned(sessionUrl, sessionBody("order_rej_1"), secret)).json;
    assert.equal((await form(`/pay/${rej.payment_id}`, "reject")).status, 303);
    assert.equal((await status(rej.payment_id)).json.status, "rejected");

    const rev = (await postSigned(sessionUrl, sessionBody("order_rev_1"), secret)).json;
    assert.equal((await form(`/pay/${rev.payment_id}`, "review")).status, 303);
    assert.equal((await status(rev.payment_id)).json.status, "in_process");
    assert.equal((await form(`/pay/${rev.payment_id}/resolve`, "reject")).status, 303);
    assert.equal((await status(rev.payment_id)).json.status, "rejected");
  });

  await t.step("acción inválida → 400; sesión vencida → 410", async () => {
    const live = (await postSigned(sessionUrl, sessionBody("order_inv_1"), secret)).json;
    assert.equal((await form(`/pay/${live.payment_id}`, "hackear")).status, 400);
    const expired = (
      await postSigned(sessionUrl, sessionBody("order_exp_1", { expires_at: new Date(Date.now() - 1000).toISOString() }), secret)
    ).json;
    assert.equal((await form(`/pay/${expired.payment_id}`, "approve")).status, 410);
  });

  // ── Webhooks entrantes ─────────────────────────────────────────────────────
  const hook = `${app.base}/webhooks/commercy`;
  const event = (id, type, data) => ({ id, type, created_at: new Date().toISOString(), store_id: "store_smoke", data });

  await t.step("webhook order.cancelled (vía sign-request.mjs) → la sesión pasa a cancelled; el duplicado es 200", async () => {
    const live = (await postSigned(sessionUrl, sessionBody("order_cancel_1"), secret)).json;
    const ev = event("evt_cancel_1", "order.cancelled", { id: "order_cancel_1" });
    assert.equal(postViaCli(hook, ev, secret, "webhook").status, 200);
    assert.equal((await status(live.payment_id)).json.status, "cancelled");
    assert.equal((await postSigned(hook, ev, secret, { style: "webhook" })).status, 200);
    assert.equal((await form(`/pay/${live.payment_id}`, "approve")).status, 410);
  });

  await t.step("los 4 obligatorios → 200", async () => {
    for (const type of ["app.uninstalled", "store.redact", "customers.redact", "customers.data_request"]) {
      const res = await postSigned(hook, event(`evt_${type}`, type, { installation_id: "inst_otra", customer_id: "c1" }), secret, { style: "webhook" });
      assert.equal(res.status, 200, type);
    }
  });

  await expectRejected(t, hook, event("evt_bad_1", "ping", {}), secret, { style: "webhook" });

  await t.step("GET /health → 200", async () => {
    assert.deepEqual((await request(`${app.base}/health`)).json, { ok: true });
  });
});
