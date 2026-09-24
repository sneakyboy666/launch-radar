import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { base58Decode, base58Encode, isOnCurve, metadataPda, Rpc } from "../src/solana.js";
import { createServer } from "node:http";
import { analyzeToken, authorityAddresses, classifyControllers, parseMetaplexMetadata, summarizeMint } from "../src/token.js";
import { scoreReport } from "../src/score.js";
import { decodePumpCreateEvent, decodePumpTradeEvent } from "../src/sources/rpcLogs.js";
import { riskyExtensionsInLogs, mintsFromParsedTx } from "../src/sources/token2022Watch.js";
import { normalizeBlurEvent } from "../src/sources/solamiBlur.js";
import { nameKey, Radar } from "../src/radar.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const clean = (over = {}) => ({ mint: "Fake1111111111111111111111111111111111111111", token: { mintAuthority: null, freezeAuthority: null, extensions: {} }, metadata: { name: "Cat", symbol: "CAT", isMutable: false }, ...over });
const ids = (r) => r.flags.map((f) => f.id);

test("base58 round-trips and keeps leading zeros", () => {
  assert.equal(base58Encode(base58Decode(USDC)), USDC);
  assert.equal(base58Encode(Uint8Array.of(0, 0, 1)), "112");
  assert.equal(base58Decode("11111111111111111111111111111111").length, 32);
});

test("metadata PDA matches the on-chain USDC metadata account", () => {
  // verified live: owned by the Metaplex program, first byte = 4 (MetadataV1)
  assert.equal(metadataPda(USDC), "5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq");
  assert.equal(isOnCurve(base58Decode(metadataPda(USDC))), false);
  assert.equal(isOnCurve(base58Decode(USDC)), true);
});

test("Metaplex metadata parser reads name, symbol, authority and mutability", () => {
  const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const buf = Buffer.concat([Buffer.from([4]), Buffer.from(base58Decode(USDC)), Buffer.from(base58Decode(USDC)), str("Weird Cat\0\0"), str("WCAT"), str("https://x"), Buffer.from([0, 0]), Buffer.from([0]), Buffer.from([1]), Buffer.from([1])]);
  const md = parseMetaplexMetadata(buf);
  assert.equal(md.name, "Weird Cat");
  assert.equal(md.symbol, "WCAT");
  assert.equal(md.isMutable, true);
  assert.equal(md.updateAuthority, USDC);
});

test("mint summary picks up Token-2022 extensions", () => {
  const m = summarizeMint({ value: { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: { parsed: { type: "mint", info: { decimals: 6, supply: "1000", mintAuthority: null, freezeAuthority: null, extensions: [{ extension: "permanentDelegate", state: { delegate: USDC } }, { extension: "nonTransferable" }] } } } } });
  assert.equal(m.program, "token-2022");
  assert.equal(m.extensions.permanentDelegate.delegate, USDC);
  assert.equal(m.extensions.nonTransferable, true);
});

test("clean token scores LOW with positives", () => {
  const r = scoreReport(clean());
  assert.equal(r.level, "LOW");
  assert.equal(r.score, 0);
  assert.ok(r.positives.some((p) => p.includes("Mint authority revoked")));
});

test("live authorities and Token-2022 traps drive the score", () => {
  const r = scoreReport(clean({ token: { mintAuthority: USDC, freezeAuthority: USDC, extensions: { permanentDelegate: { delegate: USDC } } } }));
  assert.equal(r.level, "CRITICAL");
  assert.deepEqual(ids(r).slice(0, 3), ["permanent_delegate", "mint_authority", "freeze_authority"]);
});

test("transfer fee is scored by size", () => {
  const r = scoreReport(clean({ token: { mintAuthority: null, freezeAuthority: null, extensions: { transferFeeConfig: { newerTransferFee: { transferFeeBasisPoints: 1500 }, transferFeeConfigAuthority: USDC } } } }));
  const fee = r.flags.find((f) => f.id === "transfer_fee");
  assert.equal(fee.points, 30);
  assert.ok(ids(r).includes("fee_authority"));
});

