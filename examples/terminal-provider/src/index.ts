import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[config] ${(err as Error).message}`);
  process.exit(1);
}

const log = (...args: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...args);
const { app } = createApp({ config, log });

app.listen(config.port, () => {
  log(`Terminal Ejemplo escuchando en http://localhost:${config.port}`);
  log(`  modos: ${config.modes.join(", ")} · cancelación: ${config.cancel} · lectores: ${config.devices.map((d) => d.id).join(", ")}`);
  log(`  avisos hacia: ${config.apiBase}${config.apiBase.includes("api.commercy.com.ar") ? "  (PRODUCCIÓN)" : ""}`);
  log(config.adminToken ? "  simulador: /admin (Authorization: Bearer <ADMIN_TOKEN>)" : "  simulador apagado: definí ADMIN_TOKEN para usar /admin");
});
