import { usdToBaseUnits, type AppEnv, type ChainAccept } from "./config.js";

export const FREE_WALLET_PREVIEW = {
  id: "wallet_preview" as const,
  mcpTool: "wallet_preview" as const,
  method: "GET" as const,
  path: "/wallet/preview" as const,
  price: "$0",
  amount: "0",
  summary: "Free wallet preview",
  description:
    "Free teaser. Call this before any paid wallet tool. Returns SOL balance, last active time, how many transactions landed in the last 24 hours, and a dormant or recently-active label. Does not spend USDC. Pass one base58 Solana address. Invalid addresses return an error and do not ask for payment. Upgrade to wallet_quick for a copy-trade screen, wallet_profile for priced holdings, or wallet_funding for the first SOL funder and cluster.",
  inputSchema: {
    type: "object" as const,
    properties: {
      address: {
        type: "string",
        description: "Solana wallet address in base58 (32 to 44 characters). Invalid addresses return HTTP 400. This route is free.",
      },
    },
    required: ["address"],
  },
};

export type PaidOperation = {
  id: "wallet_profile" | "token_trending" | "wallet_funding" | "wallet_quick" | "wallet_quick_batch";
  mcpTool: "wallet_profile" | "token_trending" | "wallet_funding" | "wallet_quick" | "wallet_quick_batch";
  method: "GET";
  path: "/wallet/profile" | "/token/trending" | "/wallet/funding" | "/wallet/quick" | "/wallet/quick/batch";
  price: string;
  amount: string;
  summary: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string; minimum?: number; maximum?: number }>;
    required: string[];
  };
  example: Record<string, string>;
  outputExample: Record<string, unknown>;
};

