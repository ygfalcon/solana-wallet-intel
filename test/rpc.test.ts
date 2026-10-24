import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "../src/config.js";
import { PUBLIC_SOLANA_RPCS, createPublicRpc } from "../src/public-rpc.js";
import { solanaRpc } from "../src/solana-rpc.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("solana RPC failover", () => {
  it("uses the next free mainnet endpoint after HTTP 429 and keeps devnet on its own URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("rpc.test") || url.includes("rpc-dev.test")) {
        return new Response("slow down", { status: 429 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const mainnet = loadEnv({
      WALLET_CLUSTER: "mainnet",
      SOLANA_RPC_URL: "https://rpc.test",
      X402_NETWORK: "devnet",
    });
    await expect(solanaRpc<number>(mainnet, "getBalance", ["wallet"])).resolves.toBe(5);
    expect(seen[0]).toBe("https://rpc.test");
    expect(seen[1]).toBe(PUBLIC_SOLANA_RPCS[0]);

    seen.length = 0;
    const devnet = loadEnv({
      WALLET_CLUSTER: "devnet",
      SOLANA_RPC_URL: "https://rpc-dev.test",
      X402_NETWORK: "devnet",
    });
    await expect(solanaRpc(devnet, "getBalance", ["wallet"])).rejects.toThrow(/HTTP 429/);
    expect(seen).toEqual(["https://rpc-dev.test"]);
    expect(seen.join(" ")).not.toMatch(/mainnet-beta|publicnode|ankr/);
  });
});

describe("public RPC batch errors", () => {
  it("tries the next endpoint when a 200 body is a rate-limit error", async () => {
    const seen: string[] = [];
    const rpc = createPublicRpc({
      endpoints: ["https://rpc.example/a", "https://rpc.example/b"],
      minIntervalMs: 0,
      fetch: async (url) => {
        seen.push(String(url));
        if (String(url).endsWith("/a")) {
          return Response.json([{ jsonrpc: "2.0", id: 1, error: { message: "rate limit exceeded" } }]);
        }
        return Response.json([{ jsonrpc: "2.0", id: 1, result: "ok" }]);
      },
    });
    await expect(rpc.batch([{ method: "getSlot", params: [] }])).resolves.toEqual(["ok"]);
    expect(seen).toEqual(["https://rpc.example/a", "https://rpc.example/b"]);
  });
});
