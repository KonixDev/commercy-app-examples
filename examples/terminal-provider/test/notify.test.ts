import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { notifyCommercy, SIGNATURE_TOLERANCE_SECONDS, verifyCommercyRequest } from "../src/commercy.js";

interface Call {
  url: string;
  headers: http.IncomingHttpHeaders;
  raw: string;
}

let server: http.Server | undefined;
afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((resolve) => (s.closeAllConnections(), s.close(() => resolve())));
});

async function stub(statuses: number[]): Promise<{ base: string; calls: Call[] }> {
  const calls: Call[] = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      calls.push({ url: req.url ?? "", headers: req.headers, raw: Buffer.concat(chunks).toString("utf8") });
      res.statusCode = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 200;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server?.address() as AddressInfo).port}`, calls };
}

const payment = { installationId: "6710b3c2e4a1f20012ab34cd", paymentId: "pay_8f3a21", paymentRef: "k3x9a1b7q2m5z8c4v6n0d2f5h7j9l1p3" };
const quiet = { log: () => undefined };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("notifyCommercy (pos_payment.updated)", () => {
  it("POST a /api/v1/app-webhooks/<installation_id>, JSON, firmado con el secreto vigente y sin el estado", async () => {
    const { base, calls } = await stub([200]);
    const result = await notifyCommercy(base, "whsec_actual", payment, quiet);
    assert.deepEqual(result, { delivered: true, status: 200, retrying: false });

    const [call] = calls;
    assert.ok(call);
    assert.equal(call.url, `/api/v1/app-webhooks/${payment.installationId}`);
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(call.raw), {
      type: "pos_payment.updated",
      installation_id: payment.installationId,
      payment_id: payment.paymentId,
      payment_ref: payment.paymentRef,
    });
    // Lo verifica el mismo esquema que Commercy usa al revés (ventana de 5 minutos incluida).
    assert.equal(SIGNATURE_TOLERANCE_SECONDS, 300);
    assert.equal(verifyCommercyRequest(call.raw, call.headers, ["whsec_actual"]), true);
    assert.equal(verifyCommercyRequest(call.raw, call.headers, ["whsec_otro"]), false);
    const ts = call.headers["x-commercy-timestamp"];
    assert.equal(call.headers["x-commercy-signature"], "v1=" + crypto.createHmac("sha256", "whsec_actual").update(`${ts}.${call.raw}`).digest("hex"));
  });

  it("202 (ya hay una consulta en curso para ese cobro) cuenta como entregado y no se reintenta", async () => {
    const { base, calls } = await stub([202]);
    assert.equal((await notifyCommercy(base, "whsec_actual", payment, { ...quiet, retryDelaysMs: [5] })).delivered, true);
    await sleep(40);
    assert.equal(calls.length, 1);
  });

  it("5xx y 429 se reintentan en segundo plano hasta que Commercy contesta 2xx", async () => {
    const { base, calls } = await stub([503, 429, 200]);
    const result = await notifyCommercy(base, "whsec_actual", payment, { ...quiet, retryDelaysMs: [10, 10, 10] });
    assert.deepEqual(result, { delivered: false, status: 503, retrying: true });
    for (let i = 0; i < 100 && calls.length < 3; i += 1) await sleep(10);
    assert.equal(calls.length, 3);
    await sleep(40);
    assert.equal(calls.length, 3); // con el 200 deja de reintentar
  });

  it("401 y 404 no se reintentan (secreto, reloj o instalación mal)", async () => {
    for (const status of [401, 404]) {
      const { base, calls } = await stub([status]);
      const result = await notifyCommercy(base, "whsec_actual", payment, { ...quiet, retryDelaysMs: [5, 5] });
      assert.deepEqual(result, { delivered: false, status, retrying: false });
      await sleep(40);
      assert.equal(calls.length, 1);
      await new Promise<void>((resolve) => (server?.closeAllConnections(), server?.close(() => resolve())));
      server = undefined;
    }
  });

  it("un error de red también se reintenta", async () => {
    const result = await notifyCommercy("http://127.0.0.1:1", "whsec_actual", payment, { ...quiet, retryDelaysMs: [] });
    assert.equal(result.delivered, false);
    assert.equal(result.retrying, false);
    assert.ok(result.error);
  });
});
