import { describe, it, expect } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config.js";

describe("mcp transport", () => {
  it("GET /mcp returns 405 instead of holding an SSE stream open", async () => {
    const { app } = await createApp({ env: loadEnv({ X402_NETWORK: "mainnet" } as any) });
    const res = await app.fetch(new Request("https://x.test/mcp", { headers: { accept: "text/event-stream" } }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  }, 30000);
});
