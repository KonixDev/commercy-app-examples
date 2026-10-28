import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { createBody, INSTALLATION, lookupBody, SHOP, startServer, testConfig, type TestServer } from "./helpers.js";

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

describe("lectores por instalación", () => {
  const A = "6710b3c2e4a1f20012ab34aa";
  const B = "6710b3c2e4a1f20012ab34bb";
  let srv: TestServer;
  beforeEach(
    async () =>
      void (srv = await startServer(
        testConfig({
          devices: [],
          devicesByInstallation: {
            [A]: [{ id: "reader_a", label: "Caja A", status: "online" }],
            [B]: [{ id: "reader_b", label: "Caja B", status: "online" }],
          },
        }),
      )),
  );
  afterEach(() => srv.close());

  const listOf = async (installation: string) => (await srv.post(DEVICES, { installation_id: installation, shop_id: SHOP }, { installation })).json.devices;
  const charge = (installation: string, deviceId: string) =>
    srv.post(CREATE, createBody({ installation_id: installation, mode: "device", device_id: deviceId }), { installation });

  it("cada instalación lista sólo sus lectores; una desconocida, ninguno", async () => {
    assert.deepEqual(await listOf(A), [{ id: "reader_a", label: "Caja A", status: "online" }]);
    assert.deepEqual(await listOf(B), [{ id: "reader_b", label: "Caja B", status: "online" }]);
    assert.deepEqual(await listOf("6710b3c2e4a1f20012ab34cc"), []);
  });

  it("A no puede cobrar en un lector de B (invalid_device) y cada una cobra en el suyo", async () => {
    const cross = await charge(A, "reader_b");
    assert.equal(cross.status, 422);
    assert.equal(cross.json.error.code, "invalid_device");
    assert.equal((await charge(A, "reader_a")).status, 200);
    assert.equal((await charge(B, "reader_b")).status, 200);
    assert.equal((await charge("6710b3c2e4a1f20012ab34cc", "reader_a")).json.error.code, "invalid_device");
  });

  it("ocupar el lector de A no cambia el de B, ni el simulador con installation_id", async () => {
    await charge(A, "reader_a");
    assert.equal((await listOf(A))[0].status, "busy");
    assert.equal((await listOf(B))[0].status, "online");
    await srv.admin("POST", "/devices/reader_b", { status: "offline", installation_id: B });
    assert.equal((await listOf(B))[0].status, "offline");
    assert.equal((await charge(B, "reader_b")).json.error.code, "device_offline");
    assert.equal((await listOf(A))[0].status, "busy");
  });

  it("DEVICES como arreglo (demo): toda instalación ve los mismos lectores, con estado propio", async () => {
    const demo = await startServer();
    try {
      const other = "6710b3c2e4a1f20012ab34dd";
      await demo.post(CREATE, createBody({ mode: "device", device_id: "reader_01" }));
      const mine = (await demo.post(DEVICES, { installation_id: INSTALLATION, shop_id: SHOP })).json.devices;
      const theirs = (await demo.post(DEVICES, { installation_id: other, shop_id: SHOP }, { installation: other })).json.devices;
      assert.equal(mine.find((d: { id: string }) => d.id === "reader_01").status, "busy");
      assert.equal(theirs.find((d: { id: string }) => d.id === "reader_01").status, "online");
    } finally {
      await demo.close();
    }
  });
});

describe("charset del id de lector (el mismo que Commercy: A-Za-z0-9 _ . : -, 1 a 128, sin '..')", () => {
  const env = { COMMERCY_WEBHOOK_SECRET: "s" };
  const withDevices = (devices: unknown) => () => loadConfig({ ...env, DEVICES: JSON.stringify(devices) });

  it("acepta ids válidos", () => {
    const cfg = loadConfig({ ...env, DEVICES: JSON.stringify([{ id: "reader_01" }, { id: "Clover:ABC-1.2" }, { id: "a".repeat(128) }]) });
    assert.equal(cfg.devices.length, 3);
  });

  it("rechaza al arrancar lo que Commercy descartaría de la lista", () => {
    for (const id of ["lector 1", "a/b", "a?b", "a#b", "..", "a..b", "ñandú", "a".repeat(129), "caja!"]) {
      assert.throws(withDevices([{ id }]), /DEVICES/, id);
    }
  });

  it("DEVICES por instalación: valida cada lista", () => {
    assert.throws(withDevices({ inst_1: [{ id: "a b" }] }), /DEVICES \(inst_1\)/);
    assert.deepEqual(Object.keys(loadConfig({ ...env, DEVICES: JSON.stringify({ inst_1: [{ id: "r1" }] }) }).devicesByInstallation), ["inst_1"]);
  });

  it("el simulador y el cobro rechazan un device_id fuera del charset con 400", async () => {
    const srv = await startServer();
    try {
      assert.equal((await srv.post(CREATE, createBody({ mode: "device", device_id: "reader 01" }))).status, 400);
      assert.equal((await srv.post(CREATE, createBody({ mode: "device", device_id: "a..b" }))).status, 400);
      assert.equal((await srv.admin("POST", "/devices/a..b", { status: "online", installation_id: INSTALLATION })).status, 400);
    } finally {
      await srv.close();
    }
  });
});
