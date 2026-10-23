import { describe, it, expect } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config.js";

const EVM = "0x000000000000000000000000000000000000dEaD";
const base = { X402_NETWORK: "mainnet", PUBLIC_BASE_URL: "https://example.test" } as NodeJS.ProcessEnv;

async function req(env: NodeJS.ProcessEnv, path: string) {
  const app: any = await createApp({ env: loadEnv(env) });
  const h = app.fetch ? app : app.app;
  return h.fetch(new Request(`https://example.test${path}`));
}
function decode(res: Response) {
  const hdr = res.headers.get("payment-required");
  return hdr ? JSON.parse(Buffer.from(hdr, "base64").toString()) : null;
}

describe("Base via PayAI", () => {
  it("402 lists Solana and Base when EVM_PAY_TO set", async () => {
    const res = await req({ ...base, EVM_PAY_TO: EVM }, "/wallet/quick?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM");
    expect(res.status).toBe(402);
    const nets = decode(res).accepts.map((a: any) => a.network);
    expect(nets).toContain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(nets).toContain("eip155:8453");
    const b = decode(res).accepts.find((a: any) => a.network === "eip155:8453");
    expect(b.payTo).toBe(EVM);
    expect(b.asset.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  }, 30000);
  it("discovery lists both", async () => {
    const res = await req({ ...base, EVM_PAY_TO: EVM }, "/.well-known/x402");
    const txt = await res.text();
    expect(txt).toContain("eip155:8453");
    expect(txt).toContain("solana:5eykt");
  }, 30000);
  it("Solana only without EVM_PAY_TO", async () => {
    const res = await req(base, "/wallet/quick?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM");
    expect(res.status).toBe(402);
    expect(decode(res).accepts.map((a: any) => a.network)).toEqual(["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  }, 30000);
});
