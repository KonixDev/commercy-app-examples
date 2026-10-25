#!/usr/bin/env node
// Firma y envía un request como lo hace Commercy, para probar tu receptor sin esperar un evento real.
//
//   node scripts/sign-request.mjs <url> <secret> '<json>' [--header-style=webhook|app] [--print]
//
// El esquema de firma es el MISMO en los dos casos (webhooks y pedidos a apps de envíos/pagos):
//
//   X-Commercy-Timestamp: <segundos Unix actuales>
//   X-Commercy-Signature: v1=<hex( HMAC-SHA256(secret, "<timestamp>.<cuerpo crudo>") )>
//
// con el secreto completo (incluido "whsec_"). Lo único que cambia entre los dos estilos son los
// headers de contexto que acompañan a la firma:
//
//   --header-style=webhook (default)  Webhooks: agrega X-Commercy-Event (body.type), X-Commercy-Event-Id
//                                     (body.id, o uno generado), X-Commercy-Delivery y X-Commercy-Store
//                                     (body.store_id, si hay).
//   --header-style=app                Pedidos de Commercy a tu app de envíos/pagos: agrega
//                                     X-Commercy-Installation (body.installation_id).
//
// Con --print no se hace el POST: sólo imprime los headers y un curl equivalente.
// Sin dependencias, Node >= 20.
import crypto from "node:crypto";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const [url, secret, body] = args.filter((a) => !a.startsWith("--"));
const printOnly = flags.includes("--print");
const style = flags.find((f) => f.startsWith("--header-style="))?.split("=")[1] ?? "webhook";

if (!url || !secret || body === undefined || !["webhook", "app"].includes(style)) {
  console.error(
    "Uso: node scripts/sign-request.mjs <url> <secret> '<json>' [--header-style=webhook|app] [--print]",
  );
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(body);
} catch (err) {
  console.error(`El body no es JSON válido: ${err.message}`);
  process.exit(1);
}

// Se firma el string exacto que se envía: no lo re-serialices en el medio.
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = "v1=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

const headers = {
  "Content-Type": "application/json",
  "X-Commercy-Timestamp": timestamp,
  "X-Commercy-Signature": signature,
};
if (style === "webhook") {
  headers["X-Commercy-Event"] = parsed.type ?? "unknown";
  headers["X-Commercy-Event-Id"] = parsed.id ?? `evt_local_${crypto.randomUUID()}`;
  headers["X-Commercy-Delivery"] = `dlv_local_${crypto.randomUUID()}`;
  if (parsed.store_id) headers["X-Commercy-Store"] = parsed.store_id;
} else if (parsed.installation_id) {
  headers["X-Commercy-Installation"] = parsed.installation_id;
}

if (printOnly) {
  const h = Object.entries(headers).map(([k, v]) => `  -H '${k}: ${v}'`).join(" \\\n");
  console.log(`curl -X POST '${url}' \\\n${h} \\\n  --data-raw '${body.replace(/'/g, "'\\''")}'`);
  process.exit(0);
}

const res = await fetch(url, { method: "POST", headers, body, redirect: "manual" });
console.log(`HTTP ${res.status} ${res.statusText}`);
const text = await res.text();
if (text) console.log(text);
process.exit(res.ok ? 0 : 2);
