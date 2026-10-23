# Solana Wallet Intel — pay-per-call wallet intelligence for AI agents

Live API: **https://solana-wallet-intel-phi.vercel.app**
MCP server (streamable HTTP): **https://solana-wallet-intel-phi.vercel.app/mcp**

Give your agent instant answers about any Solana wallet: is it a bot, an exchange, a whale or a fresh wallet; what it holds and what it's worth; how it trades. No signup, no API key. Agents pay per call in USDC using [x402](https://x402.org), settled by the PayAI facilitator.

## Endpoints and prices

| Endpoint | Price | What you get |
|---|---|---|
| `GET /wallet/preview?address=` | free | Teaser: wallet type and a few headline facts |
| `GET /wallet/quick?address=` | $0.002 | Fast check: label (bot / exchange / whale / fresh / normal), SOL + portfolio USD value, activity |
| `GET /wallet/quick/batch?addresses=a,b,...` | $0.015 | Quick check for up to 10 wallets |
| `GET /wallet/profile?address=&txLimit=` | $0.01 | Full profile: holdings, valuation, swap history (up to 300 txs), behavior signals |
| `GET /token/trending?limit=` | $0.005 | Trending Solana tokens with price and volume |

Payment: USDC on Solana mainnet (Base mainnet USDC also accepted when enabled). Discovery: `/.well-known/x402`, OpenAPI: `/openapi.json`.

## Use it with x402

Unpaid requests get `402 Payment Required` with a `PAYMENT-REQUIRED` header describing what to pay. Any x402 v2 client handles this automatically:

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";

const client = new x402Client();
registerExactSvmScheme(client, { signer: yourSolanaSigner }); // wallet holding a little USDC
const pay = wrapFetchWithPayment(fetch, client);

const res = await pay("https://solana-wallet-intel-phi.vercel.app/wallet/quick?address=<WALLET>");
console.log(await res.json());
```

Try it free first:

```bash
curl "https://solana-wallet-intel-phi.vercel.app/wallet/preview?address=<WALLET>"
```

## Use it as an MCP server

Point any MCP client that supports x402 payments at `https://solana-wallet-intel-phi.vercel.app/mcp`. Tools mirror the endpoints above, each priced the same.

Registry name: `io.github.ygfalcon/solana-wallet-intel`.

## Self-host

```bash
npm install
cp .env.example .env   # set SOLANA_PAY_TO (and optionally EVM_PAY_TO, HELIUS_API_KEY)
npm run dev
npm test
```

## License

MIT
