import { base58 } from "@scure/base";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "../src/config.js";
import { createSlaTracker, runWithSla } from "../src/sla.js";
import {
  LP_BURN_AUTHORITIES,
  RAYDIUM_AMM_V4,
  RAYDIUM_CPMM,
  assessAuthorities,
  assessHolders,
  assessLp,
  assessSnipers,
  inflowsForMint,
  readPoolLp,
} from "../src/token-risk.js";
import { PUBLIC_SOLANA_RPCS, createPublicRpc } from "../src/public-rpc.js";
import { enrichTrendingTokens } from "../src/services/token-safety.js";
import { assembleTrending, loadTrending, type TrendingToken } from "../src/services/trending.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
const LOCK_PROGRAM = "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE";
const HOLDER = "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM";

function pubkey(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("holder concentration", () => {
  it("flags the top 10 share when it is at least half of supply", () => {
    const accounts = [
      { address: "vault", amount: 900 },
      ...Array.from({ length: 12 }, (_, index) => ({ address: `h${index}`, amount: index === 0 ? 400 : 40 })),
    ];
    const check = assessHolders({ supply: 1_000, accounts, exclude: ["vault"] });
    const topTen = 400 + 40 * 9;
    expect(check.top10Share).toBeCloseTo(topTen / 1_000, 4);
    expect(check.riskFlags).toEqual([`Top 10 holders control ${Math.round((topTen / 1_000) * 100)}% of supply.`]);
  });

  it("keeps a concentrated-but-minority top 10 as a note", () => {
    const check = assessHolders({
      supply: 1_000,
      accounts: [
        { address: "a", amount: 80 },
        { address: "b", amount: 40 },
      ],
    });
    expect(check.top10Share).toBeCloseTo(0.12, 4);
    expect(check.note).toBe("Top 10 holders control 12% of supply.");
    expect(check.riskFlags).toEqual([]);
  });

  it("does not invent a share when supply is missing", () => {
    const check = assessHolders({ supply: null, accounts: [{ address: "a", amount: 10 }] });
    expect(check.top10Share).toBeNull();
    expect(check.note).toBe("Holder concentration could not be measured.");
    expect(check.riskFlags).toEqual([]);
  });
});

describe("mint and freeze authority", () => {
  it("flags an active mint authority and an active freeze authority", () => {
    const check = assessAuthorities({ readable: true, mintAuthority: HOLDER, freezeAuthority: HOLDER });
    expect(check.riskFlags).toEqual([
      "Mint authority is still active, so the issuer can create more tokens.",
      "Freeze authority is still active, so the issuer can freeze token accounts.",
    ]);
  });

  it("records revoked authorities without a risk flag", () => {
    const check = assessAuthorities({ readable: true, mintAuthority: null, freezeAuthority: null });
    expect(check.note).toBe("Mint authority is revoked. Freeze authority is revoked.");
    expect(check.riskFlags).toEqual([]);
  });

  it("does not claim the authorities are revoked when the mint account is missing", () => {
    const check = assessAuthorities({ readable: false, mintAuthority: null, freezeAuthority: null });
    expect(check.note).toBe("Mint and freeze authority could not be read.");
    expect(check.riskFlags).toEqual([]);
  });
});

describe("LP lock or burn", () => {
  it("reads the Raydium AMM v4 LP mint from the published layout offset", () => {
    const u64Count = 32;
    const afterU64 = 16 + 16 + 8 + 16 + 16 + 8;
    const pubkeysBeforeLp = 4;
    const offset = u64Count * 8 + afterU64 + pubkeysBeforeLp * 32;
    expect(offset).toBe(464);
    const lpMint = pubkey(7);
    const data = concat([new Uint8Array(offset), lpMint, pubkey(8)]);
    const pool = readPoolLp(RAYDIUM_AMM_V4, data);
    expect(pool).toMatchObject({ kind: "standard", lpMint: base58.encode(lpMint) });
    if (pool.kind !== "standard") throw new Error("expected a standard pool");
    expect(pool.vaults).toHaveLength(2);
    expect(pool.vaults[0]).toBe(base58.encode(new Uint8Array(32)));
  });

  it("reads the Raydium CPMM LP mint after the anchor discriminator and four pubkeys", () => {
    const offset = 8 + 32 * 4;
    expect(offset).toBe(136);
    const lpMint = pubkey(9);
    const vault0 = pubkey(3);
    const vault1 = pubkey(4);
    const data = concat([new Uint8Array(8 + 64), vault0, vault1, lpMint]);
    const pool = readPoolLp(RAYDIUM_CPMM, data);
    expect(pool).toMatchObject({ kind: "standard", lpMint: base58.encode(lpMint), vaults: [base58.encode(vault0), base58.encode(vault1)] });
  });

  it("treats Orca whirlpools as concentrated liquidity", () => {
    const pool = readPoolLp("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", new Uint8Array(200));
    expect(pool.kind).toBe("concentrated");
    const check = assessLp({ kind: "concentrated", supply: null, holders: [] });
    expect(check.status).toBe("concentrated");
    expect(check.note).toBe("This pool uses concentrated liquidity, so there is no single LP token to lock or burn.");
    expect(check.riskFlags).toEqual([]);
  });

  it("calls LP burned only when a burn address holds at least 95 percent", () => {
    expect(LP_BURN_AUTHORITIES).toContain(INCINERATOR);
    const check = assessLp({
      kind: "standard",
      supply: 100,
      holders: [{ owner: INCINERATOR, amount: 96, ownerProgram: null }],
    });
    expect(check.status).toBe("burned");
    expect(check.note).toBe("LP is burned. Burn addresses hold 96% of the LP supply.");
    expect(check.riskFlags).toEqual([]);
  });

  it("calls LP locked when a known locker program holds at least 95 percent", () => {
    const check = assessLp({
      kind: "standard",
      supply: 100,
      holders: [{ owner: HOLDER, amount: 98, ownerProgram: LOCK_PROGRAM }],
    });
    expect(check.status).toBe("locked");
    expect(check.note).toBe("LP is locked. A known locker holds 98% of the LP supply.");
    expect(check.riskFlags).toEqual([]);
  });

  it("flags unlocked LP and names the holder when it is not a known locker", () => {
    const check = assessLp({
      kind: "standard",
      supply: 100,
      holders: [{ owner: HOLDER, amount: 100, ownerProgram: "11111111111111111111111111111111" }],
    });
    expect(check.status).toBe("unlocked");
    expect(check.riskFlags).toContain("LP is unlocked, so liquidity can be pulled.");
    expect(check.note).toBe(`LP is held by ${HOLDER}, which is not a known burn address or locker.`);
  });

  it("does not claim the LP is safe when the pool cannot be read", () => {
    const check = assessLp({ kind: "unknown", supply: null, holders: [] });
    expect(check.status).toBe("unknown");
    expect(check.note).toBe("LP lock or burn status could not be read for this pool.");
    expect(check.riskFlags).toEqual([]);
  });
});

describe("sniper and bundle share", () => {
  it("combines earliest-slot snipers and bundled wallets without double counting", () => {
    const check = assessSnipers({
      measured: true,
      supply: 100,
      creationSlot: 10,
      buys: [
        { wallet: "A", slot: 10, amount: 10 },
        { wallet: "B", slot: 10, amount: 10 },
        { wallet: "C", slot: 10, amount: 10 },
        { wallet: "A", slot: 11, amount: 5 },
        { wallet: "D", slot: 30, amount: 50 },
      ],
    });
    expect(check.share).toBeCloseTo(0.35, 4);
    expect(check.riskFlags).toEqual(["Snipers and bundled wallets took 35% of supply in the earliest slots."]);
  });

  it("uses the earliest observed slot when the creation slot is unknown", () => {
    const check = assessSnipers({
      measured: true,
      supply: 100,
      creationSlot: null,
      buys: [
        { wallet: "A", slot: 5, amount: 4 },
        { wallet: "B", slot: 8, amount: 50 },
      ],
    });
    expect(check.share).toBeCloseTo(0.04, 4);
    expect(check.note).toBe("Snipers and bundled wallets took 4% of supply in the earliest slots.");
    expect(check.riskFlags).toEqual([]);
  });

  it("counts a slot with three distinct buyers as a bundle", () => {
    const check = assessSnipers({
      measured: true,
      supply: 100,
      creationSlot: 1,
      buys: [
        { wallet: "A", slot: 9, amount: 10 },
        { wallet: "B", slot: 9, amount: 10 },
        { wallet: "C", slot: 9, amount: 10 },
      ],
    });
    expect(check.share).toBeCloseTo(0.3, 4);
    expect(check.riskFlags[0]).toMatch(/30%/);
  });

  it("does not invent a share when early history was not measured", () => {
    const check = assessSnipers({ measured: false, supply: 100, creationSlot: 1, buys: [] });
    expect(check.share).toBeNull();
    expect(check.note).toBe("Sniper and bundle share of early supply could not be measured.");
    expect(check.riskFlags).toEqual([]);
  });
});

describe("early buy parsing", () => {
  it("sums token inflows and skips pool vaults", () => {
    const inflows = inflowsForMint(
      {
        meta: {
          preTokenBalances: [
            { accountIndex: 1, mint: "mint", owner: "buyer", uiTokenAmount: { uiAmount: 1, decimals: 6, amount: "1000000" } },
            { accountIndex: 2, mint: "mint", owner: "pool", uiTokenAmount: { uiAmount: 0, decimals: 6, amount: "0" } },
          ],
          postTokenBalances: [
            { accountIndex: 1, mint: "mint", owner: "buyer", uiTokenAmount: { uiAmount: 4, decimals: 6, amount: "4000000" } },
            { accountIndex: 2, mint: "mint", owner: "pool", uiTokenAmount: { uiAmount: 9, decimals: 6, amount: "9000000" } },
          ],
        },
        transaction: { message: { accountKeys: ["payer", "buyer-account", "vault"] } },
      },
      "mint",
      ["vault"],
    );
    expect(inflows).toEqual([{ wallet: "buyer", amount: 3 }]);
  });
});

describe("public Solana RPC", () => {
  it("uses free public endpoints and refuses Helius or keyed URLs", () => {
    expect(PUBLIC_SOLANA_RPCS.length).toBeGreaterThan(1);
    expect(PUBLIC_SOLANA_RPCS.join(" ")).not.toMatch(/helius|api-key/i);
  });

  it("batches calls into one request and waits between requests", async () => {
    const calls: Array<{ url: string; at: number; count: number }> = [];
    let now = 0;
    const rpc = createPublicRpc({
      endpoints: ["https://rpc.example/a", "https://rpc.example/b"],
      minIntervalMs: 250,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), at: now, count: body.length });
        return Response.json(body.map((item: { id: number }) => ({ jsonrpc: "2.0", id: item.id, result: item.id })));
      },
    });
    const first = await rpc.batch([
      { method: "getSlot", params: [] },
      { method: "getHealth", params: [] },
    ]);
    expect(first).toEqual([1, 2]);
    expect(calls).toEqual([{ url: "https://rpc.example/a", at: 0, count: 2 }]);
    await rpc.batch(Array.from({ length: 9 }, () => ({ method: "getSlot", params: [] })));
    expect(calls).toHaveLength(3);
    expect(calls[1].count).toBe(8);
    expect(calls[2].count).toBe(1);
    expect(calls[1].at).toBeGreaterThanOrEqual(250);
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(250);
  });

  it("falls back to the next endpoint after HTTP 429 and keeps secrets out of the error", async () => {
    const seen: string[] = [];
    const rpc = createPublicRpc({
      endpoints: ["https://rpc.example/a", "https://rpc.example/b", "https://rpc.example/secret?api-key=supersecret"],
      minIntervalMs: 0,
      fetch: async (url) => {
        seen.push(String(url));
        if (String(url).endsWith("/a")) return new Response("slow down", { status: 429 });
        if (String(url).includes("supersecret")) return new Response("keyed", { status: 500 });
        return Response.json([{ jsonrpc: "2.0", id: 1, result: "ok" }]);
      },
    });
    await expect(rpc.batch([{ method: "getSlot", params: [] }])).resolves.toEqual(["ok"]);
    expect(seen).toEqual(["https://rpc.example/a", "https://rpc.example/b"]);

    const failing = createPublicRpc({
      endpoints: ["https://rpc.example/secret?api-key=supersecret"],
      minIntervalMs: 0,
      fetch: async () => {
        throw new Error("keyed endpoint was requested");
      },
    });
    await expect(failing.batch([{ method: "getSlot", params: [] }])).rejects.toThrow(/public Solana RPC failed/);
    await failing.batch([{ method: "getSlot", params: [] }]).catch((error: unknown) => {
      const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
      expect(message).not.toContain("supersecret");
      expect(message).not.toContain("rpc.example");
    });
  });

  it("records a public RPC 429 on the Solana RPC health source", async () => {
    const tracker = createSlaTracker({ now: () => 1_000 });
    const rpc = createPublicRpc({
      endpoints: ["https://rpc.example/a", "https://rpc.example/b"],
      minIntervalMs: 0,
      fetch: async (url) => {
        if (String(url).endsWith("/a")) return new Response("no", { status: 429 });
        return Response.json([{ jsonrpc: "2.0", id: 1, result: 1 }]);
      },
    });
    await runWithSla(tracker, () => rpc.batch([{ method: "getSlot", params: [] }]));
    const snapshot = tracker.snapshot({ entries: 0, ageMs: null, newestAgeMs: null, ttlMs: null });
    expect(snapshot.upstream.status).toBe("rate_limited");
    expect(snapshot.upstream.sources.map((source) => source.source)).toContain("solana-rpc");
  });
});

