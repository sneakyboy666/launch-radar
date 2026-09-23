#!/usr/bin/env node
// launch-radar CLI
//   launch-radar check <mint> [--json]   one-off safety report for any token
//   launch-radar watch                    live radar: new launches -> risk scores -> dashboard + alerts
//   launch-radar discover [seconds]       record raw Solami Blur messages to data/blur-sample.jsonl
import { join } from "node:path";
import { loadConfig, redact } from "./config.js";
import { Rpc, isValidPubkey } from "./solana.js";
import { analyzeToken } from "./token.js";
import { scoreReport } from "./score.js";
import { Radar } from "./radar.js";
import { RpcLogsLaunchSource } from "./sources/rpcLogs.js";
import { SolamiBlurSource } from "./sources/solamiBlur.js";
import { Token2022TrapWatch } from "./sources/token2022Watch.js";
import { Alerts } from "./alerts.js";
import { startServer } from "./server.js";

const C = { red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };
const LEVEL_COLOR = { CRITICAL: C.red + C.bold, HIGH: C.red, MEDIUM: C.yellow, LOW: C.green, KNOWN: C.cyan };
const color = (lvl, s) => `${LEVEL_COLOR[lvl] || ""}${s}${C.reset}`;

const cfg = loadConfig();

// A long-running radar must survive transient network errors instead of exiting.
process.on("unhandledRejection", (e) => console.error(`${C.dim}[warn] ${e?.message || e}${C.reset}`));
const [cmd = "help", ...args] = process.argv.slice(2);

async function check(mint, json) {
  if (!isValidPubkey(mint)) throw new Error("Usage: launch-radar check <mint address>");
  const rpc = new Rpc(cfg.rpcUrl, { maxConcurrent: cfg.concurrency, minIntervalMs: cfg.minIntervalMs });
  const report = await analyzeToken(rpc, mint);
  const risk = scoreReport(report);
  if (json) {
    console.log(JSON.stringify({ mint, risk, report }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return;
  }
  const md = report.metadata || {};
  console.log(`\n${C.bold}${md.symbol || "?"}${C.reset} ${md.name ? `(${md.name})` : ""}  ${C.dim}${mint}${C.reset}`);
  console.log(`${color(risk.level, `${risk.level}  ${risk.score}/100`)}   ${C.dim}${report.token.program}, ${report.ms} ms via ${cfg.usingSolami ? "Solami RPC" : "public RPC"}${C.reset}\n`);
  if (risk.category === "protocol") console.log(`  ${C.cyan}PROTOCOL TOKEN${C.reset} ${C.dim}(powers held by program addresses, not wallets)${C.reset}`);
  for (const f of risk.flags) console.log(`  ${C.red}✗${C.reset} ${f.text} ${C.dim}(+${f.points})${C.reset}`);
  for (const p of risk.positives) console.log(`  ${C.green}✓${C.reset} ${p}`);
  for (const n of risk.notes || []) console.log(`  ${C.cyan}i${C.reset} ${n}`);
  if (report.holders?.length) {
    console.log(`\n  ${C.bold}Top holders${C.reset}`);
    for (const h of report.holders.slice(0, 5)) console.log(`    ${h.pct.toFixed(2).padStart(6)}%  ${h.owner || h.tokenAccount}${h.pool ? `  ${C.dim}[${h.pool}]${C.reset}` : ""}`);
  }
  if (report.creator?.address) console.log(`\n  Creator: ${report.creator.address}${report.creator.pct !== undefined ? ` holds ${report.creator.pct.toFixed(2)}%` : ""}`);
  if (report.errors.length) console.log(`\n  ${C.dim}Partial data: ${report.errors.join("; ")}${C.reset}`);
  console.log();
}

function watch() {
  const rpc = new Rpc(cfg.rpcUrl, { maxConcurrent: cfg.concurrency, minIntervalMs: cfg.minIntervalMs });
  const radar = new Radar(rpc, cfg);
  const alerts = new Alerts(cfg.webhookUrl);
  const sources = { launches: new RpcLogsLaunchSource(cfg.wsUrl).start() };
  if (cfg.trapWatch) sources.traps = new Token2022TrapWatch(cfg.wsUrl, rpc).start();
  if (cfg.blurUrl) sources.blur = new SolamiBlurSource(cfg.blurUrl).start();

  sources.launches.on("launch", (l) => radar.onLaunch(l));
  sources.launches.on("trade", (t) => radar.onTrade(t));
  sources.traps?.on("launch", (l) => radar.onLaunch(l));
  if (sources.blur) {
    sources.blur.on("launch", (l) => radar.onLaunch(l));
    sources.blur.on("trade", (t) => radar.onTrade(t));
  }
  for (const s of Object.values(sources)) {
    s.on("status", (st) => console.log(`${C.dim}[${st.source}] ${st.connected ? "connected" : "disconnected, retrying"}${C.reset}`));
    s.on("warning", (w) => console.log(`${C.dim}[${w.source}] ${w.message}${C.reset}`));
  }

  radar.on("update", (v) => {
    if (v.status !== "done") return;
    const top = v.flags[0]?.text || v.positives[0] || "";
    const tag = v.category === "protocol" ? `${C.cyan}[protocol]${C.reset} ` : "";
    console.log(`${color(v.level, v.level.padEnd(8))} ${String(v.score).padStart(3)}  ${(v.symbol || "?").slice(0, 12).padEnd(12)} ${C.dim}${v.mint}${C.reset}  ${tag}${top.slice(0, 90)}`);
  });
  radar.on("alert", (v) => alerts.send(v));

  startServer({ cfg, radar, rpc, sources });
  console.log(`${C.bold}Launch Radar${C.reset} watching Solana mainnet`);
  console.log(`  data:      ${cfg.usingSolami ? "Solami (RPC + WebSocket + Blur)" : "public Solana RPC (light mode). Set SOLAMI_API_KEY for full analysis + Blur trade flow"}`);
  console.log(`  rpc:       ${redact(cfg.rpcUrl)}`);
  console.log(`  dashboard: http://${cfg.host}:${cfg.port}`);
  console.log(`  alerts:    ${cfg.webhookUrl ? `${cfg.alertLevel}+ to webhook` : "off (set WEBHOOK_URL)"}\n`);
}

function discover(seconds = 60) {
  if (!cfg.blurUrl) throw new Error("Set SOLAMI_API_KEY to use discover.");
  const dir = join(cfg.root, "data");
  const src = new SolamiBlurSource(cfg.blurUrl, { discoverDir: dir }).start();
  src.on("status", (s) => console.log("blur", s.connected ? "connected" : "disconnected"));
  setTimeout(() => {
    console.log(JSON.stringify(src.stats, null, 2));
    console.log(`Raw messages saved to ${join(dir, "blur-sample.jsonl")}`);
    src.stop();
    process.exit(0);
  }, seconds * 1000);
}

try {
  if (cmd === "check") await check(args[0], args.includes("--json"));
  else if (cmd === "watch") watch();
  else if (cmd === "discover") discover(Number(args[0] || 60));
  else {
    console.log("Usage:\n  launch-radar check <mint> [--json]\n  launch-radar watch\n  launch-radar discover [seconds]");
  }
} catch (e) {
  console.error(`${C.red}Error:${C.reset} ${e.message}`);
  process.exit(1);
}
