import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mockFacilitator, testEnv } from "./helpers.js";

async function app() {
  return (await createApp({ env: testEnv(), facilitator: mockFacilitator() })).app;
}

describe("pre-payment validation", () => {
  it.each(["/wallet/quick", "/wallet/profile", "/wallet/funding"])(
    "%s answers an unpaid probe with 402 even when the address is missing or invalid",
    async (path) => {
      const a = await app();
      expect((await a.fetch(new Request(`https://x.test${path}`))).status).toBe(402);
      expect((await a.fetch(new Request(`https://x.test${path}?address=bad`))).status).toBe(402);
    },
  );
  it("valid address still gets 402", async () => {
    const a = await app();
    const r = await a.fetch(new Request("https://x.test/wallet/quick?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM"));
    expect(r.status).toBe(402);
    const spaced = await a.fetch(
      new Request("https://x.test/wallet/profile?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM&txLimit=%2020%20"),
    );
    expect(spaced.status).toBe(402);
  });
  it("lets unpaid out-of-range queries reach the 402 paywall", async () => {
    const a = await app();
    const txLimit = await a.fetch(
      new Request("https://x.test/wallet/profile?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM&txLimit=2"),
    );
    expect(txLimit.status).toBe(402);
    const limit = await a.fetch(new Request("https://x.test/token/trending?limit=0"));
    expect(limit.status).toBe(402);
    const peers = await a.fetch(
      new Request("https://x.test/wallet/funding?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM&peers=not-a-wallet"),
    );
    expect(peers.status).toBe(402);
    const missing = await a.fetch(new Request("https://x.test/wallet/quick/batch"));
    expect(missing.status).toBe(402);
    const badBatch = await a.fetch(new Request("https://x.test/wallet/quick/batch?addresses=not-a-wallet"));
    expect(badBatch.status).toBe(402);
  });
  it("GET /mcp returns 405", async () => {
    const a = await app();
    const r = await a.fetch(new Request("https://x.test/mcp", { headers: { accept: "text/event-stream" } }));
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });
});