test("impersonation, homoglyphs and brand copies", () => {
  assert.ok(ids(scoreReport(clean({ metadata: { name: "USD Coin", symbol: "USDC", isMutable: false } }))).includes("impersonation"));
  assert.ok(ids(scoreReport(clean({ metadata: { name: "BITCОIN", symbol: "BTC", isMutable: false } }))).includes("homoglyph"));
  assert.ok(ids(scoreReport(clean({ metadata: { name: "Edgevana Staked SOL", symbol: "edgeSOL", isMutable: false } }))).includes("brand_copy"));
  assert.ok(!ids(scoreReport(clean({ metadata: { name: "Wager on Solana", symbol: "WAGER", isMutable: false } }))).includes("brand_copy"));
});

test("official assets are KNOWN, with issuer controls as notes", () => {
  const r = scoreReport(clean({ mint: USDC, token: { mintAuthority: USDC, freezeAuthority: USDC, extensions: {} }, metadata: { name: "USD Coin", symbol: "USDC", isMutable: true, updateAuthority: USDC } }));
  assert.equal(r.level, "KNOWN");
  assert.equal(r.flags.length, 0);
  assert.ok(r.notes.some((n) => n.includes("Mint authority")));
});

test("pools are excluded from whale concentration", () => {
  const holders = [{ pct: 80, pool: "Pump.fun bonding curve" }, { pct: 5, pool: null }, { pct: 3, pool: null }];
  assert.ok(!ids(scoreReport(clean({ holders }))).includes("top_holder"));
  assert.ok(ids(scoreReport(clean({ holders: [{ pct: 60, pool: null }] }))).includes("top_holder"));
});

test("serial launcher and copycat context", () => {
  assert.deepEqual(ids(scoreReport(clean(), { creatorLaunches: 3, sameNameLaunches: 2 })), ["serial_launcher", "copycat"]);
  assert.equal(nameKey({ symbol: "$Weird-Cat" }), "WEIRDCAT");
});

test("pump.fun CreateEvent decoder", () => {
  const disc = createHash("sha256").update("event:CreateEvent").digest().subarray(0, 8);
  const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const k = Buffer.from(base58Decode(USDC));
  const evt = decodePumpCreateEvent(Buffer.concat([disc, str("Weird Cat"), str("WCAT"), str("https://ipfs/x"), k, k, k]).toString("base64"));
  assert.equal(evt.name, "Weird Cat");
  assert.equal(evt.mint, USDC);
  assert.equal(decodePumpCreateEvent(Buffer.alloc(200).toString("base64")), null);
});

