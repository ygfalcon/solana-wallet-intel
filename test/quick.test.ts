import { describe, it, expect } from "vitest";
import { tradingStats } from "../src/services/wallet.js";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config.js";

describe("tradingStats", () => {
  it("nulls rates when window is seconds long", () => {
    const t = Array.from({ length: 50 }, (_, i) => 1_700_000_000 + i);
    const s = tradingStats(t, 40);
    expect(s.swapsPerDay).toBeNull(); expect(s.txsPerDay).toBeNull();
    expect(s.windowTooShort).toBe(true); expect(s.windowSeconds).toBe(49);
  });
  it("computes rates over a long window", () => {
    const s = tradingStats([0, 86_400], 2);
    expect(s.windowTooShort).toBe(false); expect(s.swapsPerDay).toBe(2); expect(s.txsPerDay).toBe(2);
  });
});

describe("MCP", () => {
  it("lists free wallet_preview and integer trending limit", async () => {
    const { app } = await createApp({ env: loadEnv({ X402_NETWORK: "mainnet", EVM_PAY_TO: "0x000000000000000000000000000000000000dEaD" } as any) });
    const res = await app.fetch(new Request("https://x.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    const tools = (await res.json()).result.tools;
    expect(tools.map((t: any) => t.name)).toContain("wallet_preview");
    expect(tools.find((t: any) => t.name === "token_trending").inputSchema.properties.limit.type).toBe("integer");
  }, 30000);
});
