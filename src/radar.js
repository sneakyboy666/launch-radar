// The radar: takes launch events from any source, analyzes each token once, scores it,
// tracks buy/sell flow from trade events, keeps live metrics, and emits updates.
import { EventEmitter } from "node:events";
import { analyzeToken } from "./token.js";
import { scoreReport } from "./score.js";

const LEVEL_ORDER = { LOW: 0, KNOWN: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

// Normalized name/symbol used to spot copycat waves ("Weird Cat" == "WEIRDCAT").
export function nameKey(md) {
  const sym = String(md?.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const name = String(md?.name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return sym.length >= 2 ? sym : name.length >= 3 ? name : null;
}

export class Radar extends EventEmitter {
  constructor(rpc, cfg) {
    super();
    this.rpc = rpc;
    this.cfg = cfg;
    this.tokens = new Map(); // mint -> entry
    this.order = []; // newest first
    this.queue = [];
    this.running = 0;
    this.startedAt = Date.now();
    this.counters = { launches: 0, analyzed: 0, skipped: 0, failed: 0, byLevel: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, KNOWN: 0 }, protocol: 0, flags: {} };
    this.launchTimes = [];
    this.recent = []; // { t, creator, key } for serial-launcher and copycat detection
  }

  #context(entry) {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    this.recent = this.recent.filter((x) => x.t > hourAgo);
    const creator = entry.report?.creator?.address || entry.launch.creator;
    const key = nameKey(entry.report?.metadata || entry.launch);
    return {
      creatorLaunches: creator ? this.recent.filter((x) => x.creator === creator).length : 0,
      sameNameLaunches: key ? this.recent.filter((x) => x.key === key && x.mint !== entry.mint).length : 0,
    };
  }

  onLaunch(launch) {
    if (this.tokens.has(launch.mint)) return;
    this.counters.launches++;
    this.launchTimes.push(Date.now());
    this.recent.push({ t: Date.now(), mint: launch.mint, creator: launch.creator || null, key: nameKey(launch) });
    const entry = { mint: launch.mint, launch, status: "queued", flow: { buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, wallets: new Set() } };
    this.tokens.set(launch.mint, entry);
    this.order.unshift(launch.mint);
    if (this.order.length > 300) this.tokens.delete(this.order.pop());
    this.emit("update", this.view(entry));
    if (this.queue.length >= this.cfg.maxQueue) {
      const dropped = this.queue.shift(); // keep the freshest launches when overloaded
      const d = this.tokens.get(dropped);
      if (d) {
        d.status = "skipped";
        this.counters.skipped++;
        this.emit("update", this.view(d));
      }
    }
    this.queue.push(launch.mint);
    setTimeout(() => this.#pump(), this.cfg.analyzeDelayMs);
  }

  onTrade(trade) {
    const entry = this.tokens.get(trade.mint);
    if (!entry) return;
    const f = entry.flow;
    if (trade.side === "buy") {
      f.buys++;
      f.buyUsd += trade.usd || 0;
    } else {
      f.sells++;
      f.sellUsd += trade.usd || 0;
    }
    if (trade.wallet) f.wallets.add(trade.wallet);
    if (trade.priceUsd) f.lastPriceUsd = trade.priceUsd;
    this.emit("update", this.view(entry));
  }

  async #pump() {
    while (this.running < this.cfg.concurrency && this.queue.length) {
      const mint = this.queue.pop(); // newest first
      const entry = this.tokens.get(mint);
      if (!entry || entry.status !== "queued") continue;
      this.running++;
      entry.status = "analyzing";
      this.#analyze(entry).finally(() => {
        this.running--;
        this.#pump();
      });
    }
  }

  async #analyze(entry) {
    try {
      const report = await analyzeToken(this.rpc, entry.mint, { withCreator: !this.cfg.lightMode, withHolders: !this.cfg.lightMode });
      if (!report.metadata && entry.launch.name) report.metadata = { source: "launch-event", name: entry.launch.name, symbol: entry.launch.symbol, isMutable: false };
      if (!report.creator && entry.launch.creator) report.creator = { address: entry.launch.creator };
      const risk = scoreReport(report, this.#context(entry));
      entry.report = report;
      entry.risk = risk;
      entry.status = "done";
      this.counters.analyzed++;
      // Protocol-issued tokens (prediction-market shares etc.) are counted apart so they don't
      // inflate the scam statistics, and only alert when they're CRITICAL anyway.
      const protocol = risk.category === "protocol";
      if (protocol) this.counters.protocol++;
      else {
        this.counters.byLevel[risk.level]++;
        for (const f of risk.flags) this.counters.flags[f.id] = (this.counters.flags[f.id] || 0) + 1;
      }
      const v = this.view(entry);
      this.emit("update", v);
      const alertAt = protocol ? LEVEL_ORDER.CRITICAL : LEVEL_ORDER[this.cfg.alertLevel];
      if (LEVEL_ORDER[risk.level] >= alertAt) this.emit("alert", v);
    } catch (e) {
      entry.status = "failed";
      entry.error = e.message;
      this.counters.failed++;
      this.emit("update", this.view(entry));
    }
  }

  view(entry) {
    const f = entry.flow;
    const totalUsd = f.buyUsd + f.sellUsd;
    return {
      mint: entry.mint,
      name: entry.report?.metadata?.name || entry.launch.name,
      symbol: entry.report?.metadata?.symbol || entry.launch.symbol,
      source: entry.launch.source,
      creator: entry.report?.creator?.address || entry.launch.creator || null,
      seenAt: entry.launch.seenAt,
      status: entry.status,
      error: entry.error || null,
      level: entry.risk?.level || null,
      category: entry.risk?.category || null,
      score: entry.risk?.score ?? null,
      flags: entry.risk?.flags || [],
      positives: entry.risk?.positives || [],
      notes: entry.risk?.notes || [],
      program: entry.report?.token?.program || null,
      analysisMs: entry.report?.ms ?? null,
      flow: {
        buys: f.buys,
        sells: f.sells,
        buyUsd: Math.round(f.buyUsd),
        sellUsd: Math.round(f.sellUsd),
        uniqueWallets: f.wallets.size,
        buyPressure: totalUsd > 0 ? Math.round((100 * f.buyUsd) / totalUsd) : null,
        lastPriceUsd: f.lastPriceUsd ?? null,
      },
    };
  }

  metrics() {
    const now = Date.now();
    this.launchTimes = this.launchTimes.filter((t) => now - t < 10 * 60 * 1000);
    const lastMin = this.launchTimes.filter((t) => now - t < 60 * 1000).length;
    const a = this.counters.analyzed - this.counters.protocol || 1; // percentages cover real launches only
    const pct = (id) => Math.round((100 * (this.counters.flags[id] || 0)) / a);
    return {
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      launches: this.counters.launches,
      launchesPerMin: lastMin,
      analyzed: this.counters.analyzed,
      skipped: this.counters.skipped,
      failed: this.counters.failed,
      queue: this.queue.length,
      byLevel: this.counters.byLevel,
      protocolTokens: this.counters.protocol,
      pctMintAuthority: pct("mint_authority"),
      pctFreezeAuthority: pct("freeze_authority"),
      pctImpersonation: Math.round((100 * ((this.counters.flags.homoglyph || 0) + (this.counters.flags.brand_copy || 0) + (this.counters.flags.impersonation || 0))) / a),
      pctToken2022Traps: Math.round((100 * ["permanent_delegate", "non_transferable", "default_frozen", "pausable", "transfer_hook", "transfer_fee"].reduce((s, id) => s + (this.counters.flags[id] || 0), 0)) / a),
      rpc: { requests: this.rpc.stats.requests, errors: this.rpc.stats.errors, retries: this.rpc.stats.retries, avgLatencyMs: this.rpc.avgLatencyMs() },
    };
  }

  list(limit = 100) {
    return this.order.slice(0, limit).map((m) => this.view(this.tokens.get(m)));
  }
}
