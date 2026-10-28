import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createBody, INSTALLATION, lookupBody, SHOP, startServer, type TestServer } from "./helpers.js";

const CREATE = "/commercy/pos/payments";
const STATUS = "/commercy/pos/payments/status";
const DEVICES = "/commercy/pos/devices";

describe("modo device", () => {
  let srv: TestServer;
  beforeEach(async () => void (srv = await startServer()));
  afterEach(() => srv.close());

  const deviceBody = (deviceId: string | undefined, extra: Record<string, unknown> = {}) => createBody({ mode: "device", device_id: deviceId, ...extra });
  const statusOf = async (id: string) => {
    const list = await srv.post(DEVICES, { installation_id: INSTALLATION, shop_id: SHOP });
    return list.json.devices.find((d: { id: string }) => d.id === id)?.status;
  };

  it("lista los lectores con su estado", async () => {
    const res = await srv.post(DEVICES, { installation_id: INSTALLATION, shop_id: SHOP });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.devices, [
      { id: "reader_01", label: "Caja 1", status: "online" },
      { id: "reader_02", label: "Caja 2", status: "online" },
    ]);
  });

  it("device: la respuesta de creación no lleva display (Commercy no muestra nada de la app)", async () => {
    const res = await srv.post(CREATE, deviceBody("reader_02"));
    assert.equal(res.status, 200);
    assert.equal(res.json.display, undefined);
    assert.equal(res.json.status, "pending");
    assert.ok(!Number.isNaN(Date.parse(res.json.expires_at)));
  });

  it("un lector con un cobro en curso → device_busy y la lista lo muestra busy; al resolverse queda libre", async () => {
    const first = deviceBody("reader_02");
    assert.equal((await srv.post(CREATE, first)).status, 200);
    assert.equal(await statusOf("reader_02"), "busy");
    assert.equal(await statusOf("reader_01"), "online");

    const secondBody = deviceBody("reader_02");
    const second = await srv.post(CREATE, secondBody);
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, "device_busy");
    // el que no se creó no existe
    assert.equal((await srv.post(STATUS, lookupBody(secondBody.payment_ref))).status, 404);

    await srv.admin("POST", `/payments/${first.payment_ref}/reject`);
    assert.equal(await statusOf("reader_02"), "online");
    assert.equal((await srv.post(CREATE, deviceBody("reader_02"))).status, 200);
  });

  it("un device_id que no es de la cuenta → invalid_device; sin device_id → 400", async () => {
    const res = await srv.post(CREATE, deviceBody("reader_de_otro_comercio"));
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, "invalid_device");
    assert.equal((await srv.post(CREATE, deviceBody(undefined))).status, 400);
  });

  it("un lector desconectado → device_offline; al volver, se puede cobrar", async () => {
    await srv.admin("POST", "/devices/reader_01", { status: "offline" });
    assert.equal(await statusOf("reader_01"), "offline");
    const res = await srv.post(CREATE, deviceBody("reader_01"));
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "device_offline");

    await srv.admin("POST", "/devices/reader_01", { status: "online" });
    assert.equal((await srv.post(CREATE, deviceBody("reader_01"))).status, 200);
  });

  it("aprobado en un lector: details con cuotas y los últimos 4 dígitos (nunca el número)", async () => {
    const body = deviceBody("reader_01", { installments: { count: 6, cost: "seller" } });
    await srv.post(CREATE, body);
    await srv.admin("POST", `/payments/${body.payment_ref}/approve`);
    const { details } = (await srv.post(STATUS, lookupBody(body.payment_ref))).json;
    assert.equal(details.installments, 6);
    assert.match(details.card_last4, /^\d{4}$/);
    assert.ok(details.auth_code.length <= 40);
  });
});
