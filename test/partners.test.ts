import { describe, it, expect, afterEach } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config.js";

const fakeTrending = async () => ({ asOf: "t", source: "test", tokens: [] } as any);
const fakeWallet = async (_e: any, address: string) => ({ address, labels: ["net winner"], pnl: { realizedUsd: 5, winRate: 0.5, closedTrades: 2 }, trading: {}, activity: {}, window: {} } as any);
const mk = () => createApp({ env: loadEnv({ X402_NETWORK: "mainnet" } as any), trending: fakeTrending, walletProfile: fakeWallet });
const W = "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM";
afterEach(() => { delete process.env.SWI_INTERNAL_KEY; delete process.env.RAPIDAPI_PROXY_SECRET; });

describe("partner channels", () => {
  it("disabled when secret unset or placeholder", async () => {
    process.env.RAPIDAPI_PROXY_SECRET = "PLACEHOLDER_SET_FROM_RAPIDAPI";
    const { app } = await mk();
    expect((await app.fetch(new Request("https://x.test/rapidapi/v1/health", { headers: { "x-rapidapi-proxy-secret": "PLACEHOLDER_SET_FROM_RAPIDAPI" } }))).status).toBe(503);
    expect((await app.fetch(new Request("https://x.test/internal/v1/health"))).status).toBe(503);
  });
  it("rejects bad key, serves good key without x402", async () => {
    process.env.SWI_INTERNAL_KEY = "k".repeat(40);
    const { app } = await mk();
    expect((await app.fetch(new Request(`https://x.test/internal/v1/wallet/quick?address=${W}`, { headers: { "x-swi-internal-key": "nope" } }))).status).toBe(401);
    const ok = await app.fetch(new Request(`https://x.test/internal/v1/wallet/quick?address=${W}`, { headers: { "x-swi-internal-key": "k".repeat(40) } }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).netWinner).toBe(true);
    const t = await app.fetch(new Request(`https://x.test/internal/v1/token/trending?limit=3`, { headers: { "x-swi-internal-key": "k".repeat(40) } }));
    expect(t.status).toBe(200);
  }, 30000);
  it("public x402 route still asks for payment", async () => {
    const { app } = await mk();
    expect((await app.fetch(new Request(`https://x.test/wallet/quick?address=${W}`))).status).toBe(402);
  }, 30000);
});
