import { describe, expect, it } from "vitest";
import { SOL_MINT } from "../src/solana.js";
import {
  accumulateHoldings,
  holdingFromAsset,
  parseUiAmount,
  presentHoldings,
} from "../src/holdings.js";
import { bucketStart, chooseGranularity, closeAt, indexClosePrices } from "../src/services/sol-history.js";
import { chooseLiquidPair, positiveUsd } from "../src/services/prices.js";
import { USDC_SOLANA_MAINNET } from "../src/config.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

describe("holdings", () => {
  it("reads uiAmountString when uiAmount is null and ignores NFT-shaped accounts", () => {
    expect(parseUiAmount({ uiAmount: null, uiAmountString: "500.5", decimals: 6 }).amount).toBe(500.5);
    expect(parseUiAmount({ uiAmount: null, amount: "1000000", decimals: 6 }).amount).toBe(1);
    expect(parseUiAmount({ amount: "123456789012345678", decimals: 8 }).amount).toBe(1234567890.12345678);

    const merged = accumulateHoldings([
      { mint: BONK, amount: 500, symbol: "BONK", name: "Bonk", priceHint: null, decimals: 5 },
      { mint: BONK, amount: 100, symbol: null, name: null, priceHint: 0.02, decimals: 5 },
      { mint: SOL_MINT, amount: 2, symbol: "SOL", name: "Solana", priceHint: null, decimals: 9 },
      { mint: "nft", amount: 1, symbol: "NFT", name: "Picture", priceHint: null, decimals: 0 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((holding) => holding.mint === BONK)).toMatchObject({ amount: 600, symbol: "BONK", priceHint: 0.02 });
  });

  it("prices the whole book before truncating the displayed holdings", () => {
    const rows = Array.from({ length: 13 }, (_, index) => ({
      mint: `mint-${index}`,
      symbol: `T${index}`,
      name: null,
      amount: 1,
      usdValue: index + 1,
    }));
    const presented = presentHoldings(rows, 12);
    expect(presented.portfolioUsd).toBe(91);
    expect(presented.holdings).toHaveLength(12);
    expect(presented.omittedHoldings).toBe(1);
    expect(presented.holdings[0].usdValue).toBe(13);
    expect(presented.holdings.some((holding) => holding.usdValue === 1)).toBe(false);

    const equal = presentHoldings(
      [1, 2, 3].map((index) => ({ mint: `m${index}`, symbol: null, name: null, amount: 1, usdValue: 1 })),
      12,
    );
    const shareSum = equal.holdings.reduce((sum, holding) => sum + (holding.sharePct ?? 0), 0);
    expect(shareSum).toBeCloseTo(100, 5);
  });

  it("keeps fungible DAS assets and sums them with native SOL", () => {
    const fungible = holdingFromAsset({
      id: BONK,
      interface: "FungibleToken",
      content: { metadata: { name: "Bonk", symbol: "BONK" } },
      token_info: { balance: 2_000_000, decimals: 5, symbol: "BONK", price_info: { price_per_token: 0 } },
    });
    const nft = holdingFromAsset({
      id: "nft-mint",
      interface: "V1_NFT",
      token_info: { balance: 1, decimals: 0 },
    });
    expect(fungible?.amount).toBe(20);
    expect(fungible?.priceHint).toBeNull();
    expect(nft).toBeNull();
  });
});

describe("price selection", () => {
  it("rejects non-positive prices and prefers a major-quote pool", () => {
    expect(positiveUsd(0)).toBeNull();
    expect(positiveUsd("0.25")).toBe(0.25);
    const pair = chooseLiquidPair(
      [
        { baseToken: { address: "mint" }, quoteToken: { address: "fake", symbol: "FAKE" }, liquidity: { usd: 1_000_000 }, priceUsd: "0.01" },
        {
          baseToken: { address: "mint" },
          quoteToken: { address: USDC_SOLANA_MAINNET, symbol: "USDC" },
          liquidity: { usd: 40_000 },
          priceUsd: "0.2",
        },
      ],
      "mint",
    );
    expect(pair?.priceUsd).toBe("0.2");
  });

  it("maps SOL candles onto the trade hour and widens the bucket for long windows", () => {
    expect(chooseGranularity(0, 10 * 3600)).toBe(3600);
    expect(chooseGranularity(0, 400 * 3600)).toBe(86_400);
    const index = indexClosePrices([[1_700_000_000, 1, 2, 3, 123.45, 0]], 3600);
    expect(closeAt(index, 1_700_000_100, 3600)).toBe(123.45);
    expect(bucketStart(1_700_000_100, 3600)).toBe(1_700_000_000 - (1_700_000_000 % 3600));
  });
});
