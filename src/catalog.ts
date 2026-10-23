import { usdToBaseUnits, type AppEnv, type ChainAccept } from "./config.js";

export type PaidOperation = {
  id: "wallet_profile" | "token_trending" | "wallet_quick" | "wallet_quick_batch";
  mcpTool: "wallet_profile" | "token_trending" | "wallet_quick" | "wallet_quick_batch";
  method: "GET";
  path: "/wallet/profile" | "/token/trending" | "/wallet/quick" | "/wallet/quick/batch";
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
        "Solana wallet intel in one call: top 15 holdings priced in USD (spam/NFT airdrops filtered), total portfolio value, realized + unrealized PnL and win rate replayed chronologically over the last 50-100 transactions, trading cadence (swaps/day, median seconds between txs) and labels such as smart-money candidate, bot-like cadence, active memecoin trader, net winner/loser, dormant. Use it to vet a wallet before copy-trading it. Free teaser at /wallet/preview.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Solana wallet address in base58.",
          },
          txLimit: {
            type: "string",
            description: "Recent transactions to inspect for PnL and cadence, from 5 to 300 (paginated). Defaults to 100. /wallet/quick uses the latest 50.",
          },
        },
        required: ["address"],
      },
      example: {
        address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
        txLimit: "50",
      },
      outputExample: {
        address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
        portfolioUsd: 1365.89,
        tokenCount: 41,
        unpricedTokenCount: 12,
        holdings: [{ mint: "So11111111111111111111111111111111111111112", symbol: "SOL", amount: 12.9, usdValue: 1349.3, sharePct: 98.8 }],
        trading: { windowHours: 68.6, swapsPerDay: 4.5, txsPerDay: 17.5, medianSecondsBetweenTxs: 360 },
        pnl: { realizedUsd: -2772.99, unrealizedUsd: -1935.21, closedTrades: 14, winningTrades: 3, winRate: 0.214, partialCostBasis: true },
        labels: ["active memecoin trader", "high turnover", "net loser"],
        activity: { signatureCount: 50, swapCount: 31, uniqueTokensTraded: 22, lastActiveAt: "2026-10-23T15:17:09.000Z" },
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
        "Currently trending Solana tokens with liquidity, 24h volume, pair age, and basic risk flags.",
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
        tokens: [
          {
            symbol: "BONK",
            liquidityUsd: 4200000,
            volume24hUsd: 18000000,
            ageHours: 8000,
            riskFlags: [],
          },
        ],
      },
    },
    {
      id: "wallet_quick",
      mcpTool: "wallet_quick",
      method: "GET",
      path: "/wallet/quick",
      price: env.priceWalletQuick,
      amount: usdToBaseUnits(env.priceWalletQuick),
      summary: "Quick Solana wallet screen",
      description:
        "Cheapest Solana wallet screen on x402: realized PnL, win rate, closed trades, swaps/day, bot flag and smart-money flag over the last 50 transactions. Use it to filter copy-trade candidates before buying a full /wallet/profile.",
      inputSchema: { type: "object", properties: { address: { type: "string", description: "Solana wallet address in base58." } }, required: ["address"] },
      example: { address: "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm" },
      outputExample: {
        address: "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm",
        realizedUsd: -2776.7, winRate: 0.214, closedTrades: 14, swapsPerDay: 4.5, txsPerDay: 17.5, exchangeLike: false,
        bot: false, smartMoney: false, netWinner: false, portfolioUsd: 23.74, lastActiveAt: "2026-10-23T15:17:09.000Z",
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
        "Quick screen (realized PnL, win rate, bot flag, smart-money flag) for up to 10 Solana wallets in one paid call, ranked by realized PnL. Pass addresses comma-separated.",
      inputSchema: { type: "object", properties: { addresses: { type: "string", description: "Up to 10 comma-separated base58 Solana wallet addresses." } }, required: ["addresses"] },
      example: { addresses: "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm,suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK" },
      outputExample: { wallets: [{ address: "suqh5s…", realizedUsd: -104.98, winRate: 0, bot: true, smartMoney: false }], errors: [] },
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
