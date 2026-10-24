# Solana Wallet Intel — pay-per-call wallet intelligence for AI agents — by falcon.sol

Live API: **https://solana-wallet-intel-phi.vercel.app**
MCP server (streamable HTTP, POST JSON-RPC): **https://solana-wallet-intel-phi.vercel.app/mcp**

Agent index: [llms.txt](https://solana-wallet-intel-phi.vercel.app/llms.txt) · Discovery: `/.well-known/x402` · OpenAPI: `/openapi.json`

Give an agent answers about any Solana wallet: SOL balance, whether it looks like a bot, an exchange, a winner, or a dormant wallet, what it holds, who funded it, and which tokens are trending. No signup and no API key. Paid calls settle in USDC with [x402](https://x402.org) through the PayAI facilitator (Base USDC too, when `EVM_PAY_TO` is set).

## Which call to make

1. **`wallet_preview`** (free) — SOL balance, last active time, 24h transaction count. Call this before spending.
2. **`wallet_quick`** ($0.002) — copy-trade screen: realized PnL, win rate, closed trades, `copyTradeScore` / `copyTradeGrade`, bot / exchange / net-winner / dormant flags.
3. **`wallet_quick_batch`** ($0.015) — the same quick screen for up to 10 wallets, ranked by realized PnL.
4. **`wallet_profile`** ($0.009) — priced holdings, windowed PnL, evidence-backed labels, and the same copy-trade score. `txLimit` is 5–25, default 20.
5. **`wallet_funding`** ($0.009) — first SOL funder and a sybil cluster. Optional `peers` compares up to 8 wallets.
6. **`token_trending`** ($0.0018) — trending Solana tokens with liquidity, volume, and plain-English risk flags (top-10 holders, mint and freeze authority, LP lock or burn, sniper or bundle share). `limit` is 1–25, default 15.

`ping` on MCP is a free health check and does not read a wallet.

## Endpoints and prices

| Endpoint | Price | What you get |
|---|---|---|
| `GET /wallet/preview?address=` | free | SOL balance, last active time, 24h transaction count |
| `GET /wallet/quick?address=` | $0.002 | Copy-trade screen: PnL, win rate, copy-trade score, bot / exchange / dormant flags |
| `GET /wallet/quick/batch?addresses=a,b,...` | $0.015 | The same quick screen for up to 10 wallets, ranked by realized PnL |
| `GET /wallet/profile?address=&txLimit=` | $0.009 | Holdings, valuation, up to 25 recent signatures, behavior labels, copy-trade score |
| `GET /wallet/funding?address=&peers=` | $0.009 | First SOL funder, CEX deposit heuristic, cluster id |
| `GET /token/trending?limit=` | $0.0018 | Trending Solana tokens with price, volume, and risk flags |

Payment: USDC on Solana. Base USDC is accepted when `EVM_PAY_TO` is set. `accepts[].amount` is USDC base units (6 decimals): `$0.009` is `"9000"`, `$0.0018` is `"1800"`, `$0.015` is `"15000"`, `$0.002` is `"2000"`.

`copyTradeScore` is 0 to 1 and `copyTradeGrade` is A through F. The score is the cost-weighted return a copier would have after entering 3 seconds later and paying a 3.6% round trip, blended with that copy win rate (70% return scale, 30% win rate). It shrinks toward 0.5 with k=8 when few closes qualify, then subtracts 0.25 for bot-like flow and 0.20 for insider flow (a profitable round trip shorter than 3 seconds, or one fresh-wallet double). A −20% to +20% copy-return maps onto 0 to 1 before shrinkage. The score is null when no close lasted at least 3 seconds. Quote-priced swaps already in the profile are the only input, so the score adds no RPC. `copyTrade` on the profile restates the constants. Settled x402 payments are summarized at `GET /internal/revenue` with the `x-swi-internal-key` header (`SWI_INTERNAL_KEY`). The ledger stores route, amount, network, timestamp, and a sha256 of the payer address.

An unpaid call to a paid route returns **HTTP 402** even when `address`, `addresses`, `txLimit`, `limit`, or `peers` is missing or invalid. After a `PAYMENT-SIGNATURE` is attached, a bad query returns **HTTP 400** and is not charged. A paid route that then fails with a non-2xx status cancels settlement.

Successful JSON includes `cached`, `stale`, and `cacheAgeMs`. `stale: true` means a previous result was served while a refresh runs, or the upstream failed and the last good body was returned. Paid responses send `Cache-Control: private, no-store`. The free preview may be cached at the edge for a few seconds.

Errors are `{ "error", "message", "retryable" }`. `retryable: false` means fix the query. `retryable: true` means try again. Upstream messages are redacted. A 429 includes `Retry-After`.

## Use it with x402

Unpaid requests to paid routes get `402 Payment Required` with a `PAYMENT-REQUIRED` header. Any x402 v2 client handles this:

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";

const client = new x402Client();
registerExactSvmScheme(client, { signer: yourSolanaSigner }); // wallet holding a little USDC
const pay = wrapFetchWithPayment(fetch, client);

const preview = await fetch("https://solana-wallet-intel-phi.vercel.app/wallet/preview?address=<WALLET>");
console.log(await preview.json());

const res = await pay("https://solana-wallet-intel-phi.vercel.app/wallet/quick?address=<WALLET>");
console.log(await res.json());
```

Try the free teaser first:

```bash
curl "https://solana-wallet-intel-phi.vercel.app/wallet/preview?address=<WALLET>"
```

## Use it as an MCP server

Point any MCP client that supports x402 payments at `https://solana-wallet-intel-phi.vercel.app/mcp` using **streamable HTTP POST**. `GET /mcp` returns 405. Do not open a long-lived SSE stream.

| Tool | Price | When to call it |
|---|---|---|
| `ping` | free | Server is up. Does not read a wallet. |
| `wallet_preview` | free | SOL balance, last active time, 24h count. Call before paying. |
| `wallet_quick` | $0.002 | Cheap copy-trade screen, including copyTradeScore and copyTradeGrade. |
| `wallet_quick_batch` | $0.015 | Quick screen for up to 10 wallets, ranked by realized PnL. |
| `wallet_profile` | $0.009 | Priced holdings, PnL, and copy-trade score. Optional `txLimit` integer 5–25 (string or number). |
| `wallet_funding` | $0.009 | First funder and cluster. Optional `peers`. |
| `token_trending` | $0.0018 | Trending tokens and risk flags. Optional `limit` integer 1–25 (string or number). |

Every tool is read-only. Registry name: `io.github.ygfalcon/solana-wallet-intel`.

`limit` and `txLimit` on MCP accept a JSON integer or a numeric string. HTTP query parameters are strings.

## Self-host

```bash
npm install
cp .env.example .env   # SOLANA_PAY_TO, and optionally EVM_PAY_TO, HELIUS_API_KEY, JUPITER_API_KEY, BIRDEYE_API_KEY
npm run dev
npm test
npm run typecheck
```

The dev server listens on `PORT` (default 4021). `GET /health` reports the build version, p50 and p95 latency, upstream RPC rate-limit status, and cache age. The same `sla` object is on `/.well-known/x402`.

Reads use the configured Solana RPC, then free public mainnet endpoints when the cluster is mainnet. Devnet stays on the configured URL. In-memory cache entries are shared by concurrent callers, served stale for up to two minutes after TTL while one refresh runs, and capped so a warm instance does not grow without bound.

## License

ISC

---

**Built by [falcon.sol](https://x.com/ygfalcon)**: anon dev shipping pay-per-call data tools and x402 APIs for builders and agents. [X](https://x.com/ygfalcon) · [GitHub](https://github.com/ygfalcon) · [Apify](https://apify.com/falcon-sol)
