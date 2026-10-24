import { encodePaymentSignatureHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { USDC_SOLANA_MAINNET } from "../src/config.js";
import {
  COPY_TRADE_METHOD,
  emptyCopyTrade,
  gradeCopyTrade,
  scoreCopyTrade,
  type CopyTradeInput,
} from "../src/copy-trade.js";
import { createApp } from "../src/app.js";
import { SOLANA_DEVNET, mockFacilitator, testEnv } from "./helpers.js";

const MEME = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const prices = new Map<string, number>();

function swap(at: number, memeDelta: number, usdcDelta: number) {
  return {
    at,
    legs: [
      { mint: MEME, delta: memeDelta },
      { mint: USDC_SOLANA_MAINNET, delta: usdcDelta, usdPrice: 1 },
    ],
  };
}

function score(trades: CopyTradeInput["trades"], extra: Omit<CopyTradeInput, "trades" | "prices"> = {}) {
  return scoreCopyTrade({ trades, prices, ...extra });
}

describe("copy-trade score", () => {
  it("is null until a close lasts at least 3 seconds", () => {
    expect(score([]).score).toBeNull();
    expect(score([]).grade).toBeNull();
    expect(score([]).method).toBe(COPY_TRADE_METHOD);
    const sniper = score([swap(1_000, 10, -10), swap(1_002, -10, 20)]);
    expect(sniper.sampleSize).toBe(0);
    expect(sniper.score).toBeNull();
    expect(sniper.penalties).toEqual(["insider"]);
  });

  it("charges a 3.6% round trip and shrinks a single close toward 0.5", () => {
    const result = score([swap(0, 10, -10), swap(1_000, -10, 20)]);
    expect(result.copyReturn).toBe(0.964);
    expect(result.winRate).toBe(1);
    expect(result.sampleSize).toBe(1);
    expect(result.score).toBe(0.556);
    expect(result.grade).toBe("C");
    expect(result.penalties).toEqual([]);
    expect(result.delaySeconds).toBe(3);
    expect(result.roundTripCost).toBe(0.036);
  });

  it("moves the copier entry to the print 3 seconds later", () => {
    const result = score([
      swap(0, 10, -10),
      swap(3, 1, -1.2),
      swap(100, -10, 12),
    ]);
    expect(result.copyReturn).toBe(-0.036);
    expect(result.winRate).toBe(0);
    expect(result.sampleSize).toBe(1);
    expect(result.score).toBe(0.476);
    expect(result.grade).toBe("D");
  });

  it("weights copy-return by the capital the copier would deploy", () => {
    const result = score([
      swap(0, 10, -10),
      swap(1_000, -10, 11.36),
      swap(5_000, 90, -90),
      swap(6_000, -90, 84.24),
    ]);
    expect(result.copyReturn).toBe(-0.08);
    expect(result.winRate).toBe(0.5);
    expect(result.sampleSize).toBe(2);
    expect(result.score).toBe(0.472);
    expect(result.grade).toBe("D");
  });

  it("lets a larger sample outrun the prior", () => {
    const trades = [];
    for (let index = 0; index < 40; index += 1) {
      const at = index * 10_000;
      trades.push(swap(at, 10, -10), swap(at + 1_000, -10, 20));
    }
    const result = score(trades);
    expect(result.sampleSize).toBe(40);
    expect(result.copyReturn).toBe(0.964);
    expect(result.score).toBe(0.917);
    expect(result.grade).toBe("A");
  });

  it("penalizes bot flow and a fresh one-shot double", () => {
    const trades = [swap(0, 10, -10), swap(1_000, -10, 20)];
    const bot = score(trades, { labels: ["bot-like"] });
    expect(bot.penalties).toEqual(["bot"]);
    expect(bot.score).toBe(0.306);
    expect(bot.grade).toBe("F");

    const fast = score(trades, { medianSwapGapSeconds: 2, swapCount: 4 });
    expect(fast.penalties).toEqual(["bot"]);
    expect(fast.score).toBe(bot.score);

    const nowMs = Date.parse("2026-10-24T00:00:00.000Z");
    const insider = score(trades, {
      historyTruncated: false,
      firstActiveAt: "2026-10-22T00:00:00.000Z",
      nowMs,
    });
    expect(insider.penalties).toEqual(["insider"]);
    expect(insider.score).toBe(0.356);
    expect(insider.grade).toBe("D");
  });

  it("does not treat a losing sub-3s round trip as insider flow", () => {
    const result = score([swap(0, 10, -10), swap(2, -10, 5)]);
    expect(result.score).toBeNull();
    expect(result.penalties).toEqual([]);
  });

  it("grades the rounded score on fixed cuts", () => {
    expect(gradeCopyTrade(0.8)).toBe("A");
    expect(gradeCopyTrade(0.799)).toBe("B");
    expect(gradeCopyTrade(0.65)).toBe("B");
    expect(gradeCopyTrade(0.649)).toBe("C");
    expect(gradeCopyTrade(0.5)).toBe("C");
    expect(gradeCopyTrade(0.499)).toBe("D");
    expect(gradeCopyTrade(0.35)).toBe("D");
    expect(gradeCopyTrade(0.349)).toBe("F");
    expect(emptyCopyTrade().score).toBeNull();
  });
});

describe("copy-trade score downstream", () => {
  it("is present on the paid quick screen instead of being dropped", async () => {
    const facilitator = mockFacilitator();
    const { app } = await createApp({
      env: testEnv(),
      facilitator,
      walletProfile: async () =>
        ({
          address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
          asOf: "2026-10-24T00:00:00.000Z",
          labels: ["net winner"],
          summary: "scored",
          pnl: { realizedUsd: 4, winRate: 1, closedTrades: 1 },
          portfolioUsd: 10,
          activity: { lastActiveAt: null },
          window: { transactions: 2 },
          copyTradeScore: 0.556,
          copyTradeGrade: "C",
          copyTrade: { ...emptyCopyTrade(), score: 0.556, grade: "C", copyReturn: 0.964, sampleSize: 1 },
        }) as never,
    });
    const address = "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM";
    const unpaid = await app.request(`http://127.0.0.1:4021/wallet/quick?address=${address}`);
    const required = await unpaid.json();
    const accepted = required.accepts.find((item: { network: string }) => item.network === SOLANA_DEVNET);
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: { transaction: "mock" },
      extensions: required.extensions,
    });
    const paid = await app.request(`http://127.0.0.1:4021/wallet/quick?address=${address}`, {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(paid.status).toBe(200);
    const body = await paid.json();
    expect(body.copyTradeScore).toBe(0.556);
    expect(body.copyTradeGrade).toBe("C");
    expect(body.copyTrade.copyReturn).toBe(0.964);
    expect(body.copyTrade.sampleSize).toBe(1);
  });
});
