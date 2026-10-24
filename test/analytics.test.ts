import { describe, expect, it } from "vitest";
import { describeWallet, estimatePnl, labelWallet, medianGapSeconds, riskFlags, summarizeWallet } from "../src/analytics.js";
import { assembleTrending } from "../src/services/trending.js";
import { legsFromParsedTransaction } from "../src/services/wallet.js";
import { SOL_MINT } from "../src/solana.js";
import { USDC_SOLANA_MAINNET } from "../src/config.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

describe("wallet analytics", () => {
  it("estimates realized and unrealized PnL inside the fetched window", () => {
    const prices = new Map<string, number>([
      [USDC_SOLANA_MAINNET, 1],
      [BONK, 0.02],
    ]);
    const pnl = estimatePnl(
      [
        [
          { mint: USDC_SOLANA_MAINNET, delta: -10 },
          { mint: BONK, delta: 1000 },
        ],
        [
          { mint: BONK, delta: -400 },
          { mint: USDC_SOLANA_MAINNET, delta: 8 },
        ],
      ],
      prices,
    );
    expect(pnl.realizedUsd).toBe(4);
    expect(pnl.unrealizedUsd).toBe(6);
    expect(pnl.winRate).toBe(1);
    expect(pnl.partialCostBasis).toBe(false);
  });

  it("reorders newest-first fills before applying average cost", () => {
    const prices = new Map<string, number>([
      [USDC_SOLANA_MAINNET, 1],
      [BONK, 0.02],
    ]);
    const pnl = estimatePnl(
      [
        {
          at: 2_000,
          legs: [
            { mint: BONK, delta: -400 },
            { mint: USDC_SOLANA_MAINNET, delta: 8 },
          ],
        },
        {
          at: 1_000,
          legs: [
            { mint: USDC_SOLANA_MAINNET, delta: -10 },
            { mint: BONK, delta: 1_000 },
          ],
        },
      ],
      prices,
    );
    expect(pnl.realizedUsd).toBe(4);
    expect(pnl.unrealizedUsd).toBe(6);
    expect(pnl.partialCostBasis).toBe(false);
    expect(pnl.unpricedSells).toBe(0);
  });

  it("nets quote change inside one swap instead of booking the gross spend", () => {
    const prices = new Map<string, number>([
      [USDC_SOLANA_MAINNET, 1],
      [BONK, 0.1],
    ]);
    const pnl = estimatePnl(
      [
        [
          { mint: USDC_SOLANA_MAINNET, delta: -100 },
          { mint: USDC_SOLANA_MAINNET, delta: 5 },
          { mint: BONK, delta: 1_000 },
        ],
      ],
      prices,
    );
    expect(pnl.unrealizedUsd).toBe(5);
    expect(pnl.realizedUsd).toBe(0);
  });

  it("does not invent profit when a sell has no in-window cost basis", () => {
    const prices = new Map<string, number>([
      [USDC_SOLANA_MAINNET, 1],
      [BONK, 0.01],
    ]);
    const pnl = estimatePnl(
      [
        [
          { mint: BONK, delta: -400 },
          { mint: USDC_SOLANA_MAINNET, delta: 8 },
        ],
      ],
      prices,
    );
    expect(pnl.realizedUsd).toBeNull();
    expect(pnl.closedTrades).toBe(0);
    expect(pnl.partialCostBasis).toBe(true);
    expect(pnl.unpricedSells).toBe(1);
  });

  it("removes transferred tokens at cost instead of marking them sold", () => {
    const prices = new Map<string, number>([
      [USDC_SOLANA_MAINNET, 1],
      [BONK, 0.02],
    ]);
    const pnl = estimatePnl(
      [
        [
          { mint: USDC_SOLANA_MAINNET, delta: -10 },
          { mint: BONK, delta: 1_000 },
        ],
        [{ mint: BONK, delta: -400 }],
      ],
      prices,
    );
    expect(pnl.realizedUsd).toBe(0);
    expect(pnl.unrealizedUsd).toBe(6);
    expect(pnl.closedTrades).toBe(0);
  });

  it("values SOL paid in a swap at the execution price, not the spot price", () => {
    const prices = new Map<string, number>([
      [SOL_MINT, 200],
      [BONK, 0.15],
    ]);
    const pnl = estimatePnl(
      [
        [
          { mint: SOL_MINT, delta: -1, usdPrice: 100 },
          { mint: BONK, delta: 1_000 },
        ],
      ],
      prices,
    );
    expect(pnl.realizedUsd).toBe(0);
    expect(pnl.unrealizedUsd).toBe(50);
    expect(pnl.priceBasis).toBe("execution");
    expect(pnl.partialCostBasis).toBe(false);
  });

  it("realizes a SOL to USDC round trip at execution prices", () => {
    const prices = new Map<string, number>([
      [SOL_MINT, 180],
      [USDC_SOLANA_MAINNET, 1],
    ]);
    const pnl = estimatePnl(
      [
        {
          at: 2_000,
          legs: [
            { mint: SOL_MINT, delta: -1, usdPrice: 150 },
            { mint: USDC_SOLANA_MAINNET, delta: 150 },
          ],
        },
        {
          at: 1_000,
          legs: [
            { mint: USDC_SOLANA_MAINNET, delta: -100 },
            { mint: SOL_MINT, delta: 1, usdPrice: 100 },
          ],
        },
      ],
      prices,
    );
    expect(pnl.realizedUsd).toBe(50);
    expect(pnl.unrealizedUsd).toBeNull();
    expect(pnl.closedTrades).toBe(1);
    expect(pnl.winRate).toBe(1);
  });

  it("averages two buys and splits a multi-token sale by USD value", () => {
    const tokenA = "TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const tokenB = "TokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const prices = new Map<string, number>([
      [USDC_SOLANA_MAINNET, 1],
      [tokenA, 10],
      [tokenB, 0.1],
    ]);
    const averaged = estimatePnl(
      [
        [
          { mint: USDC_SOLANA_MAINNET, delta: -10 },
          { mint: BONK, delta: 100 },
        ],
        [
          { mint: USDC_SOLANA_MAINNET, delta: -30 },
          { mint: BONK, delta: 100 },
        ],
        [
          { mint: BONK, delta: -100 },
          { mint: USDC_SOLANA_MAINNET, delta: 30 },
        ],
      ],
      new Map<string, number>([
        [USDC_SOLANA_MAINNET, 1],
        [BONK, 0.25],
      ]),
    );
    expect(averaged.realizedUsd).toBe(10);
    expect(averaged.unrealizedUsd).toBe(5);

    const split = estimatePnl(
      [
        [
          { mint: USDC_SOLANA_MAINNET, delta: -5 },
          { mint: tokenA, delta: 1 },
        ],
        [
          { mint: USDC_SOLANA_MAINNET, delta: -50 },
          { mint: tokenB, delta: 1_000 },
        ],
        [
          { mint: tokenA, delta: -1 },
          { mint: tokenB, delta: -1_000 },
          { mint: USDC_SOLANA_MAINNET, delta: 110 },
        ],
      ],
      prices,
    );
    expect(split.realizedUsd).toBe(55);
    expect(split.closedTrades).toBe(2);
  });

  it("labels a wallet that keeps swapping non-blue-chip tokens", () => {
    const labels = labelWallet({
      swapCount: 6,
      lastActiveAt: new Date().toISOString(),
      holdings: [{ mint: BONK, symbol: "BONK", amount: 10, usdValue: 20 }],
      memecoinSwaps: 5,
      pnl: {
        method: "window_average_cost_current_prices",
        priceBasis: "execution",
        disclaimer: "",
        realizedUsd: 3,
        unrealizedUsd: 0,
        closedTrades: 2,
        winningTrades: 2,
        winRate: 1,
        partialCostBasis: false,
        unpricedSells: 0,
      },
    });
    expect(labels).toContain("active memecoin trader");
    expect(labels).toContain("net winner");
  });

  it("does not call an empty wallet dormant or a stablecoin wallet a blue-chip book", () => {
    const empty = labelWallet({
      swapCount: 0,
      lastActiveAt: null,
      holdings: [],
      memecoinSwaps: 0,
      pnl: {
        method: "window_average_cost_current_prices",
        priceBasis: "unavailable",
        disclaimer: "",
        realizedUsd: null,
        unrealizedUsd: null,
        closedTrades: 0,
        winningTrades: 0,
        winRate: null,
        partialCostBasis: false,
        unpricedSells: 0,
      },
    });
    expect(empty).toEqual(["no on-chain activity"]);

    const stables = labelWallet({
      swapCount: 0,
      lastActiveAt: new Date().toISOString(),
      holdings: [{ mint: USDC_SOLANA_MAINNET, symbol: "USDC", amount: 10_000, usdValue: 10_000 }],
      memecoinSwaps: 0,
      pnl: {
        method: "window_average_cost_current_prices",
        priceBasis: "unavailable",
        disclaimer: "",
        realizedUsd: null,
        unrealizedUsd: null,
        closedTrades: 0,
        winningTrades: 0,
        winRate: null,
        partialCostBasis: false,
        unpricedSells: 0,
      },
    });
    expect(stables).toContain("stablecoin heavy");
    expect(stables).not.toContain("blue-chip holder");
  });

  it("keeps a quiet wallet from being labeled an active memecoin trader", () => {
    const labels = labelWallet({
      swapCount: 6,
      lastActiveAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      holdings: [{ mint: BONK, symbol: "BONK", amount: 10, usdValue: 20 }],
      memecoinSwaps: 5,
      pnl: {
        method: "window_average_cost_current_prices",
        priceBasis: "execution",
        disclaimer: "",
        realizedUsd: 3,
        unrealizedUsd: 0,
        closedTrades: 2,
        winningTrades: 2,
        winRate: 1,
        partialCostBasis: false,
        unpricedSells: 0,
      },
    });
    expect(labels).toContain("dormant");
    expect(labels).not.toContain("active memecoin trader");
  });

  it("explains whale, bot-like, and fresh-wallet labels with evidence", () => {
    const basePnl = {
      method: "window_average_cost_execution_prices" as const,
      priceBasis: "execution" as const,
      disclaimer: "",
      realizedUsd: 0,
      unrealizedUsd: 0,
      closedTrades: 0,
      winningTrades: 0,
      winRate: null,
      partialCostBasis: false,
      unpricedSells: 0,
    };
    const whale = describeWallet({
      swapCount: 0,
      lastActiveAt: new Date().toISOString(),
      holdings: [{ mint: SOL_MINT, symbol: "SOL", amount: 1000, usdValue: 150_000 }],
      memecoinSwaps: 0,
      pnl: basePnl,
    });
    expect(whale.labels).toContain("whale");
    expect(whale.details.find((detail) => detail.id === "whale")?.evidence).toContain("$150,000.00");
    expect(whale.labels).not.toContain("large holder");

    const bot = labelWallet({
      swapCount: 8,
      lastActiveAt: new Date().toISOString(),
      holdings: [],
      memecoinSwaps: 0,
      medianSwapGapSeconds: 30,
      pnl: basePnl,
    });
    expect(bot).toContain("bot-like");

    const fresh = labelWallet({
      swapCount: 1,
      signatureCount: 2,
      historyTruncated: false,
      firstActiveAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      lastActiveAt: new Date().toISOString(),
      holdings: [],
      memecoinSwaps: 0,
      pnl: basePnl,
    });
    expect(fresh).toContain("fresh wallet");
    expect(medianGapSeconds([0, 30, 90])).toBe(45);
  });

  it("writes a stable plain-language wallet summary", () => {
    const summary = summarizeWallet({
      portfolioUsd: 100,
      pricedHoldings: 2,
      holdings: [
        { mint: SOL_MINT, symbol: "SOL", amount: 0.6, usdValue: 60, sharePct: 60 },
        { mint: BONK, symbol: "BONK", amount: 2000, usdValue: 40, sharePct: 40 },
      ],
      omittedHoldings: 0,
      unpricedHoldings: 1,
      window: {
        transactions: 20,
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-20T00:00:00.000Z",
      },
      activity: { signatureCount: 20, swapCount: 8, uniqueTokensTraded: 3 },
      pnl: {
        method: "window_average_cost_execution_prices",
        priceBasis: "execution",
        disclaimer: "",
        realizedUsd: 42.1,
        unrealizedUsd: -8.4,
        closedTrades: 5,
        winningTrades: 3,
        winRate: 0.6,
        partialCostBasis: true,
        unpricedSells: 1,
      },
      labels: ["active memecoin trader", "net winner"],
    });
    expect(summary).toBe(
      "Holds $100.00 across 2 priced tokens, with 1 unpriced holding excluded from that total. Largest position is SOL at 60%. In a 20-transaction window from 2026-10-01 to 2026-10-20, the wallet made 8 swaps across 3 tokens. Estimated realized PnL is +$42.10 and unrealized PnL is -$8.40 (win rate 60% on 5 closes); cost basis is partial. Labels: active memecoin trader, net winner.",
    );
  });

  it("reads token deltas from a parsed transaction", () => {
    const legs = legsFromParsedTransaction(
      {
        meta: {
          fee: 5000,
          preBalances: [2_000_000_000, 0],
          postBalances: [1_000_000_000, 0],
          preTokenBalances: [{ owner: "owner", mint: BONK, uiTokenAmount: { uiAmountString: "10" } }],
          postTokenBalances: [{ owner: "owner", mint: BONK, uiTokenAmount: { uiAmountString: "15" } }],
        },
        transaction: { message: { accountKeys: ["owner"] } },
      },
      "owner",
    );
    expect(legs).toContainEqual({ mint: BONK, delta: 5 });
    expect(legs).toContainEqual({ mint: SOL_MINT, delta: -0.999995 });
  });

  it("attributes SOL when the owner is only in loaded addresses", () => {
    const legs = legsFromParsedTransaction(
      {
        meta: {
          fee: 5000,
          preBalances: [5_000_000_000, 2_000_000_000],
          postBalances: [4_999_995_000, 1_000_000_000],
          loadedAddresses: { writable: ["owner"], readonly: [] },
        },
        transaction: { message: { accountKeys: ["fee-payer"] } },
      },
      "owner",
    );
    expect(legs).toContainEqual({ mint: SOL_MINT, delta: -1 });
  });
});

