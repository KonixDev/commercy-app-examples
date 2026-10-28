import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALIAS_RE,
  buildEmvQr,
  cleanText,
  crc16Ccitt,
  isValidCuit,
  isValidCvu,
  isValidEmvQr,
  isValidInstructions,
  tlv,
} from "../src/display.js";
import { DEFAULT_TRANSFER, loadConfig } from "../src/config.js";

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");

describe("CRC-16/CCITT-FALSE", () => {
  it('"123456789" → 29B1 (vector estándar)', () => {
    assert.equal(hex4(crc16Ccitt("123456789")), "29B1");
  });

  it("se calcula sobre los bytes UTF-8, no sobre los caracteres", () => {
    const latin1 = (s: string) => {
      let crc = 0xffff;
      for (const ch of s) {
        crc ^= (ch.charCodeAt(0) & 0xff) << 8; // un byte por carácter: lo que NO hay que hacer
        for (let b = 0; b < 8; b += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
      return crc;
    };
    assert.notEqual(crc16Ccitt("Ñandú"), latin1("Ñandú"));
    assert.equal(crc16Ccitt("Nandu"), latin1("Nandu"));
  });
});

describe("QR EMVCo", () => {
  const input = { amount: "1234.50", reference: "k3x9a1b7q2m5z8c4v6n0d2f5h7j9l1p3", merchantName: "Ñandú Pagos", merchantCity: "CABA" };

  it("el QR que arma la app (con «Ñandú») pasa las reglas de Commercy", () => {
    const qr = buildEmvQr(input);
    assert.ok(qr.startsWith("000201"));
    assert.match(qr, /6304[0-9A-F]{4}$/);
    assert.equal(isValidEmvQr(qr), true);
  });

  it("el largo de cada campo cuenta bytes UTF-8", () => {
    assert.equal(tlv("59", "Ñandú"), "5907Ñandú"); // 5 caracteres, 7 bytes
  });

  it("un CRC calculado sobre otra cosa, o alterado, no pasa", () => {
    const qr = buildEmvQr(input);
    assert.equal(isValidEmvQr(qr.slice(0, -4) + "0000"), false);
    assert.equal(isValidEmvQr(qr.replace("1234.50", "9999.99")), false); // el CRC ya no coincide
  });

  it("no pasa si no empieza con 000201, si no termina en 6304XXXX o si trae caracteres de control", () => {
    const qr = buildEmvQr(input);
    assert.equal(isValidEmvQr("000202" + qr.slice(6)), false);
    assert.equal(isValidEmvQr(qr + "00"), false);
    assert.equal(isValidEmvQr("https://pagos.tuapp.com/qr/pay_8f3a21"), false);
    assert.equal(isValidEmvQr(""), false);
    const body = qr.slice(0, -4).replace("Pagos", "Pa\u0007gos");
    const bad = body + hex4(crc16Ccitt(body));
    assert.equal(isValidEmvQr(bad), false);
  });
});

describe("CVU, alias y CUIT", () => {
  it("el CVU y el CUIT de la documentación son válidos", () => {
    assert.equal(isValidCvu("0000003101000000000001"), true);
    assert.equal(isValidCuit("30-71234567-1"), true);
    assert.equal(isValidCuit("30712345671"), true);
  });

  it("los defaults de la app son válidos", () => {
    assert.equal(isValidCvu(DEFAULT_TRANSFER.cvu), true);
    assert.equal(isValidCuit(DEFAULT_TRANSFER.holder_cuit), true);
    assert.match(DEFAULT_TRANSFER.alias ?? "", ALIAS_RE);
  });

  it("CVU: 22 dígitos con los dos verificadores", () => {
    assert.equal(isValidCvu("0000003101000000000002"), false); // verificador del bloque 2
    assert.equal(isValidCvu("0000003001000000000001"), false); // verificador del bloque 1
    assert.equal(isValidCvu("000000310100000000001"), false); // 21 dígitos
    assert.equal(isValidCvu("00000031010000000000A1"), false);
    assert.equal(isValidCvu(3101000000000001), false);
  });

  it("CUIT: 11 dígitos con verificador, con o sin guiones", () => {
    assert.equal(isValidCuit("30-71234567-2"), false);
    assert.equal(isValidCuit("30-7123456-71"), false);
    assert.equal(isValidCuit("3071234567"), false);
    assert.equal(isValidCuit("30.71234567.1"), false);
  });

  it("alias: 6 a 20 caracteres (letras, números, punto y guion)", () => {
    for (const ok of ["tienda.pagos", "abc-12", "a".repeat(20)]) assert.match(ok, ALIAS_RE);
    for (const bad of ["corto", "a".repeat(21), "con espacio", "ñandu.pago"]) assert.doesNotMatch(bad, ALIAS_RE);
  });
});

describe("texto plano", () => {
  it("instructions: hasta 280 caracteres, con \\n, sin otros controles", () => {
    assert.equal(isValidInstructions("Transferí el total.\nGuardá el comprobante."), true);
    assert.equal(isValidInstructions("a".repeat(280)), true);
    assert.equal(isValidInstructions("a".repeat(281)), false);
    assert.equal(isValidInstructions("con\ttab"), false);
    assert.equal(isValidInstructions("con\rretorno"), false);
    assert.equal(isValidInstructions("texto\u202eoculto"), false);
    assert.equal(isValidInstructions("   "), false);
  });

  it("cleanText saca controles y marcas bidi y acota", () => {
    assert.equal(cleanText("10\u202e42\n", 20), "1042");
    assert.equal(cleanText("x".repeat(50), 20).length, 20);
  });
});

describe("loadConfig", () => {
  const env = { COMMERCY_WEBHOOK_SECRET: "whsec_x" };

  it("arranca con los defaults", () => {
    const c = loadConfig(env);
    assert.deepEqual(c.secrets, ["whsec_x"]);
    assert.deepEqual(c.modes, ["device", "qr", "none"]);
    assert.equal(c.cancel, "sync");
    assert.equal(c.adminToken, null);
  });

  it("incluye el secreto anterior si se define", () => {
    assert.deepEqual(loadConfig({ ...env, COMMERCY_WEBHOOK_SECRET_PREVIOUS: "whsec_viejo" }).secrets, ["whsec_x", "whsec_viejo"]);
  });

  it("falla al arrancar con datos de transferencia que Commercy rechazaría", () => {
    assert.throws(() => loadConfig({}), /COMMERCY_WEBHOOK_SECRET/);
    assert.throws(() => loadConfig({ ...env, TRANSFER_CVU: "0000003101000000000002" }), /TRANSFER_CVU/);
    assert.throws(() => loadConfig({ ...env, TRANSFER_HOLDER_CUIT: "30-71234567-2" }), /TRANSFER_HOLDER_CUIT/);
    assert.throws(() => loadConfig({ ...env, TRANSFER_ALIAS: "corto" }), /TRANSFER_ALIAS/);
    assert.throws(() => loadConfig({ ...env, MODES: "device,wifi" }), /MODES/);
    assert.throws(() => loadConfig({ ...env, AMOUNT_MIN: "1.5" }), /AMOUNT_MIN/);
    assert.throws(() => loadConfig({ ...env, CANCEL_MODE: "maybe" }), /CANCEL_MODE/);
    assert.throws(() => loadConfig({ ...env, MERCHANT_NAME: "x".repeat(26) }), /MERCHANT_NAME/);
  });
});
