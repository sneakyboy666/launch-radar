# Launch Radar

**Real-time safety radar for new Solana tokens, powered by [Solami](https://solami.dev).**

Every minute, dozens of new tokens launch on Solana. Some are fine. Many hide traps that
only show up after you buy: a creator who can still mint unlimited supply, a freeze switch,
a Token-2022 *permanent delegate* that can take tokens out of any wallet, a hidden transfer
fee, a symbol spelled with Cyrillic look-alike letters, or a wallet that has launched ten
copies of the same coin in an hour.

Launch Radar watches mainnet as tokens are created, checks each one on-chain within
seconds, and explains the risk in plain English.

- **Live feed:** Pump.fun launches (decoded straight from program logs) plus every new
  Token-2022 mint that initializes a dangerous extension ("trap watch"), plus Solami Blur
  market events.
- **Explainable risk score (0–100):** each point comes with a sentence saying what was found
  and why it matters. No black box.
- **Trade flow:** buy/sell counts, USD volume, unique wallets and buy pressure per token from
  Solami Blur's decoded trades.
- **Alerts:** HIGH/CRITICAL launches to a Discord (or any) webhook.
- **Check any token:** `launch-radar check <mint>` or the dashboard's "Check any token" box.
- **Zero dependencies:** Node 22+ and nothing else. `npm test` runs offline.

## What it checks

| Check | How | Why it matters |
|---|---|---|
| Mint authority | `getAccountInfo` (jsonParsed) | Creator can print unlimited supply and dump it |
| Freeze authority | same | Creator can freeze your tokens so you can't sell |
| Token-2022 permanent delegate | mint extensions | Delegate can move or burn tokens from any wallet |
| Token-2022 non-transferable / default-frozen / pausable | mint extensions | You may be unable to sell at all |
| Token-2022 transfer hook / transfer fee (+ fee authority) | mint extensions | Sells can be blocked or taxed, and fees raised later |
| Mutable metadata | Metaplex metadata PDA (derived locally) or Token-2022 metadata | Name/logo can be swapped after launch |
| Impersonation | symbol vs. official mints, brand list | "USDC" that isn't USDC |
| Homoglyphs | Unicode script check | "BITCОIN" spelled with a Cyrillic О |
| Whale concentration | `getTokenLargestAccounts` + owner programs | Pools/bonding curves are recognized and excluded |
| Creator holdings | earliest signature's fee payer | How much the deployer still holds |
| Who holds each power | ed25519 on-curve check + owner program lookup | A permanent delegate in a *wallet* is a trap; in a *program address* (PDA) it's usually a protocol (prediction-market shares, vault/LP tokens) |
| Serial launcher | radar memory (1 h window) | Same wallet launching token after token |
| Copycat wave | normalized name/symbol (1 h window) | Ten "WEIRDCAT"s in an hour |

Official assets (USDC, USDT, PYUSD, …) are labelled **KNOWN**; their issuer controls are shown
as notes instead of scam flags.

**Protocol tokens vs. traps.** In a live soak test, about a quarter of new tokens with dangerous
Token-2022 powers were prediction-market outcome tokens ("BTC Up", "JUP BTC 5M NO", …) minted every
few minutes, where the permanent delegate and mint authority are program addresses (PDAs). A naive
scanner flags all of them CRITICAL. Launch Radar checks whether each authority is on the ed25519
curve (a key someone holds) or off it (only a program can sign), looks up the owning program,
discounts program-held powers, labels the token **protocol**, and keeps them out of the scam
statistics and alerts. Same powers in a personal wallet stay CRITICAL.

## How it uses Solami

| Solami product | Used for |
|---|---|
| **RPC** (`rpc.solami.dev/sol`) | All on-chain checks: mint + extensions, metadata, largest holders, owner programs, creator lookup, transaction decoding for trap watch |
| **WebSocket RPC** (`rpc.solami.dev/ws/sol`) | `logsSubscribe` on Pump.fun and the Token-2022 program (the trap watch filters ~900 log messages/sec down to the rare risky mints) |
| **Blur** (`ws.solami.dev/data/subscribe`) | Decoded trades and launches: per-token buy/sell flow, volume, unique wallets, buy pressure |

With a Solami key the radar runs **full analysis on every launch** (Pro: 200 rps). Without one it
falls back to the public RPC in *light mode* (authorities, extensions and metadata only), so
anyone can try it, and Solami's value is visible side by side.

## Run it

```bash
git clone <this repo> && cd launch-radar
cp .env.example .env        # add SOLAMI_API_KEY (free 7-day Pro: https://solami.dev/signup?ref=st-earn-sep-26)
npm start                   # live radar + dashboard at http://127.0.0.1:8787
```

```bash
node src/cli.js check 2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo   # one-off report (PYUSD)
node src/cli.js check <mint> --json                                  # machine-readable
node src/cli.js discover 60                                          # record raw Blur messages
npm test                                                             # unit tests, no network
```

Environment variables: see `.env.example` (`SOLAMI_API_KEY`, `WEBHOOK_URL`, `ALERT_LEVEL`, `PORT`,
`LIGHT_MODE`, `TRAP_WATCH`, `RPC_URL`, `WS_URL`).

## Architecture

```
 Solami WS (logsSubscribe) ──► Pump.fun CreateEvent decoder ─┐
 Solami WS (logsSubscribe) ──► Token-2022 trap watch ─────────┤──► Radar queue ──► analyzeToken (Solami RPC) ──► scoreReport ──► dashboard (SSE) / alerts / CLI
 Solami Blur (WebSocket) ────► normalizer ─── trades ─────────┘         ▲
                                                            launches ───┘
```

- `src/solana.js`: base58, ed25519 on-curve check and PDA derivation, rate-limited RPC client with retries
- `src/token.js`: on-chain data collection (mint, extensions, metadata, holders, creator)
- `src/score.js`: pure, explainable scoring
- `src/sources/`: launch and trade sources (Pump.fun logs, Token-2022 trap watch, Solami Blur)
- `src/radar.js`: queue, metrics, copycat/serial-launcher memory
- `src/server.js` + `web/index.html`: live dashboard and JSON API (`/api/state`, `/api/check?mint=`)

## Limits (honest)

Scores are heuristics built from on-chain facts. They can't see off-chain promises, team
identity, or intent, and a LOW score is not a recommendation to buy. This is not financial advice.

Built for the Colosseum hackathon with help from AI coding tools; every check is covered by tests
and was run against live mainnet.

MIT License.