describe("trending risk flags", () => {
  it("flags thin new pairs and paid boosts", () => {
    const flags = riskFlags({
      liquidityUsd: 1000,
      volume24hUsd: 20_000,
      ageHours: 3,
      priceChange24hPct: 140,
      boosted: true,
    });
    expect(flags).toEqual(
      expect.arrayContaining(["low_liquidity", "newly_launched", "extreme_move", "wash_suspect", "paid_boost"]),
    );
  });

  it("keeps the deepest pair for a boosted mint", () => {
    const report = assembleTrending({
      boosted: new Set(["mint-a"]),
      birdeye: [],
      sources: ["dexscreener"],
      warnings: [],
      limit: 5,
      pairs: [
        {
          chainId: "solana",
          baseToken: { address: "mint-a", symbol: "AAA", name: "A" },
          liquidity: { usd: 100 },
          volume: { h24: 50 },
          priceUsd: "0.1",
          pairCreatedAt: Date.now() - 3_600_000,
        },
        {
          chainId: "solana",
          baseToken: { address: "mint-a", symbol: "AAA", name: "A" },
          liquidity: { usd: 50_000 },
          volume: { h24: 80_000 },
          priceUsd: "0.2",
          pairCreatedAt: Date.now() - 48 * 3_600_000,
          dexId: "raydium",
        },
      ],
    });
    expect(report.tokens).toHaveLength(1);
    expect(report.tokens[0].liquidityUsd).toBe(50_000);
    expect(report.tokens[0].priceUsd).toBe(0.2);
    expect(report.tokens[0].rank).toBe(1);
    expect(report.tokens[0].riskFlags).toContain("paid_boost");
    expect(report.tokens[0].riskFlags).not.toContain("low_liquidity");
    expect(report.summary).toContain("Top is AAA");
  });

  it("prefers a SOL or stablecoin pair, drops quote assets, and ranks wash books down", () => {
    const hourAgoSeconds = Math.floor(Date.now() / 1000) - 3600;
    const report = assembleTrending({
      boosted: new Set(["wash", "clean", USDC_SOLANA_MAINNET]),
      birdeye: [{ address: USDC_SOLANA_MAINNET, symbol: "USDC", liquidity: 9_000_000, volume24hUSD: 9_000_000, price: 1 }],
      sources: ["dexscreener"],
      warnings: [],
      limit: 5,
      pairs: [
        {
          chainId: "solana",
          baseToken: { address: "mint-a", symbol: "AAA" },
          quoteToken: { address: "fake-quote", symbol: "FAKE" },
          liquidity: { usd: 1_000_000 },
          volume: { h24: 10 },
          priceUsd: "0.01",
        },
        {
          chainId: "solana",
          baseToken: { address: "mint-a", symbol: "AAA" },
          quoteToken: { address: USDC_SOLANA_MAINNET, symbol: "USDC" },
          liquidity: { usd: 40_000 },
          volume: { h24: 80_000 },
          priceUsd: "0.2",
          dexId: "raydium",
        },
        {
          chainId: "solana",
          baseToken: { address: "wash", symbol: "WASH" },
          quoteToken: { address: USDC_SOLANA_MAINNET, symbol: "USDC" },
          liquidity: { usd: 10_000 },
          volume: { h24: 1_000_000 },
          priceUsd: "1",
          pairCreatedAt: hourAgoSeconds,
        },
        {
          chainId: "solana",
          baseToken: { address: "clean", symbol: "CLEAN" },
          quoteToken: { address: USDC_SOLANA_MAINNET, symbol: "USDC" },
          liquidity: { usd: 100_000 },
          volume: { h24: 200_000 },
          priceUsd: "2",
          pairCreatedAt: Date.now() - 100 * 3_600_000,
        },
        {
          chainId: "solana",
          baseToken: { address: USDC_SOLANA_MAINNET, symbol: "USDC" },
          liquidity: { usd: 9_000_000 },
          volume: { h24: 9_000_000 },
          priceUsd: "1",
        },
      ],
    });
    const aaa = report.tokens.find((token) => token.symbol === "AAA");
    expect(aaa?.liquidityUsd).toBe(40_000);
    expect(aaa?.priceUsd).toBe(0.2);
    expect(report.tokens.map((token) => token.symbol)).toEqual(["CLEAN", "AAA", "WASH"]);
    expect(report.tokens.map((token) => token.rank)).toEqual([1, 2, 3]);
    const wash = report.tokens.find((token) => token.symbol === "WASH");
    expect(wash?.ageHours).toBeGreaterThan(0.5);
    expect(wash?.ageHours).toBeLessThan(2);
    expect(report.summary).toContain("Top is CLEAN");
    expect(report.summary).toContain("2 of 3 have risk flags");
  });
});
