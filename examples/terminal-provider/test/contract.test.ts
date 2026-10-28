import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ALIAS_RE, isValidCuit, isValidCvu, isValidEmvQr, isValidInstructions } from "../src/display.js";
import { createBody, INSTALLATION, lookupBody, newRef, startServer, testConfig, type TestServer } from "./helpers.js";

const CREATE = "/commercy/pos/payments";
const STATUS = "/commercy/pos/payments/status";
const CANCEL = "/commercy/pos/payments/cancel";
const MONEY = /^\d{1,10}\.\d{2}$/;

let srv: TestServer;
before(async () => void (srv = await startServer()));
after(() => srv.close());

describe("idempotencia por payment_ref", () => {
  it("mismo payment_ref y mismo cuerpo → mismo payment_id", async () => {
    const body = createBody();
    const first = await srv.post(CREATE, body);
    const second = await srv.post(CREATE, body);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(first.json.payment_id, /^[\x21-\x7e]{1,200}$/);
    assert.equal(second.json.payment_id, first.json.payment_id);
    assert.equal(second.json.expires_at, first.json.expires_at);
  });

  it("el orden de las claves del JSON no cambia el cuerpo", async () => {
    const body = createBody();
    const first = await srv.post(CREATE, body);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(body).reverse()));
    const second = await srv.post(CREATE, reordered, { installation: INSTALLATION });
    assert.equal(second.status, 200);
    assert.equal(second.json.payment_id, first.json.payment_id);
  });

  it("mismo payment_ref con otro cuerpo → idempotency_conflict (409) y no pisa el cobro", async () => {
    const body = createBody();
    const first = await srv.post(CREATE, body);
    const conflict = await srv.post(CREATE, { ...body, amount: "999.00" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, "idempotency_conflict");
    const status = await srv.post(STATUS, lookupBody(body.payment_ref));
    assert.equal(status.json.payment_id, first.json.payment_id);
    assert.equal(status.json.amount_requested, "1234.50");
  });

  it("otro payment_ref → otro payment_id", async () => {
    const a = await srv.post(CREATE, createBody());
    const b = await srv.post(CREATE, createBody());
    assert.notEqual(a.json.payment_id, b.json.payment_id);
  });
});

describe("payment_not_found y payment_ref_consumed", () => {
  it("status de un payment_ref desconocido → 404 payment_not_found; después, crearlo → payment_ref_consumed", async () => {
    const ref = newRef();
    const notFound = await srv.post(STATUS, lookupBody(ref));
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error.code, "payment_not_found");

    const create = await srv.post(CREATE, createBody({ payment_ref: ref }));
    assert.equal(create.status, 409);
    assert.equal(create.json.error.code, "payment_ref_consumed");
    // y sigue sin existir
    assert.equal((await srv.post(STATUS, lookupBody(ref))).status, 404);
  });

  it("cancel de un payment_ref desconocido → 404 payment_not_found y también lo consume", async () => {
    const ref = newRef();
    const res = await srv.post(CANCEL, lookupBody(ref, { cancel_ref: "c1" }));
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, "payment_not_found");
    assert.equal((await srv.post(CREATE, createBody({ payment_ref: ref }))).json.error.code, "payment_ref_consumed");
  });

  it("consumir un payment_ref no afecta a los demás", async () => {
    await srv.post(STATUS, lookupBody(newRef()));
    assert.equal((await srv.post(CREATE, createBody())).status, 200);
  });

  it("un cobro de otra instalación se contesta payment_not_found pero NO se consume (el cobro ya existe)", async () => {
    const body = createBody();
    assert.equal((await srv.post(CREATE, body)).status, 200);
    const other = await srv.post(STATUS, { ...lookupBody(body.payment_ref), installation_id: "otra-instalacion" });
    assert.equal(other.status, 404);
    assert.equal((await srv.post(STATUS, lookupBody(body.payment_ref))).status, 200);
  });

  it("status resuelve sólo por payment_ref, con o sin payment_id", async () => {
    const body = createBody();
    const { json: created } = await srv.post(CREATE, body);
    const bare = await srv.post(STATUS, lookupBody(body.payment_ref));
    const withId = await srv.post(STATUS, lookupBody(body.payment_ref, { payment_id: created.payment_id }));
    assert.equal(bare.status, 200);
    assert.deepEqual(withId.json, bare.json);
    assert.equal(bare.json.payment_ref, body.payment_ref);
  });
});

