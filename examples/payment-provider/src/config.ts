import "dotenv/config";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Falta ${name}. Copiá .env.example a .env y completalo.`);
    process.exit(1);
  }
  return value;
};

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

export const config = {
  webhookSecret: required("COMMERCY_WEBHOOK_SECRET"),
  appBaseUrl: trimSlash(required("APP_BASE_URL")),
  // Sólo para /install: sin ellas la pasarela igual atiende sesiones y estados.
  clientId: process.env.COMMERCY_CLIENT_ID ?? "",
  clientSecret: process.env.COMMERCY_CLIENT_SECRET ?? "",
  apiBase: trimSlash(process.env.COMMERCY_API_BASE ?? "https://api.commercy.com.ar"),
  port: Number(process.env.PORT ?? 3000),
  dataFile: process.env.DATA_FILE ?? ".data/state.json",
};
