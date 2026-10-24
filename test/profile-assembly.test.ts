import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, USDC_SOLANA_MAINNET } from "../src/config.js";
import { buildWalletProfile, legsFromHelius } from "../src/services/wallet.js";
import { SOL_MINT } from "../src/solana.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const OWNER = "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function tokenAccount(mint: string, uiAmountString: string, decimals: number) {
  return {
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: { uiAmount: null, uiAmountString, decimals, amount: "0" },
          },
        },
      },
    },
  };
}

function swap(owner: string, bonkPre: string, bonkPost: string, usdcPre: string, usdcPost: string) {
  return {
    meta: {
      fee: 5000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [
        { owner, mint: BONK, uiTokenAmount: { uiAmountString: bonkPre, decimals: 5 } },
        { owner, mint: USDC_SOLANA_MAINNET, uiTokenAmount: { uiAmountString: usdcPre, decimals: 6 } },
      ],
      postTokenBalances: [
        { owner, mint: BONK, uiTokenAmount: { uiAmountString: bonkPost, decimals: 5 } },
        { owner, mint: USDC_SOLANA_MAINNET, uiTokenAmount: { uiAmountString: usdcPost, decimals: 6 } },
      ],
    },
    transaction: { message: { accountKeys: [owner] } },
  };
}

describe("wallet profile assembly", () => {
  it("sums split balances, skips NFTs, and applies oldest fills first", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : null;
      let body: unknown;
      if (url.includes("api.jup.ag")) {
        body = {
          [SOL_MINT]: { usdPrice: 100 },
          [BONK]: { usdPrice: 0.02 },
          [USDC_SOLANA_MAINNET]: { usdPrice: 1 },
        };
      } else if (url.includes("dexscreener")) {
        body = [];
      } else if (payload?.method === "getSignaturesForAddress") {
        body = {
          result: [
            { signature: "sell", blockTime: 2_000, err: null },
            { signature: "buy", blockTime: 1_000, err: null },
          ],
        };
      } else if (payload?.method === "getTransaction" && payload.params?.[0] === "buy") {
        body = { result: swap(OWNER, "0", "1000", "10", "0") };
      } else if (payload?.method === "getTransaction" && payload.params?.[0] === "sell") {
        body = { result: swap(OWNER, "1000", "600", "0", "8") };
      } else if (payload?.method === "getBalance") {
        body = { result: 2_000_000_000 };
      } else if (payload?.method === "getTokenAccountsByOwner" && payload.params?.[1]?.programId === TOKEN_PROGRAM) {
        body = {
          result: {
            value: [
              tokenAccount(BONK, "500", 5),
              tokenAccount(BONK, "100", 5),
              tokenAccount("nft-mint", "1", 0),
            ],
          },
        };
      } else if (payload?.method === "getTokenAccountsByOwner") {
        body = { result: { value: [] } };
      } else {
        throw new Error(`unexpected fetch ${url} ${payload?.method ?? ""}`);
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const env = loadEnv({
      X402_NETWORK: "devnet",
      WALLET_CLUSTER: "mainnet",
      SOLANA_RPC_URL: "https://rpc.test",
      HELIUS_API_KEY: "",
      JUPITER_API_KEY: "",
      BIRDEYE_API_KEY: "",
    });
    const profile = await buildWalletProfile(env, OWNER, 5);
    const bonk = profile.holdings.find((holding) => holding.mint === BONK);
    const sol = profile.holdings.find((holding) => holding.mint === SOL_MINT);
    expect(bonk?.amount).toBe(600);
    expect(sol?.amount).toBe(2);
    expect(profile.holdings.some((holding) => holding.mint === "nft-mint")).toBe(false);
    expect(profile.portfolioUsd).toBe(212);
    expect(profile.pnl.realizedUsd).toBe(4);
    expect(profile.pnl.unrealizedUsd).toBe(6);
    expect(profile.pnl.partialCostBasis).toBe(false);
    expect(profile.activity.swapCount).toBe(2);
    expect(profile.summary.length).toBeGreaterThan(40);
    expect(profile.labelDetails.length).toBe(profile.labels.length);
    expect(profile.warnings.join(" ")).not.toContain("api-key=");
  });

  it("reads native SOL from RPC when the asset index omits nativeBalance", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const payload = init?.body ? JSON.parse(String(init.body)) : null;
      let body: unknown;
      if (url.includes("api.helius.xyz")) body = [];
      else if (url.includes("api.jup.ag")) body = { [SOL_MINT]: { usdPrice: 100 }, [BONK]: { usdPrice: 0.02 } };
      else if (url.includes("dexscreener")) body = [];
      else if (payload?.method === "searchAssets") {
        body = {
          result: {
            items: [
              {
                id: BONK,
                interface: "FungibleToken",
                content: { metadata: { symbol: "BONK", name: "Bonk" } },
                token_info: { balance: 500_000, decimals: 5, symbol: "BONK" },
              },
            ],
          },
        };
      } else if (payload?.method === "getBalance") body = { result: 3_000_000_000 };
      else throw new Error(`unexpected fetch ${url} ${payload?.method ?? ""}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const env = loadEnv({
      X402_NETWORK: "devnet",
      WALLET_CLUSTER: "mainnet",
      SOLANA_RPC_URL: "https://rpc.test",
      HELIUS_API_KEY: "test-key",
      JUPITER_API_KEY: "",
      BIRDEYE_API_KEY: "",
    });
    const profile = await buildWalletProfile(env, OWNER, 5);
    expect(profile.holdings.find((holding) => holding.mint === SOL_MINT)?.amount).toBe(3);
    expect(profile.holdings.find((holding) => holding.mint === BONK)?.amount).toBe(5);
    expect(profile.portfolioUsd).toBe(300.1);
    expect(profile.sources).toContain("helius");
    expect(profile.warnings.join(" ")).not.toContain("test-key");
  });

  it("ignores failed Helius transactions and nets USDC change", () => {
    expect(
      legsFromHelius(
        {
          transactionError: { error: "failed" },
          tokenTransfers: [{ fromUserAccount: "other", toUserAccount: "owner", mint: BONK, tokenAmount: 5 }],
        },
        "owner",
      ),
    ).toEqual([]);

    expect(
      legsFromHelius(
        {
          tokenTransfers: [
            { fromUserAccount: "owner", toUserAccount: "pool", mint: USDC_SOLANA_MAINNET, tokenAmount: 100 },
            { fromUserAccount: "pool", toUserAccount: "owner", mint: USDC_SOLANA_MAINNET, tokenAmount: 5 },
            { fromUserAccount: "pool", toUserAccount: "owner", mint: BONK, tokenAmount: 1000 },
          ],
        },
        "owner",
      ),
    ).toEqual([
      { mint: USDC_SOLANA_MAINNET, delta: -95 },
      { mint: BONK, delta: 1000 },
    ]);
  });
});
