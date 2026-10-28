import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createBody, INSTALLATION, lookupBody, startServer, testConfig, type TestServer } from "./helpers.js";

const CREATE = "/commercy/pos/payments";
const STATUS = "/commercy/pos/payments/status";

describe("simulador (/admin)", () => {
  let srv: TestServer;
  before(async () => void (srv = await startServer()));
  after(() => srv.close());

  const make = async (extra: Record<string, unknown> = {}) => {
    const body = createBody({ mode: "qr", device_id: undefined, ...extra });
    await srv.post(CREATE, body);
    return body.payment_ref as string;
  };

  it("sin ADMIN_TOKEN está apagado (404); con otro token es 401", async () => {
    const off = await startServer(testConfig({ adminToken: null }));
    try {
      assert.equal((await off.admin("GET", "/payments")).status, 404);
    } finally {
      await off.close();
    }
    assert.equal((await srv.admin("GET", "/payments", undefined, "otro-token")).status, 401);
    assert.equal((await srv.admin("GET", "/payments", undefined, null)).status, 401);
  });

  it("aprobar manda UN aviso pos_payment.updated con los ids del cobro, y el status queda approved", async () => {
    const ref = await make();
    const before = srv.notices.length;
    const res = await srv.admin("POST", `/payments/${ref}/approve`);
    assert.equal(res.status, 200);
    assert.equal(res.json.webhook.delivered, true);
    assert.equal(srv.notices.length, before + 1);
    const status = (await srv.post(STATUS, lookupBody(ref))).json;
    assert.deepEqual(srv.notices.at(-1), { installationId: INSTALLATION, paymentId: status.payment_id, paymentRef: ref });
    assert.equal(status.status, "approved");
  });

  it('con { "notify": false } cambia el estado pero no avisa', async () => {
    const ref = await make();
    const before = srv.notices.length;
    const res = await srv.admin("POST", `/payments/${ref}/reject`, { notify: false });
    assert.equal(res.status, 200);
    assert.equal(res.json.webhook, null);
    assert.equal(srv.notices.length, before);
  });

  it("si el aviso falla se informa en la respuesta, no se pierde el cambio de estado", async () => {
    const ref = await make();
    srv.setNoticeResult({ delivered: false, status: 503, retrying: true });
    const res = await srv.admin("POST", `/payments/${ref}/approve`);
    srv.setNoticeResult({ delivered: true, status: 200, retrying: false });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.webhook, { delivered: false, status: 503, retrying: true });
    assert.equal(res.json.payment.status, "approved");
  });

  it("un cobro aprobado sólo puede pasar a refunded / partially_refunded", async () => {
    const ref = await make({ amount: "100.00" });
    await srv.admin("POST", `/payments/${ref}/approve`);
    for (const action of ["reject", "expire", "cancel-done", "in-process", "partial"]) {
      assert.equal((await srv.admin("POST", `/payments/${ref}/${action}`)).status, 409, action);
    }
    const partial = (await srv.admin("POST", `/payments/${ref}/refund`, { amount: "30.00" })).json.payment;
    assert.deepEqual([partial.status, partial.refunded_amount], ["partially_refunded", "30.00"]);
    const full = (await srv.admin("POST", `/payments/${ref}/refund`)).json.payment;
    assert.deepEqual([full.status, full.refunded_amount], ["refunded", "100.00"]);
    assert.equal((await srv.admin("POST", `/payments/${ref}/refund`, { amount: "1.00" })).status, 409);
  });

  it("no se puede devolver más de lo cobrado ni aprobar un cobro rechazado", async () => {
    const ref = await make({ amount: "100.00" });
    await srv.admin("POST", `/payments/${ref}/approve`);
    assert.equal((await srv.admin("POST", `/payments/${ref}/refund`, { amount: "100.01" })).status, 400);
    const rejected = await make();
    await srv.admin("POST", `/payments/${rejected}/reject`);
    assert.equal((await srv.admin("POST", `/payments/${rejected}/approve`)).status, 409);
  });

  it("in-process y después aprobado; un payment_ref o una acción desconocida", async () => {
    const ref = await make();
    assert.equal((await srv.admin("POST", `/payments/${ref}/in-process`)).json.payment.status, "in_process");
    assert.equal((await srv.admin("POST", `/payments/${ref}/approve`)).json.payment.status, "approved");
    assert.equal((await srv.admin("POST", "/payments/no-existe/approve")).status, 404);
    assert.equal((await srv.admin("POST", `/payments/${ref}/teletransportar`)).status, 404);
  });

  it("GET /admin/payments lista los cobros y los payment_ref consumidos", async () => {
    const ref = await make();
    await srv.post(STATUS, lookupBody("x".repeat(32)));
    const res = await srv.admin("GET", "/payments");
    assert.ok(res.json.payments.some((p: { payment_ref: string }) => p.payment_ref === ref));
    assert.ok(res.json.consumed.includes("x".repeat(32)));
  });
});