export function paidOperations(env: AppEnv): PaidOperation[] {
  return [
    {
      id: "wallet_profile",
      mcpTool: "wallet_profile",
      method: "GET",
      path: "/wallet/profile",
      price: env.priceWalletProfile,
      amount: usdToBaseUnits(env.priceWalletProfile),
      summary: "Solana wallet profile",
      description:
        "Use this when you need priced holdings and windowed PnL for one Solana wallet. Holdings valued in USD, a short plain-language summary, windowed realized and unrealized PnL, win rate, and evidence-backed labels such as active memecoin trader. txLimit is an integer from 5 to 25 and defaults to 20. Call free wallet_preview first if you only need SOL balance and last-active time, or wallet_quick for a cheaper copy-trade screen.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Solana wallet address in base58 (32 to 44 characters). Unpaid requests return HTTP 402. A signed request with an invalid address returns HTTP 400 and is not charged.",
          },
          txLimit: {
            type: "string",
            description: "Recent signatures to inspect, integer from 5 to 25. Defaults to 20. Unpaid requests return HTTP 402. A signed request with an out-of-range value returns HTTP 400 and is not charged.",
          },
        },
        required: ["address"],
      },
      example: {
        address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
        txLimit: "20",
      },
      outputExample: {
        address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
        summary:
          "Holds $1,280.40 across 4 priced tokens. Largest position is SOL at 61%. Estimated realized PnL is +$42.10 and unrealized PnL is -$8.40 (win rate 60% on 5 closes). Labels: active memecoin trader, net winner.",
        portfolioUsd: 1280.4,
        labels: ["active memecoin trader", "net winner"],
        labelDetails: [
          {
            id: "active_memecoin_trader",
            title: "active memecoin trader",
            category: "activity",
            confidence: "medium",
            evidence: "5 swaps traded a token outside the blue-chip and stablecoin set.",
          },
        ],
        pnl: { realizedUsd: 42.1, unrealizedUsd: -8.4, winRate: 0.6, partialCostBasis: false, priceBasis: "execution" },
      },
    },
    {
      id: "token_trending",
      mcpTool: "token_trending",
      method: "GET",
      path: "/token/trending",
      price: env.priceTokenTrending,
      amount: usdToBaseUnits(env.priceTokenTrending),
      summary: "Trending Solana tokens",
      description:
        "Use this when you need the Solana tokens traders are watching right now. Trending Solana tokens with liquidity, 24h volume, pair age, and a short summary. Each token includes holder concentration (top-10 share), mint and freeze authority, LP lock or burn status, and sniper or bundle share of early supply. Risky results are plain-English risk flags. Thin, new, and wash-like books are ranked down. limit is an integer from 1 to 25 and defaults to 15.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "string",
            description: "How many tokens to return, integer from 1 to 25. Defaults to 15. Unpaid requests return HTTP 402. A signed request with an out-of-range value returns HTTP 400 and is not charged. MCP also accepts a JSON integer.",
          },
        },
        required: [],
      },
      example: { limit: "15" },
      outputExample: {
        summary:
          "1 Solana token, ranked by 24h volume after down-ranking thin, new, and wash-like books. Top is BONK with $18,000,000 24h volume and $4,200,000 liquidity. 0 of 1 have risk flags.",
        tokens: [
          {
            rank: 1,
            symbol: "BONK",
            liquidityUsd: 4200000,
            volume24hUsd: 18000000,
            ageHours: 8000,
            riskFlags: [],
            checks: {
              holders: { top10Share: 0.18, note: "Top 10 holders control 18% of supply." },
              authorities: {
                mintAuthority: null,
                freezeAuthority: null,
                note: "Mint authority is revoked. Freeze authority is revoked.",
              },
              lp: { status: "burned", note: "LP is burned. Burn addresses hold 100% of the LP supply." },
              snipers: { share: 0.04, note: "Snipers and bundled wallets took 4% of supply in the earliest slots." },
            },
          },
        ],
      },
    },
    {
      id: "wallet_funding",
      mcpTool: "wallet_funding",
      method: "GET",
      path: "/wallet/funding",
      price: env.priceWalletFunding,
      amount: usdToBaseUnits(env.priceWalletFunding),
      summary: "Wallet funding source and cluster",
      description:
        "Use this when you need a wallet's first SOL funder and whether other wallets look like the same operator. Find a wallet's first SOL funder, flag wallets that share that funder or a CEX deposit address, and return a cluster id with plain-language sybil risk reasons. Labeled exchange hot wallets are not used as a cluster. Optional peers compares up to 8 other wallets.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Solana wallet address in base58 (32 to 44 characters). Unpaid requests return HTTP 402. A signed request with an invalid address returns HTTP 400 and is not charged.",
          },
          peers: {
            type: "string",
            description:
              "Comma-separated peer wallets to compare, up to 8. Each must be base58. The primary address is rejected. Unpaid requests return HTTP 402. A signed request with invalid peers returns HTTP 400 and is not charged. Wallets that share a personal first funder or a CEX deposit address join one cluster.",
          },
        },
        required: ["address"],
      },
      example: {
        address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
        peers: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      },
      outputExample: {
        address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
        summary:
          "First SOL came from a personal funder. Peer wallets that share that funder are one cluster. Cluster id is funder:So11111111111111111111111111111111111111112.",
        funder: {
          address: "So11111111111111111111111111111111111111112",
          exchange: null,
          amountSol: 1.5,
        },
        cexDeposit: null,
        cluster: {
          id: "funder:So11111111111111111111111111111111111111112",
          key: "funder",
          members: ["HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM"],
        },
        risk: {
          level: "high",
          reasons: [
            "Peer wallets share that first SOL funder. Wallets opened by the same funder are often one operator or a sybil set.",
          ],
        },
      },
    },
    {
      id: "wallet_quick",
      mcpTool: "wallet_quick",
      method: "GET",
      path: "/wallet/quick",
      price: env.priceWalletQuick,
      amount: usdToBaseUnits(env.priceWalletQuick),
      summary: "Solana wallet quick screen",
      description:
        "Use this for a cheap copy-trade screen before paying for a full profile. Cheap copy-trade screen for one wallet: windowed realized PnL, win rate, closed trades, last active time, and bot, exchange, net-winner and dormant flags. Free teaser at /wallet/preview; full report at /wallet/profile.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Solana wallet address in base58 (32 to 44 characters). Unpaid requests return HTTP 402. A signed request with an invalid address returns HTTP 400 and is not charged.",
          },
        },
        required: ["address"],
      },
      example: { address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM" },
      outputExample: {
        address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
        realizedUsd: 42.1,
        winRate: 0.6,
        closedTrades: 5,
        bot: false,
        exchangeLike: false,
        netWinner: true,
        dormant: false,
        portfolioUsd: 1280.4,
        lastActiveAt: "2026-10-23T18:00:00.000Z",
        windowTransactions: 25,
      },
    },
    {
      id: "wallet_quick_batch",
      mcpTool: "wallet_quick_batch",
      method: "GET",
      path: "/wallet/quick/batch",
      price: env.priceWalletQuickBatch,
      amount: usdToBaseUnits(env.priceWalletQuickBatch),
      summary: "Batch quick screen, up to 10 wallets",
      description:
        "Quick screen (windowed realized PnL, win rate, bot, exchange, net-winner and dormant flags) for up to 10 Solana wallets in one paid call, ranked by realized PnL. Pass addresses comma-separated.",
      inputSchema: {
        type: "object",
        properties: {
          addresses: {
            type: "string",
            description:
              "1 to 10 comma-separated base58 Solana wallet addresses. Unpaid requests return HTTP 402. A signed request with a bad list returns HTTP 400 and is not charged.",
          },
        },
        required: ["addresses"],
      },
      example: { addresses: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM,suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK" },
      outputExample: {
        asOf: "2026-10-24T12:00:00.000Z",
        wallets: [{ address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM", realizedUsd: 42.1, winRate: 0.6, bot: false, smartMoney: false }],
        errors: [],
      },
    },
  ];
}

export function mcpToolDescription(operation: PaidOperation): string {
  return `${operation.description} Costs ${operation.price} USDC (${operation.amount} base units) via x402. The same price is charged for HTTP ${operation.method} ${operation.path}. An unpaid HTTP call returns 402 even when the query is missing or invalid. A signed call with invalid arguments is rejected before settlement and is not charged. A successful result can set cached, stale, and cacheAgeMs. stale true means a previous result was served while a refresh runs or the upstream failed. You are charged only when the tool result is not an error.`;
}

export function operationForPath(path: string, env: AppEnv): PaidOperation | undefined {
  return paidOperations(env).find((operation) => operation.path === path);
}

export function enabledAccepts(env: AppEnv, supported: Set<string>): ChainAccept[] {
  return [env.solana, env.base].filter((accept): accept is ChainAccept => {
    return Boolean(accept && supported.has(accept.network));
  });
}
