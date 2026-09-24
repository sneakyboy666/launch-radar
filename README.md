# Launch Radar

**Real-time safety radar for new Solana tokens, powered by [Solami](https://solami.dev).**

Every minute, dozens of new tokens launch on Solana. Some are fine. Many hide traps that
only show up after you buy: a creator who can still mint unlimited supply, a freeze switch,
a Token-2022 *permanent delegate* that can take tokens out of any wallet, a hidden transfer
fee, a symbol spelled with Cyrillic look-alike letters, or a wallet that has launched ten
copies of the same coin in an hour.

Launch Radar watches mainnet as tokens are created, checks each one on-chain within
seconds, and explains the risk in plain English.

**Videos:** [2.5-minute live demo](https://youtu.be/z-sno935awo) ·
[2-minute pitch](https://youtu.be/ucMbo0HFogo)
(recorded from the live dashboard on mainnet; nothing staged)

- **Live feed:** Pump.fun launches (decoded straight from program logs) plus every new
  Token-2022 mint that initializes a dangerous extension ("trap watch"), plus Solami Blur
  market events.
- **Explainable risk score (0–100):** each point comes with a sentence saying what was found
  and why it matters. No black box.
- **Trade flow + dev-dump detection:** every Pump.fun buy/sell is decoded from the same log stream
  (`TradeEvent`), so the radar sees the creator selling seconds after launch and re-scores the
  token live. With a Solami key, Blur's decoded trades add USD volume across venues.
- **Checks its own predictions:** for every red flag present at launch, tracks how often the
  creator dumped afterwards, live. (Result so far: no launch-time flag predicts a dump; see below.)
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
| Homoglyphs | Unicode script check, per word | "BITCОIN" spelled with a Cyrillic О (live catches: "MultiPаir", "musеboоk") |
| Bait | giveaway/airdrop wording, links in the name | "FREE 1 SOL / GIVEAWAY" tokens that lure people to wallet drainers |
| Whale concentration | `getTokenLargestAccounts` + owner programs | Pools/bonding curves are recognized and excluded |
| Creator holdings | earliest signature's fee payer | How much the deployer still holds |
| Who holds each power | ed25519 on-curve check + owner program lookup | A permanent delegate in a *wallet* is a trap; in a *program address* (PDA) it's usually a protocol (prediction-market shares, vault/LP tokens) |
| Creator dump (live) | Pump.fun `TradeEvent` from the log stream | Creator sells most of their bag right after launch: the classic pump-and-dump |
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

### Can you predict a dump at launch? We measured it (live, Solami, 15 minutes, 2026-09-23)

The radar remembers which red flags each token had at launch, then watches whether its creator
sells at least half their tokens. Unfiltered results from 432 launches:

| Red flag at launch | Tokens | Creator dumped within minutes |
|---|---|---|
| none | 167 | **56%** |
| serial launcher (3+ launches in an hour) | 132 | 52% |
| whale holder | 39 | 49% |
| creator holds 10%+ | 61 | 39% |
| copycat name | 149 | 34% |

**Finding: launch-time red flags do not predict a creator dump. About half of memecoin creators
dump regardless.** (An earlier 10-minute run on the public RPC showed 82% vs 50%; it did not
replicate, so we don't claim it.) That is why Launch Radar watches the creator *live*: Pump.fun
trade events and Solami Blur swaps, transfers and liquidity changes re-score a token within
seconds of the creator selling, moving tokens out, or pulling liquidity. The static checks answer a
different question: what the creator *can* do (mint more, freeze you, pull tokens with a permanent
delegate, tax sells), which no amount of trading data shows. The dashboard keeps measuring this live
("Best dump predictor").

### Reliability

On a free Solami key, a 15-minute live run analyzed 432 of 435 launches (Pump.fun, Raydium
LaunchLab, Meteora DBC) with 1,863 RPC calls, 0 RPC errors and 160 ms average latency, while Blur
streamed ~50k swaps and ~6k transfers for the tracked tokens. Every stream has a stall watchdog: if a
socket stays open but goes quiet for 30 s (seen on the public RPC), it is dropped and
reconnected with backoff.

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
