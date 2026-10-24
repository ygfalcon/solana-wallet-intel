import { usdToBaseUnits, type AppEnv, type ChainAccept } from "./config.js";

export type PaidOperation = {
  id: "wallet_profile" | "token_trending" | "wallet_funding" | "wallet_quick";
  mcpTool: "wallet_profile" | "token_trending" | "wallet_funding" | "wallet_quick";
  method: "GET";
  path: "/wallet/profile" | "/token/trending" | "/wallet/funding" | "/wallet/quick";
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
        "Holdings valued in USD, a short plain-language summary, windowed realized and unrealized PnL, win rate, and evidence-backed labels such as active memecoin trader.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Solana wallet address in base58.",
          },
          txLimit: {
            type: "string",
            description: "Recent transactions to inspect, from 5 to 25. Defaults to 20.",
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
        "Trending Solana tokens with liquidity, 24h volume, pair age, and a short summary. Each token includes holder concentration (top-10 share), mint and freeze authority, LP lock or burn status, and sniper or bundle share of early supply. Risky results are plain-English risk flags. Thin, new, and wash-like books are ranked down.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "string",
            description: "How many tokens to return, from 1 to 25. Defaults to 15.",
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
        "Find a wallet's first SOL funder, flag wallets that share that funder or a CEX deposit address, and return a cluster id with plain-language sybil risk reasons. Labeled exchange hot wallets are not used as a cluster. Optional peers compares up to 8 other wallets.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Solana wallet address in base58.",
          },
          peers: {
            type: "string",
            description:
              "Comma-separated peer wallets to compare, up to 8. Wallets that share a personal first funder or a CEX deposit address join one cluster.",
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
        "Cheap copy-trade screen for one wallet: windowed realized PnL, win rate, closed trades, last active time, and bot, exchange, net-winner and dormant flags. Free teaser at /wallet/preview; full report at /wallet/profile.",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "Solana wallet address in base58." },
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
  ];
}

export function operationForPath(path: string, env: AppEnv): PaidOperation | undefined {
  return paidOperations(env).find((operation) => operation.path === path);
}

export function enabledAccepts(env: AppEnv, supported: Set<string>): ChainAccept[] {
  return [env.solana, env.base].filter((accept): accept is ChainAccept => {
    return Boolean(accept && supported.has(accept.network));
  });
}
