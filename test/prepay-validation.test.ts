import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mockFacilitator, testEnv } from "./helpers.js";

async function app() {
  return (await createApp({ env: testEnv(), facilitator: mockFacilitator() })).app;
}

describe("pre-payment validation", () => {
  it.each(["/wallet/quick", "/wallet/profile", "/wallet/funding"])("%s rejects a bad address with 400, not 402", async (path) => {
    const a = await app();
    expect((await a.fetch(new Request(`https://x.test${path}?address=bad`))).status).toBe(400);
    expect((await a.fetch(new Request(`https://x.test${path}`))).status).toBe(400);
  });
  it("valid address still gets 402", async () => {
    const a = await app();
    const r = await a.fetch(new Request("https://x.test/wallet/quick?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM"));
    expect(r.status).toBe(402);
  });
  it("GET /mcp returns 405", async () => {
    const a = await app();
    const r = await a.fetch(new Request("https://x.test/mcp", { headers: { accept: "text/event-stream" } }));
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });
});
