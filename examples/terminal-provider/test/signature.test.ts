import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { SIGNATURE_TOLERANCE_SECONDS, verifyCommercyRequest } from "../src/commercy.js";
import { createBody, INSTALLATION, PREVIOUS_SECRET, SECRET, SHOP, signedHeaders, startServer, type TestServer } from "./helpers.js";

describe("verifyCommercyRequest (unidad)", () => {
  const raw = '{"installation_id":"i","shop_id":"s"}';
  const now = 1_800_000_000;
  const headersAt = (ts: number, secret = SECRET) => {
    const h = signedHeaders(raw, secret, { ts });
    return { "x-commercy-timestamp": h["X-Commercy-Timestamp"], "x-commercy-signature": h["X-Commercy-Signature"] };
  };

  it("firma válida con el secreto vigente", () => {
    assert.equal(verifyCommercyRequest(raw, headersAt(now), [SECRET], now), true);
  });

  it("firma hecha con otro secreto, o sobre otro cuerpo", () => {
    assert.equal(verifyCommercyRequest(raw, headersAt(now, "whsec_otro"), [SECRET], now), false);
    assert.equal(verifyCommercyRequest(raw + " ", headersAt(now), [SECRET], now), false);
  });

  it("ventana de ±5 minutos: 300 s entra, 301 s no (hacia el pasado y hacia el futuro)", () => {
    assert.equal(SIGNATURE_TOLERANCE_SECONDS, 300);
    assert.equal(verifyCommercyRequest(raw, headersAt(now - 300), [SECRET], now), true);
    assert.equal(verifyCommercyRequest(raw, headersAt(now - 301), [SECRET], now), false);
    assert.equal(verifyCommercyRequest(raw, headersAt(now + 300), [SECRET], now), true);
    assert.equal(verifyCommercyRequest(raw, headersAt(now + 301), [SECRET], now), false);
  });

  it("acepta el secreto anterior mientras se rota, pero solo si está en la lista", () => {
    const old = headersAt(now, PREVIOUS_SECRET);
    assert.equal(verifyCommercyRequest(raw, old, [SECRET, PREVIOUS_SECRET], now), true);
    assert.equal(verifyCommercyRequest(raw, old, [SECRET], now), false);
  });

  it("sin headers, con un timestamp que no son dígitos o con la firma vacía", () => {
    assert.equal(verifyCommercyRequest(raw, {}, [SECRET], now), false);
    const h = headersAt(now);
    assert.equal(verifyCommercyRequest(raw, { ...h, "x-commercy-timestamp": "1e9" }, [SECRET], now), false);
    assert.equal(verifyCommercyRequest(raw, { ...h, "x-commercy-signature": "" }, [SECRET], now), false);
    assert.equal(verifyCommercyRequest(raw, { ...h, "x-commercy-signature": "v1=abc" }, [SECRET], now), false);
  });
});

describe("firma en las cuatro rutas", () => {
  let srv: TestServer;
  before(async () => void (srv = await startServer()));
  after(() => srv.close());

  const routes: Array<[string, () => Record<string, unknown>]> = [
    ["/commercy/pos/devices", () => ({ installation_id: INSTALLATION, shop_id: SHOP })],
    ["/commercy/pos/payments", () => createBody()],
    ["/commercy/pos/payments/status", () => ({ installation_id: INSTALLATION, shop_id: SHOP, payment_ref: "a".repeat(32) })],
    ["/commercy/pos/payments/cancel", () => ({ installation_id: INSTALLATION, shop_id: SHOP, payment_ref: "a".repeat(32), cancel_ref: "c1" })],
  ];

  for (const [path, body] of routes) {
    it(`${path}: firma válida → no es 401`, async () => {
      assert.notEqual((await srv.post(path, body())).status, 401);
    });

    it(`${path}: firma inválida (secreto equivocado) → 401`, async () => {
      assert.equal((await srv.post(path, body(), { secret: "whsec_equivocado" })).status, 401);
    });

    it(`${path}: cuerpo alterado después de firmar → 401`, async () => {
      const signed = JSON.stringify(body());
      const tampered = JSON.stringify({ ...body(), amount: "1.00", tampered: true });
      assert.equal((await srv.post(path, signed, { sendRaw: tampered, installation: INSTALLATION })).status, 401);
    });

    it(`${path}: fuera de ventana (1 h) con firma correcta → 401`, async () => {
      const ts = Math.floor(Date.now() / 1000) - 3600;
      assert.equal((await srv.post(path, body(), { ts })).status, 401);
    });

    it(`${path}: secreto anterior vigente → no es 401`, async () => {
      assert.notEqual((await srv.post(path, body(), { secret: PREVIOUS_SECRET })).status, 401);
    });

    it(`${path}: sin headers de firma → 401`, async () => {
      assert.equal((await srv.post(path, body(), { unsigned: true })).status, 401);
    });

    it(`${path}: installation_id del cuerpo distinto al del header → 401`, async () => {
      assert.equal((await srv.post(path, body(), { installation: "otra-instalacion" })).status, 401);
    });
  }

  it("el 401 lleva un error tipado { error: { code, message } }", async () => {
    const res = await srv.post("/commercy/pos/devices", { installation_id: INSTALLATION, shop_id: SHOP }, { secret: "whsec_equivocado" });
    assert.equal(res.status, 401);
    assert.equal(typeof res.json.error.code, "string");
    assert.equal(typeof res.json.error.message, "string");
  });

  it("firma válida con un cuerpo que no es JSON → 400 (no 401)", async () => {
    assert.equal((await srv.post("/commercy/pos/devices", "esto no es json", { installation: INSTALLATION })).status, 400);
  });
});
