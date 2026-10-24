import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mockFacilitator, testEnv } from "./helpers.js";

const A = "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM";
const B = "suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK";
const fakeProfile = async (_env: unknown, address: string) =>
  ({ address, asOf: "2026-10-24T00:00:00.000Z", labels: ["net winner"], summary: "s", pnl: { realizedUsd: address === B ? 50 : 10, winRate: 0.5, closedTrades: 2 } }) as never;

async function app() {
  return (await createApp({ env: testEnv(), facilitator: mockFacilitator(), walletProfile: fakeProfile })).app;
}

afterEach(() => {
  delete process.env.SWI_INTERNAL_KEY;
  delete process.env.RAPIDAPI_PROXY_SECRET;
});

describe("partner channels", () => {
  it("are disabled (503) without a secret", async () => {
    const r = await (await app()).request("/internal/v1/health");
    expect(r.status).toBe(503);
  });

  it("reject a wrong key (401) and never fall through to a free lookup", async () => {
    process.env.SWI_INTERNAL_KEY = "test-key-abc";
    const r = await (await app()).request(`/internal/v1/wallet/quick?address=${A}`, { headers: { "x-swi-internal-key": "nope" } });
    expect(r.status).toBe(401);
  });

  it("serve paid routes without 402 for the right key, on both channels", async () => {
    process.env.SWI_INTERNAL_KEY = "test-key-abc";
    process.env.RAPIDAPI_PROXY_SECRET = "rapid-secret";
    const a = await app();
    const r1 = await a.request(`/internal/v1/wallet/quick?address=${A}`, { headers: { "x-swi-internal-key": "test-key-abc" } });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-swi-channel")).toBe("apify");
    expect((await r1.json()).address).toBe(A);
    const r2 = await a.request(`/rapidapi/v1/wallet/quick/batch?addresses=${A},${B}`, { headers: { "x-rapidapi-proxy-secret": "rapid-secret" } });
    expect(r2.status).toBe(200);
    expect((await r2.json()).wallets.map((w: { address: string }) => w.address)).toEqual([B, A]);
    const bad = await a.request(`/internal/v1/wallet/profile?address=xyz`, { headers: { "x-swi-internal-key": "test-key-abc" } });
    expect(bad.status).toBe(400);
  });

  it("a forged dispatch header does not bypass payment", async () => {
    const r = await (await app()).request(`/wallet/quick?address=${A}`, { headers: { "x-swi-partner-dispatch": "guess" } });
    expect(r.status).toBe(402);
  });
});

describe("/wallet/quick/batch", () => {
  it("400s bad lists before payment and 402s valid ones", async () => {
    const a = await app();
    expect((await a.request(`/wallet/quick/batch?addresses=bad`)).status).toBe(400);
    expect((await a.request(`/wallet/quick/batch?addresses=${Array(11).fill(A).map((x, i) => (i ? B : x)).join(",")},x`)).status).toBe(400);
    expect((await a.request(`/wallet/quick/batch?addresses=${A},${B}`)).status).toBe(402);
  });
});
