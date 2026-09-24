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
    this.counters = { launches: 0, analyzed: 0, skipped: 0, failed: 0, byLevel: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, KNOWN: 0 }, protocol: 0, flags: {}, creatorDumps: 0, creatorTransfers: 0, liquidityPulls: 0, graduations: 0, surges: 0, byLaunchpad: {} };
    // Outcome tracking: of the tokens scored at level X at launch (before any selling), how many
    // saw their creator dump afterwards? This is how we check the score predicts anything.
    this.outcomes = { LOW: { n: 0, dumped: 0 }, MEDIUM: { n: 0, dumped: 0 }, HIGH: { n: 0, dumped: 0 }, CRITICAL: { n: 0, dumped: 0 } };
    // Same, per red flag present at launch ("no_flags" = nothing found): which flags predict dumps?
    this.flagOutcomes = {};
    this.launchTimes = [];
    this.recent = []; // { t, creator, key } for serial-launcher and copycat detection
  }

  #context(entry) {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    this.recent = this.recent.filter((x) => x.t > hourAgo);
    const creator = entry.report?.creator?.address || entry.launch.creator;
    const key = nameKey(entry.report?.metadata || entry.launch);
    return {
      viaLaunchpad: Boolean(entry.launch.dex && entry.launch.dex !== "token-2022"),
      creatorLaunches: creator ? this.recent.filter((x) => x.creator === creator).length : 0,
      sameNameLaunches: key ? this.recent.filter((x) => x.key === key && x.mint !== entry.mint).length : 0,
    };
  }

  onLaunch(launch) {
    if (this.tokens.has(launch.mint)) return;
    this.counters.launches++;
    this.launchTimes.push(Date.now());
    this.recent.push({ t: Date.now(), mint: launch.mint, creator: launch.creator || null, key: nameKey(launch) });
    const pad = launch.dex || launch.source || "unknown";
    this.counters.byLaunchpad[pad] = (this.counters.byLaunchpad[pad] || 0) + 1;
    const entry = {
      mint: launch.mint,
      launch,
      status: "queued",
      flow: { buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, buySol: 0, sellSol: 0, wallets: new Set(), source: null },
      dev: { bought: 0n, sold: 0n, movedOut: 0n, sigs: new Set() },
      pools: new Set([launch.pool].filter(Boolean)), // curve/pool accounts: token moves into these are trades, not transfers
      lp: { removedUsd: 0 },
      market: null,
      graduated: null,
      surge: null,
    };
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
    if (trade.pool) entry.pools.add(trade.pool);
    if (trade.mcapUsd) entry.market = { ...entry.market, mcapUsd: trade.mcapUsd };
    // Creator tracking needs exact token amounts; both sources carry them (deduped by signature).
    const creator = entry.launch.creator;
    if (creator && trade.wallet === creator && typeof trade.tokens === "bigint") this.#creatorTrade(entry, trade);
    // Pump.fun logs and Solami Blur can both report the same trade: count one source per token,
    // preferring Blur (USD volume on every DEX) when it's on.
    const want = this.cfg.flowSource || (f.source ??= trade.source || "unknown");
    f.source = want;
    if (want !== (trade.source || "unknown")) return;
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
    if (trade.signature) {
      const id = `${trade.signature}:${trade.side}`;
      if (dev.sigs.has(id)) return;
      dev.sigs.add(id);
    }
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
      for (const f of entry.preFlags || []) this.flagOutcomes[f].dumped++;
    }
    if (entry.status === "done") this.#score(entry, true);
  }

  // Creator moving tokens to other wallets (not into a pool/curve, which is a sell): a common way
  // to split a bag across wallets and dump it without showing up as "the creator sold".
  onTransfer(t) {
    const entry = this.tokens.get(t.mint);
    const creator = entry?.launch.creator;
    if (!creator || t.kind !== "transfer" || t.from !== creator || !t.to || t.to === creator || entry.pools.has(t.to) || !t.amount) return;
    const id = `${t.signature}:${t.to}`;
    if (entry.dev.sigs.has(id)) return;
    entry.dev.sigs.add(id);
    entry.dev.movedOut += t.amount;
    const base = entry.dev.bought > 0n ? entry.dev.bought : null;
    const pct = base ? Math.min(100, Number((entry.dev.movedOut * 10000n) / base) / 100) : null;
    entry.dev.movedPct = pct;
    entry.dev.movedAfterSec = (Date.now() - entry.launch.seenAt) / 1000;
    if (pct >= 50 && !entry.dev.moved) {
      entry.dev.moved = true;
      this.counters.creatorTransfers++;
    }
    if (entry.status === "done") this.#score(entry, true);
  }

  // Liquidity removed by the creator: the classic rug on AMM launches.
  onLiquidity(l) {
    const entry = this.tokens.get(l.mint);
    if (!entry) return;
    if (l.pool) entry.pools.add(l.pool);
    const creator = entry.launch.creator;
    if (l.kind !== "remove" || !creator || l.provider !== creator) return;
    if (entry.lp.removedUsd === 0) this.counters.liquidityPulls++;
    entry.lp.removedUsd += l.usd || 0;
    entry.lp.afterSec = (Date.now() - entry.launch.seenAt) / 1000;
    if (entry.status === "done") this.#score(entry, true);
  }

  onGraduation(g) {
    const entry = this.tokens.get(g.mint);
    if (!entry || entry.graduated) return;
    this.counters.graduations++;
    entry.graduated = { dex: g.dex, launchpad: g.launchpad, pool: g.pool };
    if (g.pool) entry.pools.add(g.pool);
    if (entry.status === "done") this.#score(entry, true);
  }

  onSurge(s) {
    const entry = this.tokens.get(s.mint);
    if (!entry) return;
    this.counters.surges++;
    entry.surge = { multiple: s.multiple, volumeUsd: s.volumeUsd, windowSecs: s.windowSecs };
    if (entry.status === "done") this.#score(entry, true);
  }

  onMarket(m) {
    const entry = this.tokens.get(m.mint);
    if (!entry) return;
    entry.market = { ...entry.market, liquidityUsd: m.liquidityUsd, mcapUsd: m.mcapUsd ?? entry.market?.mcapUsd, buys5m: m.buys5m, sells5m: m.sells5m };
    this.emit("update", this.view(entry));
  }

  // Tokens worth following on a per-token stream (newest first).
  trackedMints(limit = 300) {
    return this.order.slice(0, limit);
  }

  // (Re)score from the stored report; live events like a creator dump can raise the level later.
  #score(entry, live = false) {
    const before = entry.risk?.level;
    const dev = entry.dev;
    const ctx = {
      ...entry.ctx,
      creatorSold: dev.soldPct >= 20 ? { pct: dev.soldPct, afterSec: dev.afterSec } : null,
      creatorMoved: dev.movedPct >= 20 ? { pct: dev.movedPct, afterSec: dev.movedAfterSec } : null,
      liquidityPulled: entry.lp.removedUsd > 0 ? { usd: entry.lp.removedUsd, afterSec: entry.lp.afterSec } : null,
      graduated: entry.graduated,
      surge: entry.surge,
    };
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
      const report = await analyzeToken(this.rpc, entry.mint, { withCreator: !this.cfg.lightMode, withHolders: !this.cfg.lightMode, knownCreator: entry.launch.creator || null });
      if (!report.metadata && entry.launch.name) report.metadata = { source: "launch-event", name: entry.launch.name, symbol: entry.launch.symbol, isMutable: false };
      if (!report.creator && entry.launch.creator) report.creator = { address: entry.launch.creator };
      entry.report = report;
      entry.ctx = this.#context(entry);
      // Level before any selling was seen: used to measure whether the score predicts dumps.
      const pre = scoreReport(report, entry.ctx);
      entry.preLevel = pre.category === "launch" ? pre.level : null;
      if (entry.preLevel) this.outcomes[entry.preLevel].n++;
      if (entry.preLevel && entry.dev.dumped) this.outcomes[entry.preLevel].dumped++;
      if (entry.preLevel) {
        entry.preFlags = pre.flags.length ? [...new Set(pre.flags.map((f) => f.id))] : ["no_flags"];
        for (const f of entry.preFlags) {
          this.flagOutcomes[f] ??= { n: 0, dumped: 0 };
          this.flagOutcomes[f].n++;
          if (entry.dev.dumped) this.flagOutcomes[f].dumped++;
        }
      }
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
      creatorMovedPct: entry.dev.movedPct ?? null,
      lpRemovedUsd: entry.lp.removedUsd ? Math.round(entry.lp.removedUsd) : null,
      market: entry.market,
      graduated: entry.graduated,
      surge: entry.surge,
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
      creatorTransfers: this.counters.creatorTransfers,
      liquidityPulls: this.counters.liquidityPulls,
      graduations: this.counters.graduations,
      surges: this.counters.surges,
      byLaunchpad: this.counters.byLaunchpad,
      flagOutcomes: Object.fromEntries(Object.entries(this.flagOutcomes).sort((a, b) => b[1].n - a[1].n).map(([k, o]) => [k, { ...o, pctDumped: o.n ? Math.round((100 * o.dumped) / o.n) : null }])),
      outcomes: Object.fromEntries(Object.entries(this.outcomes).map(([k, o]) => [k, { ...o, pctDumped: o.n ? Math.round((100 * o.dumped) / o.n) : null }])),
      pctMintAuthority: pct("mint_authority"),
      pctFreezeAuthority: pct("freeze_authority"),
      pctImpersonation: Math.round((100 * ((this.counters.flags.homoglyph || 0) + (this.counters.flags.brand_copy || 0) + (this.counters.flags.impersonation || 0) + (this.counters.flags.bait || 0))) / a),
      pctToken2022Traps: Math.round((100 * ["permanent_delegate", "non_transferable", "default_frozen", "pausable", "transfer_hook", "transfer_fee"].reduce((s, id) => s + (this.counters.flags[id] || 0), 0)) / a),
      rpc: { requests: this.rpc.stats.requests, errors: this.rpc.stats.errors, retries: this.rpc.stats.retries, throttled: this.rpc.stats.throttled ?? 0, intervalMs: this.rpc.intervalMs?.() ?? 0, lastError: this.rpc.stats.lastError ?? null, avgLatencyMs: this.rpc.avgLatencyMs() },
    };
  }

  list(limit = 100) {
    return this.order.slice(0, limit).map((m) => this.view(this.tokens.get(m)));
  }
}