test("Token-2022 trap watch spots risky extension inits and extracts the mint", () => {
  const logs = ["Program log: Instruction: InitializePermanentDelegate", "Program log: Instruction: InitializeMint2"];
  assert.deepEqual(riskyExtensionsInLogs(logs), ["permanent delegate"]);
  assert.deepEqual(riskyExtensionsInLogs(["Program log: Instruction: InitializeMint2"]), []);
  const tx = { transaction: { message: { instructions: [] } }, meta: { innerInstructions: [{ instructions: [{ programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", parsed: { type: "initializeMint2", info: { mint: USDC } } }] }] } };
  assert.deepEqual(mintsFromParsedTx(tx), [USDC]);
});

// Real Solami Blur frames captured from mainnet (test/fixtures/blur.json).
const BLUR = JSON.parse(readFileSync(new URL("./fixtures/blur.json", import.meta.url), "utf8"));

test("Blur normalizer maps real frames", () => {
  const swap = normalizeBlurEvent(BLUR.swap);
  assert.equal(swap.type, "trade");
  assert.ok(["buy", "sell"].includes(swap.side));
  assert.ok(swap.usd > 0 && typeof swap.tokens === "bigint" && swap.sol > 0 && swap.mcapUsd > 0);
  assert.equal(swap.wallet, BLUR.swap.trader);
  const launch = normalizeBlurEvent(BLUR.token_create);
  assert.equal(launch.type, "launch");
  assert.equal(launch.creator, BLUR.token_create.creator);
  assert.match(launch.source, /^solami: /);
  const tr = normalizeBlurEvent(BLUR.transfer);
  assert.equal(tr.type, "transfer");
  assert.equal(typeof tr.amount, "bigint");
  const lq = normalizeBlurEvent(BLUR.liquidity);
  assert.equal(lq.mint, BLUR.liquidity.base_mint);
  assert.ok(["add", "remove"].includes(lq.kind) && lq.usd > 0);
  assert.equal(normalizeBlurEvent(BLUR.token_update).type, "market");
  assert.equal(normalizeBlurEvent({ type: "movers", rows: [] }), null);
  assert.equal(normalizeBlurEvent({ type: "swap", mint: "not-a-key" }), null);
  // Fractional values are decimal strings; raw amounts may be strings too.
  assert.equal(normalizeBlurEvent({ type: "transfer", mint: USDC, amount: "18446744073709551615" }).amount, 18446744073709551615n);
});

// Real mainnet case: "BTC Up" prediction-market share (6Y6MDqMj…). Mint authority, permanent
// delegate and metadata authority are all one PDA owned by the market program.
const MARKET_PDA = "EvRBeUoj2bsmWbgFU9gE8ywfeD6FnLdWen4pPKsZfNNu";
const MARKET_PROGRAM = "prediCtPZCttYMvm2W3PtxmMxLmT1dtN7riU6Cxh6tM";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // an ordinary on-curve key

test("authority holders are classified as wallet or program (PDA)", async () => {
  assert.equal(isOnCurve(base58Decode(MARKET_PDA)), false);
  assert.equal(isOnCurve(base58Decode(WALLET)), true);
  const token = summarizeMint({ value: { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: { parsed: { type: "mint", info: { decimals: 6, supply: "0", mintAuthority: MARKET_PDA, freezeAuthority: WALLET, extensions: [{ extension: "permanentDelegate", state: { delegate: MARKET_PDA } }] } } } } });
  const auth = authorityAddresses(token, { isMutable: true, updateAuthority: MARKET_PDA });
  assert.deepEqual(auth, { mint_authority: MARKET_PDA, freeze_authority: WALLET, permanent_delegate: MARKET_PDA, mutable_metadata: MARKET_PDA });
  const calls = [];
  const rpc = { call: async (method, params) => (calls.push([method, params[0]]), { value: [{ owner: MARKET_PROGRAM }] }) };
  const ctl = await classifyControllers(rpc, Object.values(auth));
  assert.deepEqual(ctl[MARKET_PDA], { kind: "program", program: MARKET_PROGRAM });
  assert.deepEqual(ctl[WALLET], { kind: "wallet", program: null });
  assert.deepEqual(calls, [["getMultipleAccounts", [MARKET_PDA]]]); // one lookup, PDAs only
});

test("program-held powers are discounted and mark the token as protocol-issued", () => {
  const base = { token: { mintAuthority: MARKET_PDA, freezeAuthority: null, extensions: { permanentDelegate: { delegate: MARKET_PDA } } }, metadata: { name: "BTC Up", symbol: "BTC-UP", isMutable: true, updateAuthority: MARKET_PDA } };
  const authorities = { mint_authority: MARKET_PDA, permanent_delegate: MARKET_PDA, mutable_metadata: MARKET_PDA };
  const asProgram = scoreReport(clean({ ...base, authorities, controllers: { [MARKET_PDA]: { kind: "program", program: MARKET_PROGRAM } } }), { creatorLaunches: 6 });
  assert.equal(asProgram.category, "protocol");
  assert.equal(asProgram.level, "MEDIUM");
  assert.ok(!ids(asProgram).includes("serial_launcher"), "market creation cadence is a note, not a flag");
  assert.ok(asProgram.notes.some((n) => n.includes("Expected for a protocol")));
  assert.ok(asProgram.flags.every((f) => f.controller === "program" && f.text.includes("Held by a program")));
  // The same powers in a personal wallet stay CRITICAL.
  const asWallet = scoreReport(clean({ ...base, authorities, controllers: { [MARKET_PDA]: { kind: "wallet", program: null } } }), { creatorLaunches: 6 });
  assert.equal(asWallet.category, "launch");
  assert.equal(asWallet.level, "CRITICAL");
  assert.ok(ids(asWallet).includes("serial_launcher"));
  // Mixed control (any power in a wallet) is not a protocol token.
  const mixed = scoreReport(clean({ ...base, authorities: { ...authorities, freeze_authority: WALLET }, token: { ...base.token, freezeAuthority: WALLET }, controllers: { [MARKET_PDA]: { kind: "program", program: MARKET_PROGRAM }, [WALLET]: { kind: "wallet", program: null } } }));
  assert.equal(mixed.category, "launch");
});

test("stall watchdog drops a quiet socket once and runs its close handler immediately", async () => {
  const { StallWatchdog, dropSocket } = await import("../src/sources/watchdog.js");
  let closes = 0;
  let closed = false;
  const ws = { onclose: () => closes++, onmessage: () => {}, close: () => (closed = true) };
  const dog = new StallWatchdog(() => dropSocket(ws), 30).start();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(closes, 1);
  assert.ok(closed);
  assert.equal(ws.onclose, null, "late close events from the old socket are ignored");
  // A stream that keeps talking is left alone.
  let stalls = 0;
  const alive = new StallWatchdog(() => stalls++, 60).start();
  const keep = setInterval(() => alive.touch(), 10);
  await new Promise((r) => setTimeout(r, 200));
  clearInterval(keep);
  alive.stop();
  assert.equal(stalls, 0);
});

test("homoglyphs only count inside a single mixed-script word", () => {
  const name = (n, s) => scoreReport(clean({ metadata: { name: n, symbol: s, isMutable: false } }));
  assert.ok(ids(name("MultiPаir", "MultiPаir")).includes("homoglyph")); // Cyrillic а, seen live
  assert.ok(ids(name("musеboоk", "MUSЕBOOK")).includes("homoglyph"));
  assert.ok(!ids(name("ΛΥΣΙΟΣ", "LYSIOS")).includes("homoglyph")); // Greek name, Latin ticker: fine
});

test("giveaway and link lures are flagged as bait", () => {
  const name = (n, s = "X") => scoreReport(clean({ metadata: { name: n, symbol: s, isMutable: false } }));
  assert.equal(name("1 SOL GIVEAWAY EVERY", "FREE 1 SOL").flags[0].id, "bait"); // seen live, 15x from one wallet
  assert.equal(name("Claim at solana-drop.xyz").flags[0].points, 25);
  assert.equal(name("t.me/moonchat").flags[0].points, 25);
  assert.deepEqual(ids(name("Free Bird", "BIRD")), []);
  assert.deepEqual(ids(name("Cat in a Hat", "HAT")), []);
});

// Captured from mainnet Pump.fun logs (a buy), 2026-09-23.
const LIVE_TRADE = "vdt/007mYe56mo+F4qGL6ocr/ToL714+I6w8UbH0yDfOVJD/p2f1jZY6tgQAAAAAC2qRsbAAAAABfwAlxbO+VlTyH4oltE2/QcQzttxu0qU8LbZ89zAu8JafY7RqAAAAAN2M1X0NAAAAlVSpDD75AQDd4LGBBgAAAJW8lsCs+gAAYIzMHfzpYbQ7d5wZFQWm4tO/RdWk20YYrXbILWF1RTVfAAAAAAAAAI11CwAAAAAAM3gzVNsth3OfNqW56305IkwTk/MFBTuKHtkVDYWRZ6ceAAAAAAAAAGOeAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAGJ1eQAAAAAAAAAAAAAAAAAAAAAAiBMAAAAAAADGugUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJY6tgQAAAAA3YzVfQ0AAADd4LGBBgAAAB4AAAAAAAAAY54DAAAAAAA=";

test("pump.fun TradeEvent decoder reads a live trade", () => {
  const t = decodePumpTradeEvent(LIVE_TRADE);
  assert.equal(t.side, "buy");
  assert.ok(t.mint.length >= 32 && t.wallet.length >= 32 && t.creator.length >= 32);
  assert.ok(t.sol > 0 && t.sol < 1000);
  assert.ok(t.tokens > 0n);
  assert.ok(t.timestamp > 1.7e9 && t.timestamp < 2e9, "timestamp is a plausible unix time");
  assert.ok(t.priceSol > 0 && t.priceSol < 1);
  assert.ok(t.curveSol >= 0 && t.curveSol < 1000);
  assert.equal(decodePumpTradeEvent(Buffer.alloc(200).toString("base64")), null);
});

test("radar tracks creator selling and re-scores a token live", async () => {
  const rpc = { stats: { requests: 0, errors: 0, retries: 0 }, avgLatencyMs: () => 0 };
  const radar = new Radar(rpc, { lightMode: true, concurrency: 1, maxQueue: 10, analyzeDelayMs: 0, alertLevel: "HIGH" });
  const alerts = [];
  radar.on("alert", (v) => alerts.push(v));
  const mint = "Fake1111111111111111111111111111111111111111";
  const dev = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  radar.onLaunch({ mint, name: "Moon", symbol: "MOON", creator: dev, source: "pump.fun", seenAt: Date.now() });
  const entry = radar.tokens.get(mint);
  // Simulate a finished analysis of a clean token (no RPC needed).
  entry.report = { mint, token: { mintAuthority: null, freezeAuthority: null, extensions: {} }, metadata: { name: "Moon", symbol: "MOON", isMutable: false }, errors: [] };
  entry.ctx = {};
  entry.preLevel = "LOW";
  radar.outcomes.LOW.n++;
  entry.status = "done";
  entry.risk = scoreReport(entry.report);
  const trade = (side, tokens, wallet = dev) => radar.onTrade({ mint, side, tokens, sol: 1, wallet, source: "pump.fun" });
  trade("buy", 1000n);
  trade("buy", 500n, "BuyerWallet11111111111111111111111111111111");
  radar.onTrade({ mint, side: "buy", usd: 50, wallet: "x", source: "solami-blur" }); // other source ignored
  assert.equal(radar.view(entry).flow.buys, 2);
  trade("sell", 300n);
  assert.equal(radar.view(entry).level, "LOW", "30% sold: noted, not enough to change the level");
  assert.ok(radar.view(entry).flags.some((f) => f.id === "creator_dump" && f.points === 15));
  trade("sell", 700n);
  const v = radar.view(entry);
  assert.equal(v.creatorSoldPct, 100);
  assert.ok(v.flags.some((f) => f.id === "creator_dump" && f.points === 35 && /sold 100%/.test(f.text)));
  assert.equal(v.level, "MEDIUM");
  assert.equal(radar.metrics().outcomes.LOW.dumped, 1);
  assert.equal(radar.metrics().creatorDumps, 1);
  assert.equal(v.flow.buyPressure, 50); // 2 SOL bought vs 2 SOL sold
});

test("creator dumps are caught even when another source feeds the flow numbers", () => {
  const rpc = { stats: { requests: 0, errors: 0, retries: 0 }, avgLatencyMs: () => 0 };
  const radar = new Radar(rpc, { lightMode: true, concurrency: 1, maxQueue: 10, analyzeDelayMs: 0, alertLevel: "HIGH" });
  const mint = "Fake2222222222222222222222222222222222222222";
  const dev = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  radar.onLaunch({ mint, name: "Moon", symbol: "MOON", creator: dev, source: "pump.fun", seenAt: Date.now() });
  radar.onTrade({ mint, side: "buy", usd: 20, wallet: "x", source: "solami-blur" }); // Blur arrives first
  radar.onTrade({ mint, side: "buy", tokens: 1000n, sol: 1, wallet: dev, source: "pump.fun" });
  radar.onTrade({ mint, side: "sell", tokens: 900n, sol: 1, wallet: dev, source: "pump.fun" });
  const v = radar.view(radar.tokens.get(mint));
  assert.equal(v.flow.source, "solami-blur");
  assert.equal(v.creatorSoldPct, 90);
  assert.equal(radar.metrics().creatorDumps, 1);
});

test("Blur-only signals: creator transfers out, liquidity pulled, graduation, surge", () => {
  const rpc = { stats: { requests: 0, errors: 0, retries: 0 }, avgLatencyMs: () => 0 };
  const radar = new Radar(rpc, { lightMode: true, concurrency: 1, maxQueue: 10, analyzeDelayMs: 0, alertLevel: "HIGH", flowSource: "solami-blur" });
  const alerts = [];
  radar.on("alert", (v) => alerts.push(v));
  const mint = "Fake3333333333333333333333333333333333333333";
  const dev = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const curve = "EvRBeUoj2bsmWbgFU9gE8ywfeD6FnLdWen4pPKsZfNNu";
  const other = "BuyerWallet11111111111111111111111111111111";
  radar.onLaunch({ mint, name: "Moon", symbol: "MOON", creator: dev, pool: curve, source: "solami: pumpfun", dex: "pumpfun", seenAt: Date.now() });
  const entry = radar.tokens.get(mint);
  entry.report = { mint, token: { mintAuthority: null, freezeAuthority: null, extensions: {} }, metadata: { name: "Moon", symbol: "MOON", isMutable: false }, errors: [] };
  entry.ctx = {};
  entry.status = "done";
  entry.risk = scoreReport(entry.report);
  // Same dev buy reported by both sources: counted once. Flow comes from Blur only.
  radar.onTrade({ mint, side: "buy", tokens: 1000n, sol: 1, wallet: dev, signature: "S1", source: "pump.fun" });
  radar.onTrade({ mint, side: "buy", tokens: 1000n, usd: 150, wallet: dev, signature: "S1", source: "solami-blur" });
  assert.equal(entry.dev.bought, 1000n);
  assert.equal(radar.view(entry).flow.buys, 1);
  assert.equal(radar.view(entry).flow.buyUsd, 150);
  // Tokens into the bonding curve are a sell, not a transfer; tokens to another wallet are.
  radar.onTransfer({ mint, kind: "transfer", from: dev, to: curve, amount: 900n, signature: "S2" });
  assert.equal(entry.dev.movedOut, 0n);
  radar.onTransfer({ mint, kind: "transfer", from: dev, to: other, amount: 600n, signature: "S3" });
  radar.onTransfer({ mint, kind: "transfer", from: dev, to: other, amount: 600n, signature: "S3" }); // duplicate frame
  let v = radar.view(entry);
  assert.equal(v.creatorMovedPct, 60);
  assert.ok(v.flags.some((f) => f.id === "creator_transfer" && f.points === 20));
  // Creator pulls liquidity: strongest rug signal, raises the level and alerts.
  radar.onLiquidity({ mint, kind: "remove", provider: dev, usd: 4200, pool: "Pool1111111111111111111111111111111111111111" });
  v = radar.view(entry);
  assert.ok(v.flags.some((f) => f.id === "liquidity_pulled" && /\$4,200/.test(f.text)));
  assert.equal(v.level, "HIGH");
  assert.equal(alerts.length, 1);
  radar.onGraduation({ mint, launchpad: "pumpfun", dex: "pumpswap", pool: "Pool2222222222222222222222222222222222222222" });
  radar.onSurge({ mint, multiple: 4, volumeUsd: 12000, windowSecs: 300 });
  v = radar.view(entry);
  assert.ok(v.notes.some((n) => /Graduated from pumpfun to a pumpswap pool/.test(n)));
  assert.ok(v.notes.some((n) => /Volume surge: 4x/.test(n)));
  const m = radar.metrics();
  assert.deepEqual([m.creatorTransfers, m.liquidityPulls, m.graduations, m.surges], [1, 1, 1, 1]);
  assert.equal(m.byLaunchpad.pumpfun, 1);
  assert.deepEqual(radar.trackedMints(), [mint]);
});

test("RPC client backs off on HTTP 429 and still returns the result", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (hits <= 2) {
      res.writeHead(429, { "retry-after": "0" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const rpc = new Rpc(`http://127.0.0.1:${server.address().port}`, { minIntervalMs: 0 });
  try {
    assert.equal(await rpc.call("getSlot"), 42);
    assert.equal(rpc.stats.throttled, 2);
    assert.ok(rpc.intervalMs() >= 220, "paces itself below the plan's limit after a 429");
  } finally {
    server.close();
  }
});

test("holders: owners read from raw bytes; program accounts (PDAs) are not whales", async () => {
  // Mimics an RPC that returns base64 only (no jsonParsed) from getMultipleAccounts.
  const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const curve = "HVTvkZY9jrT5kGJwt6eANVG8MG4ZvnumDqt4GSXWMa5i"; // owned by Pump.fun
  const agentPda = MARKET_PDA; // off-curve, owned by the System Program
  const person = WALLET; // on-curve
  const owners = { TA1: agentPda, TA2: curve, TA3: person };
  const rpc = {
    call: async (method, params) => {
      if (method === "getAccountInfo" && params[1]?.encoding === "jsonParsed")
        return { value: { owner: T22, data: { parsed: { type: "mint", info: { decimals: 6, supply: "1000000", mintAuthority: null, freezeAuthority: null, extensions: [] } } } } };
      if (method === "getAccountInfo") return { value: null }; // no Metaplex metadata
      if (method === "getTokenLargestAccounts") return { value: [{ address: "TA1", amount: "500000" }, { address: "TA2", amount: "450000" }, { address: "TA3", amount: "50000" }] };
      if (method === "getMultipleAccounts" && params[1]?.dataSlice?.offset === 32)
        return { value: params[0].map((a) => ({ data: [Buffer.from(base58Decode(owners[a])).toString("base64"), "base64"] })) };
      if (method === "getMultipleAccounts") return { value: params[0].map((o) => ({ owner: o === curve ? PUMP : "11111111111111111111111111111111" })) };
      throw new Error(`unexpected ${method}`);
    },
  };
  const r = await analyzeToken(rpc, USDC, { knownCreator: person });
  assert.deepEqual(r.holders.map((h) => h.pool), ["program account", "Pump.fun bonding curve", null]);
  assert.equal(r.creator.pct, 5);
  const risk = scoreReport(r);
  assert.ok(!ids(risk).includes("top_holder"), "only the 5% person counts toward concentration");
});

test("launchpad tokens with program-held powers stay launches (not protocol tokens)", () => {
  const base = { token: { mintAuthority: null, freezeAuthority: null, extensions: { transferFeeConfig: { newerTransferFee: { transferFeeBasisPoints: 100 }, transferFeeConfigAuthority: MARKET_PDA } } }, metadata: { name: "Faji", symbol: "FAJI", isMutable: true, updateAuthority: MARKET_PDA } };
  const r = clean({ ...base, authorities: { fee_authority: MARKET_PDA, mutable_metadata: MARKET_PDA }, controllers: { [MARKET_PDA]: { kind: "program", program: MARKET_PROGRAM } } });
  const pad = scoreReport(r, { viaLaunchpad: true, creatorLaunches: 5 });
  assert.equal(pad.category, "launch");
  assert.ok(ids(pad).includes("serial_launcher"), "a person launched it: serial launching still counts");
  assert.ok(pad.notes.some((n) => /launchpad's program/.test(n)));
  assert.equal(scoreReport(r, {}).category, "protocol");
});

test("per-flag outcomes: which red flags at launch were followed by a creator dump", () => {
  const rpc = { stats: { requests: 0, errors: 0, retries: 0 }, avgLatencyMs: () => 0 };
  const radar = new Radar(rpc, { lightMode: true, concurrency: 1, maxQueue: 10, analyzeDelayMs: 0, alertLevel: "HIGH" });
  const dev = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const mints = ["Fake4444444444444444444444444444444444444444", "Fake5555555555555555555555555555555555555555"];
  mints.forEach((mint, i) => {
    radar.onLaunch({ mint, name: "Moon", symbol: "MOON" + i, creator: dev, source: "pump.fun", dex: "pumpfun", seenAt: Date.now() });
    const e = radar.tokens.get(mint);
    e.report = { mint, token: { mintAuthority: i === 0 ? dev : null, freezeAuthority: null, extensions: {} }, metadata: { name: "Moon", symbol: "MOON" + i, isMutable: false }, errors: [] };
    e.ctx = {};
    const pre = scoreReport(e.report, e.ctx);
    e.preLevel = pre.level;
    e.preFlags = pre.flags.length ? pre.flags.map((f) => f.id) : ["no_flags"];
    for (const f of e.preFlags) (radar.flagOutcomes[f] ??= { n: 0, dumped: 0 }).n++;
    e.status = "done";
    e.risk = pre;
  });
  // Only the token that launched with a live mint authority gets dumped.
  radar.onTrade({ mint: mints[0], side: "buy", tokens: 100n, wallet: dev, source: "pump.fun" });
  radar.onTrade({ mint: mints[0], side: "sell", tokens: 100n, wallet: dev, source: "pump.fun" });
  const fo = radar.metrics().flagOutcomes;
  assert.deepEqual(fo.mint_authority, { n: 1, dumped: 1, pctDumped: 100 });
  assert.deepEqual(fo.no_flags, { n: 1, dumped: 0, pctDumped: 0 });
});

test("Token-2022 mints found in raw transactions (RPCs that don't parse inner instructions)", () => {
  const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const payer = WALLET, mint = USDC, other = MARKET_PDA;
  const b58 = (bytes) => base58Encode(Uint8Array.from(bytes));
  const tx = {
    transaction: { message: { accountKeys: [payer, T22], instructions: [{ programIdIndex: 1, accounts: [3], data: b58([20, 6]) }] } },
    meta: {
      loadedAddresses: { writable: [other], readonly: [mint] },
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2], data: b58([7, 1]) }] }], // opcode 7 = MintTo: ignored
    },
  };
  assert.deepEqual(mintsFromParsedTx(tx), [mint]); // index 3 resolves through the lookup-table addresses
});
