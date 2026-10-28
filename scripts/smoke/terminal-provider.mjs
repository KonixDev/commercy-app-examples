// npm run smoke (examples/terminal-provider): las 4 rutas firmadas, idempotencia por payment_ref,
// payment_not_found → payment_ref_consumed, el simulador (/admin) y el aviso firmado `pos_payment.updated`
// hacia Commercy (contra un stub local de la API).
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

await run("terminal-provider", async (t) => {
  const secret = randomSecret();
  const previous = randomSecret();
  const adminToken = "smoke-admin-" + randomSecret();
  const commercyApi = await t.startStub(); // recibe los `pos_payment.updated` que la app le manda a Commercy
  const port = await freePort();
  const app = await t.startApp({
    example: "terminal-provider",
    port,
    dotenv: {
      COMMERCY_WEBHOOK_SECRET: secret,
      COMMERCY_WEBHOOK_SECRET_PREVIOUS: previous,
      COMMERCY_API_BASE: commercyApi.base,
    },
    env: {
      ADMIN_TOKEN: adminToken,
      // Lectores POR instalación: inst_smoke no ve ni cobra en los de inst_otra.
      DEVICES: JSON.stringify({
        inst_smoke: [{ id: "reader_01", label: "Caja 1" }, { id: "reader_02", label: "Caja 2" }],
        inst_otra: [{ id: "reader_otra", label: "Caja de otro comercio" }],
      }),
    },
  });

  const inst = "inst_smoke";
  const shop = "shop_smoke";
  const url = (path) => `${app.base}/commercy/pos/${path}`;
  let n = 0;
  const newRef = () => `smoke${String(++n).padStart(3, "0")}${"a".repeat(24)}`.slice(0, 32);
  const createBody = (ref, extra = {}) => ({
    installation_id: inst,
    shop_id: shop,
    payment_ref: ref,
    order: { id: "order_1", number: "1042" },
    amount: "1234.50",
    currency: "ARS",
    mode: "qr",
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    display_title: "Venta 1042",
    ...extra,
  });
  const lookup = (ref, extra = {}) => ({ installation_id: inst, shop_id: shop, payment_ref: ref, ...extra });
  const admin = (path, body) =>
    request(`${app.base}/admin${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(body ?? {}),
    });

  await t.step("devices (vía sign-request.mjs): lista los lectores", async () => {
    const res = postViaCli(url("devices"), { installation_id: inst, shop_id: shop }, secret);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.devices.map((d) => d.id), ["reader_01", "reader_02"]);
  });

  await t.step("lectores por instalación: la otra instalación ve sólo los suyos y nadie cobra en el lector ajeno", async () => {
    const other = await postSigned(url("devices"), { installation_id: "inst_otra", shop_id: shop }, secret, { installation: "inst_otra" });
    assert.deepEqual(other.json.devices.map((d) => d.id), ["reader_otra"]);
    const cross = await postSigned(url("payments"), createBody(newRef(), { mode: "device", device_id: "reader_otra" }), secret);
    assert.equal(cross.status, 422);
    assert.equal(cross.json.error.code, "invalid_device");
  });

  await expectRejected(t, url("devices"), { installation_id: inst, shop_id: shop }, secret);
  await expectRejected(t, url("payments"), createBody(newRef()), secret);
  await expectRejected(t, url("payments/status"), lookup(newRef()), secret);
  await expectRejected(t, url("payments/cancel"), lookup(newRef(), { cancel_ref: "c1" }), secret);

  await t.step("installation_id del cuerpo distinto al del header → 401", async () => {
    assert.equal((await postSigned(url("payments"), createBody(newRef()), secret, { installation: "inst_otra" })).status, 401);
  });

  await t.step("el secreto anterior (rotación) también se acepta", async () => {
    assert.equal((await postSigned(url("devices"), { installation_id: inst, shop_id: shop }, previous)).status, 200);
  });

  const ref = newRef();
  const refBody = createBody(ref); // se reenvía tal cual: otro expires_at ya sería "otro cuerpo"
  let created;
  await t.step("crear en modo qr: payment_id, vencimiento real y un display con qr_data EMVCo", async () => {
    const res = postViaCli(url("payments"), refBody, secret);
    assert.equal(res.status, 200);
    created = res.json;
    assert.match(created.payment_id, /^pay_[a-f0-9]{16}$/);
    assert.equal(created.status, "pending");
    assert.ok(!Number.isNaN(Date.parse(created.expires_at)));
    assert.match(created.display.qr_data, /^000201.*6304[0-9A-F]{4}$/);
  });

  await t.step("mismo payment_ref y mismo cuerpo → mismo payment_id; otro cuerpo → idempotency_conflict", async () => {
    const same = await postSigned(url("payments"), refBody, secret);
    assert.equal(same.json.payment_id, created.payment_id);
    const other = await postSigned(url("payments"), { ...refBody, amount: "99.00" }, secret);
    assert.equal(other.status, 409);
    assert.equal(other.json.error.code, "idempotency_conflict");
  });

  await t.step("status resuelve sólo por payment_ref: montos como string", async () => {
    const res = await postSigned(url("payments/status"), lookup(ref), secret);
    assert.equal(res.status, 200);
    assert.deepEqual(
      [res.json.status, res.json.amount_requested, res.json.amount_paid, res.json.currency],
      ["pending", "1234.50", "0.00", "ARS"],
    );
  });

  await t.step("payment_not_found (404) y después payment_ref_consumed al intentar crearlo", async () => {
    const ghost = newRef();
    const nf = await postSigned(url("payments/status"), lookup(ghost), secret);
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error.code, "payment_not_found");
    const consumed = await postSigned(url("payments"), createBody(ghost), secret);
    assert.equal(consumed.status, 409);
    assert.equal(consumed.json.error.code, "payment_ref_consumed");
  });

  await t.step("crear en modo none: transferencia con CVU de 22 dígitos, alias y CUIT", async () => {
    const res = await postSigned(url("payments"), createBody(newRef(), { mode: "none" }), secret);
    assert.equal(res.status, 200);
    assert.match(res.json.display.transfer.cvu, /^\d{22}$/);
    assert.ok(res.json.display.transfer.alias && res.json.display.transfer.holder_cuit);
    assert.ok(res.json.display.instructions);
  });

  await t.step("crear en modo device: sin display; el lector queda ocupado", async () => {
    const dev = newRef();
    const res = await postSigned(url("payments"), createBody(dev, { mode: "device", device_id: "reader_01" }), secret);
    assert.equal(res.status, 200);
    assert.equal(res.json.display, undefined);
    const busy = await postSigned(url("payments"), createBody(newRef(), { mode: "device", device_id: "reader_01" }), secret);
    assert.equal(busy.json.error.code, "device_busy");
    const bad = await postSigned(url("payments"), createBody(newRef(), { mode: "device", device_id: "reader_x" }), secret);
    assert.equal(bad.json.error.code, "invalid_device");
    assert.deepEqual((await postSigned(url("payments/cancel"), lookup(dev, { cancel_ref: "c1" }), secret)).json, { result: "cancelled" });
  });

  await t.step("el simulador exige token (sin token 401) y aprobar manda el aviso FIRMADO a Commercy", async () => {
    assert.equal((await request(`${app.base}/admin/payments`)).status, 401);

    const res = await admin(`/payments/${ref}/approve`, { tip: "50.00", surcharge: "15.50" });
    assert.equal(res.status, 200);
    assert.equal(res.json.webhook.delivered, true);

    await commercyApi.waitForCalls(1);
    const call = commercyApi.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url, `/api/v1/app-webhooks/${inst}`);
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(call.raw), {
      type: "pos_payment.updated",
      installation_id: inst,
      payment_id: created.payment_id,
      payment_ref: ref,
    });
    assert.ok(stubSignatureOk(call, secret), "la firma del aviso hacia Commercy no verifica");

    const status = (await postSigned(url("payments/status"), lookup(ref), secret)).json;
    assert.deepEqual(
      [status.status, status.amount_paid, status.amount_extra],
      ["approved", "1300.00", { tip: "50.00", surcharge: "15.50" }],
    );
  });

  await t.step("un cobro aprobado ya no se cancela (not_cancellable) ni se rechaza (409)", async () => {
    assert.deepEqual((await postSigned(url("payments/cancel"), lookup(ref, { cancel_ref: "c9" }), secret)).json, { result: "not_cancellable" });
    assert.equal((await admin(`/payments/${ref}/reject`)).status, 409);
  });

  await t.step("GET /health → 200", async () => {
    assert.deepEqual((await request(`${app.base}/health`)).json, { ok: true });
  });
});