describe("trending safety enrichment", () => {
  it("adds the four checks from batched public RPC reads and keeps market flags", async () => {
    const mint = "mint-risk";
    const pair = "pair-risk";
    const lpMintBytes = pubkey(9);
    const lpMint = base58.encode(lpMintBytes);
    const pool = concat([new Uint8Array(464), lpMintBytes]);
    const token: TrendingToken = {
      rank: 1,
      mint,
      symbol: "RISK",
      name: "Risk",
      priceUsd: 1,
      liquidityUsd: 50_000,
      volume24hUsd: 80_000,
      priceChange24hPct: 1,
      ageHours: 2,
      pairAddress: pair,
      dex: "raydium",
      url: null,
      riskFlags: ["paid_boost"],
    };
    const batches: string[][] = [];
    const rpc = {
      async batch(requests: Array<{ method: string; params: unknown[] }>) {
        batches.push(requests.map((request) => request.method));
        return requests.map((request) => {
          const key = String(request.params[0] ?? "");
          if (request.method === "getAccountInfo" && key === mint) {
            return {
              value: {
                data: { parsed: { info: { mintAuthority: HOLDER, freezeAuthority: null, supply: "1000", decimals: 0 } } },
              },
            };
          }
          if (request.method === "getTokenSupply" && key === mint) return { value: { uiAmount: 1000, decimals: 0, amount: "1000" } };
          if (request.method === "getTokenLargestAccounts" && key === mint) {
            return { value: [{ address: "holder-account", uiAmount: 720, amount: "720", decimals: 0 }] };
          }
          if (request.method === "getAccountInfo" && key === pair) {
            return { value: { owner: RAYDIUM_AMM_V4, data: [Buffer.from(pool).toString("base64"), "base64"] } };
          }
          if (request.method === "getTokenSupply" && key === lpMint) return { value: { uiAmount: 100, decimals: 0, amount: "100" } };
          if (request.method === "getTokenLargestAccounts" && key === lpMint) {
            return { value: [{ address: "lp-account", uiAmount: 100, amount: "100", decimals: 0 }] };
          }
          if (request.method === "getMultipleAccounts" && Array.isArray(request.params[0]) && request.params[0].includes("lp-account")) {
            return {
              value: [{ data: { parsed: { info: { owner: HOLDER } } } }],
            };
          }
          if (request.method === "getMultipleAccounts" && Array.isArray(request.params[0]) && request.params[0].includes(HOLDER)) {
            return { value: [{ owner: "11111111111111111111111111111111" }] };
          }
          if (request.method === "getSignaturesForAddress" && key === mint) {
            return [{ signature: "sig-a", slot: 10 }];
          }
          if (request.method === "getTransaction") {
            return {
              slot: 10,
              meta: {
                preTokenBalances: [],
                postTokenBalances: [
                  { accountIndex: 1, mint, owner: "sniper", uiTokenAmount: { uiAmount: 250, decimals: 0, amount: "250" } },
                ],
              },
              transaction: { message: { accountKeys: ["payer", "sniper-account"] } },
            };
          }
          return null;
        });
      },
    };

    const [enriched] = await enrichTrendingTokens([token], rpc);
    expect(batches[0]?.length).toBeGreaterThan(1);
    expect(enriched.riskFlags).toEqual([
      "paid_boost",
      "Top 10 holders control 72% of supply.",
      "Mint authority is still active, so the issuer can create more tokens.",
      "LP is unlocked, so liquidity can be pulled.",
      "Snipers and bundled wallets took 25% of supply in the earliest slots.",
    ]);
    expect(enriched.checks?.holders.top10Share).toBeCloseTo(0.72, 4);
    expect(enriched.checks?.authorities.freezeAuthority).toBeNull();
    expect(enriched.checks?.lp.status).toBe("unlocked");
    expect(enriched.checks?.snipers.share).toBeCloseTo(0.25, 4);
    expect(JSON.stringify(batches)).not.toMatch(/helius|api-key/i);
  });

  it("leaves rank order alone and recounts flags after enrichment", async () => {
    const report = assembleTrending({
      boosted: new Set(),
      birdeye: [],
      sources: ["dexscreener"],
      warnings: [],
      limit: 5,
      pairs: [
        {
          chainId: "solana",
          baseToken: { address: "clean", symbol: "CLEAN" },
          quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
          liquidity: { usd: 100_000 },
          volume: { h24: 200_000 },
          priceUsd: "2",
          pairCreatedAt: Date.now() - 100 * 3_600_000,
          pairAddress: "pair-clean",
          dexId: "raydium",
        },
      ],
    });
    const rpc = {
      async batch(requests: Array<{ method: string; params: unknown[] }>) {
        return requests.map((request) => {
          if (request.method === "getTokenSupply") return { value: { uiAmount: 100, decimals: 0, amount: "100" } };
          if (request.method === "getTokenLargestAccounts") return { value: [{ address: "a", uiAmount: 10, amount: "10", decimals: 0 }] };
          if (request.method === "getAccountInfo" && request.params[0] === "clean") {
            return { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } };
          }
          if (request.method === "getSignaturesForAddress") return [{ signature: "only", slot: 4 }];
          if (request.method === "getTransaction") {
            return {
              meta: { preTokenBalances: [], postTokenBalances: [] },
              transaction: { message: { accountKeys: [] } },
            };
          }
          return { value: null };
        });
      },
    };
    const enriched = await enrichTrendingTokens(report.tokens, rpc);
    expect(enriched.map((token) => token.symbol)).toEqual(["CLEAN"]);
    expect(enriched[0].checks?.holders.note).toBe("Top 10 holders control 10% of supply.");
    expect(enriched[0].checks?.lp.note).toMatch(/could not be read/);
    expect(enriched[0].riskFlags).toEqual([]);
  });

  it("does not treat a missing RPC field as a safe zero", async () => {
    const token: TrendingToken = {
      rank: 1,
      mint: "mint-missing",
      symbol: "MISS",
      name: null,
      priceUsd: null,
      liquidityUsd: null,
      volume24hUsd: null,
      priceChange24hPct: null,
      ageHours: 1,
      pairAddress: null,
      dex: null,
      url: null,
      riskFlags: [],
    };
    const rpc = {
      async batch(requests: Array<{ method: string; params: unknown[] }>) {
        return requests.map((request) => {
          if (request.method === "getTokenSupply") return { value: { uiAmount: 100, decimals: 0, amount: "100" } };
          if (request.method === "getAccountInfo") {
            return { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } };
          }
          return null;
        });
      },
    };
    const [enriched] = await enrichTrendingTokens([token], rpc);
    expect(enriched.checks?.holders.top10Share).toBeNull();
    expect(enriched.checks?.holders.note).toBe("Holder concentration could not be measured.");
    expect(enriched.checks?.snipers.share).toBeNull();
    expect(enriched.checks?.snipers.note).toBe("Sniper and bundle share of early supply could not be measured.");
    expect(enriched.riskFlags).toEqual([]);
  });

  it("loads trending safety from public RPCs and does not call Helius", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("dexscreener.com/token-boosts")) {
        return Response.json([{ chainId: "solana", tokenAddress: "mint-public" }]);
      }
      if (url.includes("dexscreener.com/tokens")) {
        return Response.json([
          {
            chainId: "solana",
            baseToken: { address: "mint-public", symbol: "PUB" },
            quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
            liquidity: { usd: 40_000 },
            volume: { h24: 90_000 },
            priceUsd: "0.2",
            pairAddress: "pair-public",
            dexId: "raydium",
            pairCreatedAt: Date.now() - 48 * 3_600_000,
          },
        ]);
      }
      const body = JSON.parse(String(init?.body ?? "[]")) as Array<{ id: number; method: string; params: unknown[] }>;
      return Response.json(
        body.map((item) => {
          const key = String(item.params?.[0] ?? "");
          if (item.method === "getTokenSupply") {
            return { jsonrpc: "2.0", id: item.id, result: { value: { uiAmount: 100, decimals: 0, amount: "100" } } };
          }
          if (item.method === "getTokenLargestAccounts") {
            return { jsonrpc: "2.0", id: item.id, result: { value: [{ address: "a", uiAmount: 10, amount: "10", decimals: 0 }] } };
          }
          if (item.method === "getAccountInfo" && key === "mint-public") {
            return {
              jsonrpc: "2.0",
              id: item.id,
              result: { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } },
            };
          }
          if (item.method === "getSignaturesForAddress") return { jsonrpc: "2.0", id: item.id, result: [] };
          return { jsonrpc: "2.0", id: item.id, result: { value: null } };
        }),
      );
    };
    const report = await loadTrending(
      loadEnv({
        X402_NETWORK: "devnet",
        SOLANA_PAY_TO: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
        EVM_PAY_TO: "0x1111111111111111111111111111111111111111",
        WALLET_CLUSTER: "mainnet",
        PRICE_WALLET_PROFILE: "$0.01",
        PRICE_TOKEN_TRENDING: "$0.005",
        HELIUS_API_KEY: "supersecret-helius",
      }),
      5,
    );
    expect(report.sources).toEqual(["dexscreener", "public-solana-rpc"]);
    expect(report.tokens[0].symbol).toBe("PUB");
    expect(report.tokens[0].checks?.holders.note).toBe("Top 10 holders control 10% of supply.");
    expect(report.tokens[0].checks?.authorities.note).toMatch(/Mint authority is revoked/);
    expect(urls.some((url) => PUBLIC_SOLANA_RPCS.includes(url))).toBe(true);
    expect(urls.join("\n")).not.toContain("supersecret-helius");
    expect(urls.join("\n")).not.toMatch(/helius/i);
  });
});