describe("montos como string", () => {
  it("rechaza un amount que no es un string con dos decimales (400, no se crea nada)", async () => {
    for (const amount of [1234.5, "1234.5", "-1.00", "1e3", "1234,50", "", "0.00"]) {
      const body = createBody({ amount });
      const res = await srv.post(CREATE, body);
      assert.equal(res.status, 400, JSON.stringify(amount));
      assert.equal((await srv.post(STATUS, lookupBody(body.payment_ref))).status, 404);
    }
  });

  it("rechaza una moneda distinta de ARS", async () => {
    assert.equal((await srv.post(CREATE, createBody({ currency: "USD" }))).status, 400);
  });

  it("amount_requested y amount_paid salen como string con dos decimales", async () => {
    const body = createBody();
    await srv.post(CREATE, body);
    const pending = (await srv.post(STATUS, lookupBody(body.payment_ref))).json;
    assert.equal(pending.status, "pending");
    assert.equal(pending.amount_requested, "1234.50");
    assert.equal(pending.amount_paid, "0.00");
    assert.equal(pending.currency, "ARS");

    const approved = await srv.admin("POST", `/payments/${body.payment_ref}/approve`);
    assert.equal(approved.status, 200);
    const status = (await srv.post(STATUS, lookupBody(body.payment_ref))).json;
    assert.equal(status.status, "approved");
    assert.equal(status.amount_paid, "1234.50");
    for (const field of ["amount_requested", "amount_paid"]) assert.match(status[field], MONEY);
  });

  it("amount_paid es el BRUTO: total + propina + recargo, con el desglose en amount_extra", async () => {
    const body = createBody({ amount: "1234.50", mode: "device", device_id: "reader_01", installments: { count: 3, cost: "buyer" } });
    assert.equal((await srv.post(CREATE, body)).status, 200);
    await srv.admin("POST", `/payments/${body.payment_ref}/approve`, { tip: "50.00", surcharge: "15.50" });
    const status = (await srv.post(STATUS, lookupBody(body.payment_ref))).json;
    assert.equal(status.status, "approved");
    assert.equal(status.amount_requested, "1234.50");
    assert.equal(status.amount_paid, "1300.00");
    assert.deepEqual(status.amount_extra, { tip: "50.00", surcharge: "15.50" });
    assert.equal(status.details.installments, 3);
    assert.match(status.details.card_last4, /^\d{4}$/);
    // La suma de amount_extra no pasa de amount_paid - amount_requested.
    assert.ok(5000 + 1550 <= 130000 - 123450);
  });

  it("un monto fuera del rango declarado → amount_out_of_range", async () => {
    const res = await srv.post(CREATE, createBody({ amount: "500000.01" }));
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, "amount_out_of_range");
    assert.equal((await srv.post(CREATE, createBody({ amount: "0.50" }))).json.error.code, "amount_out_of_range");
  });

  it("rejected, cancelled y expired llevan amount_paid 0.00; partial devuelve lo cobrado", async () => {
    const make = async (mode = "qr") => {
      const body = createBody({ mode });
      await srv.post(CREATE, body);
      return body.payment_ref as string;
    };
    const rejected = await make();
    await srv.admin("POST", `/payments/${rejected}/reject`, { code: "declined" });
    const r = (await srv.post(STATUS, lookupBody(rejected))).json;
    assert.deepEqual([r.status, r.amount_paid, r.error.code], ["rejected", "0.00", "declined"]);

    const expired = await make();
    await srv.admin("POST", `/payments/${expired}/expire`);
    assert.deepEqual(
      [(await srv.post(STATUS, lookupBody(expired))).json.status, (await srv.post(STATUS, lookupBody(expired))).json.amount_paid],
      ["expired", "0.00"],
    );

    const partial = await make();
    await srv.admin("POST", `/payments/${partial}/partial`, { amount_paid: "500.00" });
    const p = (await srv.post(STATUS, lookupBody(partial))).json;
    assert.deepEqual([p.status, p.amount_paid], ["partial", "500.00"]);
  });

  it("el simulador exige strings: un número en tip → 400", async () => {
    const body = createBody();
    await srv.post(CREATE, body);
    assert.equal((await srv.admin("POST", `/payments/${body.payment_ref}/approve`, { tip: 50 })).status, 400);
  });
});

