import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { base58Decode, base58Encode, isOnCurve, metadataPda } from "../src/solana.js";
import { authorityAddresses, classifyControllers, parseMetaplexMetadata, summarizeMint } from "../src/token.js";
import { scoreReport } from "../src/score.js";
import { decodePumpCreateEvent } from "../src/sources/rpcLogs.js";
import { riskyExtensionsInLogs, mintsFromParsedTx } from "../src/sources/token2022Watch.js";
import { normalizeBlurEvent } from "../src/sources/solamiBlur.js";
import { nameKey } from "../src/radar.js";

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

test("Blur normalizer accepts several field spellings", () => {
  assert.equal(normalizeBlurEvent({ type: "swap", mint: USDC, side: "BUY", volume_usd: "12.5" }).usd, 12.5);
  assert.equal(normalizeBlurEvent({ event: "trade", token_address: USDC, is_buy: false }).side, "sell");
  assert.equal(normalizeBlurEvent({ type: "new_token", base_mint: USDC, token_symbol: "X" }).type, "launch");
  assert.equal(normalizeBlurEvent({ type: "swap", mint: "not-a-key" }), null);
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
