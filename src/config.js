// Configuration from environment variables (and an optional .env file next to package.json).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv() {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function loadConfig() {
  loadDotEnv();
  const env = process.env;
  const key = env.SOLAMI_API_KEY || "";
  const q = key ? `api_key=${encodeURIComponent(key)}` : "";
  const cfg = {
    root: ROOT,
    solamiKey: key,
    usingSolami: Boolean(key),
    rpcUrl: env.RPC_URL || (key ? `https://rpc.solami.dev/sol?${q}` : "https://api.mainnet-beta.solana.com"),
    wsUrl: env.WS_URL || (key ? `wss://rpc.solami.dev/ws/sol?${q}` : "wss://api.mainnet-beta.solana.com"),
    blurUrl: env.BLUR_WS_URL || (key ? `wss://ws.solami.dev/data/subscribe?chain=solana&${q}` : ""),
    dataApi: env.SOLAMI_DATA_API || "https://api.solami.dev",
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 8787),
    webhookUrl: env.WEBHOOK_URL || "",
    alertLevel: (env.ALERT_LEVEL || "HIGH").toUpperCase(),
    // Public RPC can't keep up with full analysis of every launch; Solami Pro can (200 rps).
    lightMode: env.LIGHT_MODE ? env.LIGHT_MODE === "1" : !key,
    concurrency: Number(env.CONCURRENCY || (key ? 8 : 1)),
    minIntervalMs: Number(env.MIN_INTERVAL_MS || (key ? 0 : 250)),
    maxQueue: Number(env.MAX_QUEUE || 50),
    analyzeDelayMs: Number(env.ANALYZE_DELAY_MS || 2500),
    trapWatch: env.TRAP_WATCH ? env.TRAP_WATCH === "1" : true,
  };
  return cfg;
}

// Never print secrets.
export function redact(url) {
  return String(url).replace(/(api_key=)[^&]+/gi, "$1***");
}