describe("modos y display", () => {
  it("qr: qr_data es un QR EMVCo válido (CRC sobre UTF-8, con «Ñ» en el nombre) e instructions es texto plano", async () => {
    const body = createBody();
    const res = await srv.post(CREATE, body);
    assert.equal(res.status, 200);
    assert.equal(isValidEmvQr(res.json.display.qr_data), true);
    assert.ok(res.json.display.qr_data.includes("Ñandú"));
    assert.ok(res.json.display.qr_data.includes("54071234.50")); // el monto va en el QR
    assert.equal(isValidInstructions(res.json.display.instructions), true);
  });

  it("none: instrucciones + transferencia con CVU, alias, titular y CUIT válidos", async () => {
    const res = await srv.post(CREATE, createBody({ mode: "none" }));
    assert.equal(res.status, 200);
    const { instructions, transfer } = res.json.display;
    assert.equal(isValidInstructions(instructions), true);
    assert.equal(isValidCvu(transfer.cvu), true);
    assert.match(transfer.alias, ALIAS_RE);
    assert.ok(transfer.holder_name.length > 0 && transfer.holder_name.length <= 80);
    assert.equal(isValidCuit(transfer.holder_cuit), true);
  });

  it("un número de venta con caracteres raros no rompe el display", async () => {
    const res = await srv.post(CREATE, createBody({ order: { id: "o1", number: "10\u202e42\u0007\n<b>x</b>" } }));
    assert.equal(res.status, 200);
    assert.equal(isValidInstructions(res.json.display.instructions), true);
  });

  it("un modo que no declaraste → not_available", async () => {
    const only = await startServer(testConfig({ modes: ["device"] }));
    try {
      const res = await only.post(CREATE, createBody());
      assert.equal(res.status, 422);
      assert.equal(res.json.error.code, "not_available");
    } finally {
      await only.close();
    }
  });
});

describe("cancelación", () => {
  const create = async (server: TestServer) => {
    const body = createBody();
    await server.post(CREATE, body);
    return body.payment_ref as string;
  };

  it("sync: cancelled en el acto; el status lo confirma con amount_paid 0.00", async () => {
    const ref = await create(srv);
    const res = await srv.post(CANCEL, lookupBody(ref, { cancel_ref: "cancel-1" }));
    assert.deepEqual(res.json, { result: "cancelled" });
    const status = (await srv.post(STATUS, lookupBody(ref))).json;
    assert.deepEqual([status.status, status.amount_paid], ["cancelled", "0.00"]);
  });

  it("es idempotente por cancel_ref", async () => {
    const ref = await create(srv);
    const a = await srv.post(CANCEL, lookupBody(ref, { cancel_ref: "cancel-x" }));
    const b = await srv.post(CANCEL, lookupBody(ref, { cancel_ref: "cancel-x" }));
    const c = await srv.post(CANCEL, lookupBody(ref, { cancel_ref: "cancel-y" }));
    assert.deepEqual([a.json, b.json, c.json], [{ result: "cancelled" }, { result: "cancelled" }, { result: "cancelled" }]);
  });

  it("not_cancellable si el cobro ya avanzó (aprobado)", async () => {
    const ref = await create(srv);
    await srv.admin("POST", `/payments/${ref}/approve`);
    assert.deepEqual((await srv.post(CANCEL, lookupBody(ref, { cancel_ref: "c1" }))).json, { result: "not_cancellable" });
    assert.equal((await srv.post(STATUS, lookupBody(ref))).json.status, "approved");
  });

  it("asíncrona: cancel_requested y después cancelled cuando el procesador lo confirma (con aviso)", async () => {
    const asyncSrv = await startServer(testConfig({ cancel: "async" }));
    try {
      const ref = await create(asyncSrv);
      assert.deepEqual((await asyncSrv.post(CANCEL, lookupBody(ref, { cancel_ref: "c1" }))).json, { result: "cancel_requested" });
      assert.equal((await asyncSrv.post(STATUS, lookupBody(ref))).json.status, "cancel_requested");
      // repetir la cancelación no cambia nada
      assert.deepEqual((await asyncSrv.post(CANCEL, lookupBody(ref, { cancel_ref: "c2" }))).json, { result: "cancel_requested" });

      const done = await asyncSrv.admin("POST", `/payments/${ref}/cancel-done`);
      assert.equal(done.status, 200);
      assert.equal(asyncSrv.notices.length, 1);
      assert.equal((await asyncSrv.post(STATUS, lookupBody(ref))).json.status, "cancelled");
    } finally {
      await asyncSrv.close();
    }
  });

  it("unsupported: siempre not_cancellable", async () => {
    const none = await startServer(testConfig({ cancel: "unsupported" }));
    try {
      const ref = await create(none);
      assert.deepEqual((await none.post(CANCEL, lookupBody(ref, { cancel_ref: "c1" }))).json, { result: "not_cancellable" });
    } finally {
      await none.close();
    }
  });

  it("cancel_ref inválido → 400", async () => {
    const ref = await create(srv);
    assert.equal((await srv.post(CANCEL, lookupBody(ref, { cancel_ref: "con espacios" }))).status, 400);
    assert.equal((await srv.post(CANCEL, lookupBody(ref))).status, 400);
  });
});
