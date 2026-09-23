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

const round2 = (x) => Math.round(x * 100) / 100;

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
    this.counters = { launches: 0, analyzed: 0, skipped: 0, failed: 0, byLevel: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, KNOWN: 0 }, protocol: 0, flags: {}, creatorDumps: 0 };
    // Outcome tracking: of the tokens scored at level X at launch (before any selling), how many
    // saw their creator dump afterwards? This is how we check the score predicts anything.
    this.outcomes = { LOW: { n: 0, dumped: 0 }, MEDIUM: { n: 0, dumped: 0 }, HIGH: { n: 0, dumped: 0 }, CRITICAL: { n: 0, dumped: 0 } };
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
    const entry = { mint: launch.mint, launch, status: "queued", flow: { buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, buySol: 0, sellSol: 0, wallets: new Set(), source: null }, dev: { bought: 0n, sold: 0n } };
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
    // Creator tracking needs exact token amounts (Pump.fun TradeEvent), whichever source feeds flow.
    const creator = entry.launch.creator;
    if (creator && trade.wallet === creator && typeof trade.tokens === "bigint") this.#creatorTrade(entry, trade);
    // Pump.fun logs and Solami Blur can both report the same trade: count one source per token.
    f.source ??= trade.source || "unknown";
    if (f.source !== (trade.source || "unknown")) return;
    if (trade.side === "buy") {
      f.buys++;
      f.buyUsd += trade.usd || 0;
      f.buySol += trade.sol || 0;
    } else {
      f.sells++;
      f.sellUsd += trade.usd || 0;
      f.sellSol += trade.sol || 0;
    }
    if (trade.wallet) f.wallets.add(trade.wallet);
    if (trade.priceUsd) f.lastPriceUsd = trade.priceUsd;
    if (trade.priceSol) f.lastPriceSol = trade.priceSol;
    if (trade.curveSol !== undefined && trade.curveSol !== null) f.curveSol = trade.curveSol;
    this.emit("update", this.view(entry));
  }

  #creatorTrade(entry, trade) {
    const dev = entry.dev;
    if (trade.side === "buy") dev.bought += trade.tokens;
    else dev.sold += trade.tokens;
    if (dev.bought === 0n || trade.side === "buy") return;
    const pct = Math.min(100, Number((dev.sold * 10000n) / dev.bought) / 100);
    dev.soldPct = pct;
    dev.afterSec = (Date.now() - entry.launch.seenAt) / 1000;
    if (pct >= 50 && !dev.dumped) {
      dev.dumped = true;
      this.counters.creatorDumps++;
      if (entry.preLevel && this.outcomes[entry.preLevel]) this.outcomes[entry.preLevel].dumped++;
    }
    if (entry.status === "done") this.#score(entry, true);
  }

  // (Re)score from the stored report; live events like a creator dump can raise the level later.
  #score(entry, live = false) {
    const before = entry.risk?.level;
    const dev = entry.dev;
    const ctx = { ...entry.ctx, creatorSold: dev.soldPct >= 20 ? { pct: dev.soldPct, afterSec: dev.afterSec } : null };
    const risk = scoreReport(entry.report, ctx);
    entry.risk = risk;
    if (!live) return risk;
    const v = this.view(entry);
    this.emit("update", v);
    const alertAt = risk.category === "protocol" ? LEVEL_ORDER.CRITICAL : LEVEL_ORDER[this.cfg.alertLevel];
    if (LEVEL_ORDER[risk.level] > LEVEL_ORDER[before] && LEVEL_ORDER[risk.level] >= alertAt) this.emit("alert", v);
    return risk;
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
      entry.report = report;
      entry.ctx = this.#context(entry);
      // Level before any selling was seen: used to measure whether the score predicts dumps.
      const pre = scoreReport(report, entry.ctx);
      entry.preLevel = pre.category === "launch" ? pre.level : null;
      if (entry.preLevel) this.outcomes[entry.preLevel].n++;
      if (entry.preLevel && entry.dev.dumped) this.outcomes[entry.preLevel].dumped++;
      const risk = this.#score(entry);
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
    const totalSol = f.buySol + f.sellSol;
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
        buySol: round2(f.buySol),
        sellSol: round2(f.sellSol),
        uniqueWallets: f.wallets.size,
        buyPressure: totalUsd > 0 ? Math.round((100 * f.buyUsd) / totalUsd) : totalSol > 0 ? Math.round((100 * f.buySol) / totalSol) : null,
        lastPriceUsd: f.lastPriceUsd ?? null,
        lastPriceSol: f.lastPriceSol ?? null,
        curveSol: f.curveSol !== undefined ? round2(f.curveSol) : null,
        source: f.source,
      },
      creatorSoldPct: entry.dev.soldPct ?? null,
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
      creatorDumps: this.counters.creatorDumps,
      outcomes: Object.fromEntries(Object.entries(this.outcomes).map(([k, o]) => [k, { ...o, pctDumped: o.n ? Math.round((100 * o.dumped) / o.n) : null }])),
      pctMintAuthority: pct("mint_authority"),
      pctFreezeAuthority: pct("freeze_authority"),
      pctImpersonation: Math.round((100 * ((this.counters.flags.homoglyph || 0) + (this.counters.flags.brand_copy || 0) + (this.counters.flags.impersonation || 0) + (this.counters.flags.bait || 0))) / a),
      pctToken2022Traps: Math.round((100 * ["permanent_delegate", "non_transferable", "default_frozen", "pausable", "transfer_hook", "transfer_fee"].reduce((s, id) => s + (this.counters.flags[id] || 0), 0)) / a),
      rpc: { requests: this.rpc.stats.requests, errors: this.rpc.stats.errors, retries: this.rpc.stats.retries, avgLatencyMs: this.rpc.avgLatencyMs() },
    };
  }

  list(limit = 100) {
    return this.order.slice(0, limit).map((m) => this.view(this.tokens.get(m)));
  }
}
