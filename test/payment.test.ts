import { encodePaymentSignatureHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { UpstreamError } from "../src/http.js";
import { BASE_SEPOLIA, SOLANA_DEVNET, USDC_BASE_SEPOLIA, USDC_SOLANA_DEVNET, mockFacilitator, testEnv } from "./helpers.js";

const walletFixture = {
  address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
  asOf: "2026-10-23T00:00:00.000Z",
  dataCluster: "mainnet" as const,
  window: { transactions: 1, from: null, to: null },
  summary: "Test wallet profile.",
  activity: { signatureCount: 1, swapCount: 4, uniqueTokensTraded: 3, lastActiveAt: null, medianSwapGapSeconds: null },
  holdings: [],
  omittedHoldings: 0,
  unpricedHoldings: 0,
  portfolioUsd: null,
  pnl: {
    method: "window_average_cost_current_prices" as const,
    priceBasis: "unavailable" as const,
    disclaimer: "test",
    realizedUsd: 1,
    unrealizedUsd: 0,
    closedTrades: 1,
    winningTrades: 1,
    winRate: 1,
    partialCostBasis: false,
    unpricedSells: 0,
  },
  labels: ["active memecoin trader"],
  labelDetails: [],
  sources: ["test"],
  warnings: [],
};

async function testApp() {
  const facilitator = mockFacilitator();
  const created = await createApp({
    env: testEnv(),
    facilitator,
    walletProfile: async () => walletFixture,
    trending: async () => ({
      asOf: "2026-10-23T00:00:00.000Z",
      dataCluster: "mainnet" as const,
      summary: "No trending Solana tokens were returned.",
      tokens: [],
      sources: ["test"],
      warnings: [],
    }),
    funding: async () => fundingFixture,
  });
  return { ...created, facilitator };
}

const fundingFixture = {
  address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
  asOf: "2026-10-23T00:00:00.000Z",
  dataCluster: "mainnet" as const,
  summary: "First SOL came from a personal funder.",
  funder: {
    address: "So11111111111111111111111111111111111111112",
    amountSol: 1,
    fundedAt: "2024-01-01T00:00:00.000Z",
    signature: "fund",
    exchange: null,
  },
  cexDeposit: null,
  cluster: {
    id: "funder:So11111111111111111111111111111111111111112",
    key: "funder" as const,
    funderId: "funder:So11111111111111111111111111111111111111112",
    cexDepositId: null,
    members: ["HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM"],
  },
  shared: { funder: [] as string[], cexDeposit: [] as string[] },
  risk: { level: "low" as const, reasons: ["First SOL came from a personal funder."] },
  peersChecked: 0,
  historyComplete: true,
  disclaimer: "This is a heuristic, not proof of common ownership. A shared personal funder or CEX deposit address is a risk signal. A shared exchange hot wallet is not.",
  sources: ["test"],
  warnings: [] as string[],
};

describe("x402 paywall", () => {
  it("returns 402 bodies with USDC base units and an input schema", async () => {
    const { app } = await testApp();
    const response = await app.request("http://127.0.0.1:4021/wallet/profile?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM");
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.x402Version).toBe(2);
    expect(body.inputSchema.properties.address.type).toBe("string");
    expect(body.inputSchema.required).toContain("address");
    expect(body.extensions.bazaar.info.input.queryParams.address).toBeTruthy();

    const amounts = body.accepts.map((accept: { amount: string; network: string; asset: string; payTo: string }) => accept);
    expect(amounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheme: "exact",
          network: SOLANA_DEVNET,
          amount: "10000",
          asset: USDC_SOLANA_DEVNET,
          payTo: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
        }),
        expect.objectContaining({
          scheme: "exact",
          network: BASE_SEPOLIA,
          amount: "10000",
          asset: USDC_BASE_SEPOLIA,
        }),
      ]),
    );
  });

  it("prices trending tokens at 5000 USDC base units", async () => {
    const { app } = await testApp();
    const response = await app.request("http://127.0.0.1:4021/token/trending");
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.accepts.every((accept: { amount: string }) => accept.amount === "5000")).toBe(true);
    expect(body.inputSchema.properties.limit.type).toBe("string");
  });

  it("serves OpenAPI payment metadata and the well-known catalog", async () => {
    const { app } = await testApp();
    const spec = await (await app.request("http://127.0.0.1:4021/openapi.json")).json();
    expect(spec.paths["/wallet/profile"].get["x-payment-info"]).toMatchObject({
      protocol: "x402",
      price: "$0.01",
      amount: "10000",
      currency: "USDC",
    });
    expect(spec.paths["/wallet/profile"].get.responses["402"]).toBeTruthy();
    expect(spec.paths["/token/trending"].get["x-payment-info"].amount).toBe("5000");
    expect(spec.paths["/wallet/funding"].get["x-payment-info"]).toMatchObject({
      protocol: "x402",
      price: "$0.02",
      amount: "20000",
      currency: "USDC",
    });
    expect(spec.paths["/wallet/funding"].get.responses["402"]).toBeTruthy();
    expect(spec.paths["/wallet/funding"].get.description).toMatch(/cluster/i);
    expect(spec.paths["/llms.txt"].get).toBeTruthy();
    const healthSchema = spec.paths["/health"].get.responses["200"].content["application/json"].schema;
    expect(healthSchema.properties.sla.properties.version.type).toBe("string");
    expect(healthSchema.properties.sla.properties.latency.properties.p50Ms).toBeTruthy();
    expect(healthSchema.properties.sla.properties.latency.properties.p95Ms).toBeTruthy();
    expect(healthSchema.properties.sla.properties.upstream.properties.status.enum).toEqual([
      "unknown",
      "ok",
      "rate_limited",
    ]);
    expect(healthSchema.properties.sla.properties.cache.properties.ageMs).toBeTruthy();
    expect(spec.info.description).toMatch(/holder concentration/i);
    expect(spec.info.description).toMatch(/\$0\.005/);
    expect(spec.paths["/token/trending"].get.description).toMatch(/top-10 share/i);
    expect(spec.paths["/token/trending"].get.responses["200"].content["application/json"].example.tokens[0].checks.lp.status).toBe(
      "burned",
    );

    const discovery = await (await app.request("http://127.0.0.1:4021/.well-known/x402")).json();
    expect(discovery.protocol).toBe("x402");
    expect(discovery.resources).toHaveLength(5);
    expect(discovery.resources[0].accepts[0].amount).toBe("10000");
    expect(discovery.resources.find((resource: { path: string }) => resource.path === "/token/trending").amount).toBe("5000");
    const funding = discovery.resources.find((resource: { path: string }) => resource.path === "/wallet/funding");
    expect(funding.price).toBe("$0.02");
    expect(funding.amount).toBe("20000");
    expect(funding.inputSchema.required).toContain("address");
    expect(funding.inputSchema.properties.peers.type).toBe("string");
    expect(funding.description).toMatch(/first SOL funder/i);
    expect(discovery.mcp.tools.map((tool: { name: string }) => tool.name)).toContain("wallet_funding");
    expect(discovery.facilitators.base.provider).toBe("public");
    expect(discovery.mcp.url).toBe("http://127.0.0.1:4021/mcp");
    expect(discovery.sla.version).toBe("1.0.0");
    expect(discovery.sla.latency.p50Ms).toEqual(expect.any(Number));
    expect(discovery.sla.latency.p95Ms).toEqual(expect.any(Number));
    expect(discovery.sla.upstream.status).toBe("unknown");
    expect(discovery.sla.cache.ageMs).toBeNull();
    expect(discovery.pricingNotes).toEqual([
      expect.objectContaining({
        path: "/token/trending",
        price: "$0.005",
        amount: "5000",
        checks: expect.arrayContaining([
          "top-10 holder share",
          "mint and freeze authority",
          "LP lock or burn status",
          "sniper and bundle share of early supply",
        ]),
      }),
    ]);
    expect(JSON.stringify(discovery.pricingNotes)).not.toContain("$0.002");
    expect(discovery.resources.find((resource: { path: string }) => resource.path === "/token/trending").amount).toBe(
      "5000",
    );

    const llms = await app.request("http://127.0.0.1:4021/llms.txt");
    expect(llms.status).toBe(200);
    expect(llms.headers.get("content-type")).toContain("text/plain");
    const llmsBody = await llms.text();
    expect(llmsBody).toContain("http://127.0.0.1:4021/wallet/funding");
    expect(llmsBody).toContain("$0.02");
    expect(llmsBody).toContain("wallet_funding");
    expect(llmsBody).toMatch(/p50/);
    expect(llmsBody).toMatch(/p95/);
    expect(llmsBody).toMatch(/rate-limit/i);
    expect(llmsBody).toMatch(/cache age/i);
    expect(llmsBody).toContain("$0.005");
    expect(llmsBody).toContain("top-10 share");
    expect(llmsBody).not.toMatch(/token\/trending\): \$0\.002/);
  });

  it("settles a signed-shaped payment and skips settlement on a bad address", async () => {
    const { app, facilitator } = await testApp();
    const unpaid = await app.request("http://127.0.0.1:4021/wallet/profile?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM");
    const required = await unpaid.json();
    const accepted = required.accepts.find((accept: { network: string }) => accept.network === SOLANA_DEVNET);
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: { transaction: "mock" },
      extensions: required.extensions,
    });

    const paid = await app.request("http://127.0.0.1:4021/wallet/profile?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM", {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(paid.status).toBe(200);
    const profile = await paid.json();
    expect(profile.labels).toContain("active memecoin trader");
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(facilitator.settleCalls[0].amount).toBe("10000");

    const rejected = await app.request("http://127.0.0.1:4021/wallet/profile?address=not-a-wallet", {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(rejected.status).toBe(400);
    const rejectedBody = await rejected.json();
    expect(rejectedBody).toMatchObject({ error: "invalid_address", retryable: false });
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("does not settle when wallet data fails and strips secrets from the error", async () => {
    const facilitator = mockFacilitator();
    const { app } = await createApp({
      env: testEnv(),
      facilitator,
      walletProfile: async () => {
        throw new UpstreamError(
          "helius request failed: https://api.helius.xyz/v0/addresses/abc/transactions?api-key=supersecret",
          "helius",
        );
      },
      trending: async () => ({
        asOf: "2026-10-23T00:00:00.000Z",
        dataCluster: "mainnet" as const,
        summary: "No trending Solana tokens were returned.",
        tokens: [],
        sources: ["test"],
        warnings: [],
      }),
    });
    const unpaid = await app.request("http://127.0.0.1:4021/wallet/profile?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM");
    const required = await unpaid.json();
    const accepted = required.accepts.find((accept: { network: string }) => accept.network === SOLANA_DEVNET);
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: { transaction: "mock" },
      extensions: required.extensions,
    });
    const failed = await app.request("http://127.0.0.1:4021/wallet/profile?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM&txLimit=20", {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(failed.status).toBe(502);
    const body = await failed.json();
    expect(body.retryable).toBe(true);
    expect(body.error).toBe("upstream_failed");
    expect(body.message).not.toContain("supersecret");
    expect(body.message).toContain("api-key=redacted");
    expect(facilitator.settleCalls).toHaveLength(0);

    const badLimit = await app.request("http://127.0.0.1:4021/wallet/profile?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM&txLimit=2", {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(badLimit.status).toBe(400);
    expect(await badLimit.json()).toMatchObject({ error: "invalid_tx_limit", retryable: false });
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("returns an x402 challenge from the paid MCP tool", async () => {
    const { app } = await testApp();
    const response = await app.request("http://127.0.0.1:4021/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "wallet_profile",
          arguments: { address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM" },
        },
      }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.isError).toBe(true);
    const payment = JSON.parse(payload.result.content[0].text);
    expect(payment.accepts.some((accept: { amount: string }) => accept.amount === "10000")).toBe(true);
    expect(payment.extensions.bazaar.info.input.toolName).toBe("wallet_profile");
  });

  it("leaves health unpaid", async () => {
    const { app } = await testApp();
    const response = await app.request("http://127.0.0.1:4021/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.accepts.map((accept: { chain: string }) => accept.chain)).toEqual(["solana", "base"]);
    expect(body.sla.version).toBe("1.0.0");
    expect(body.sla.windowMs).toBe(300_000);
    expect(body.sla.latency).toEqual({ p50Ms: null, p95Ms: null, samples: 0 });
    expect(body.sla.upstream.status).toBe("unknown");
    expect(body.sla.cache).toEqual({ ageMs: null, newestAgeMs: null, entries: 0, ttlMs: null });

    await app.request("http://127.0.0.1:4021/openapi.json");
    const after = await (await app.request("http://127.0.0.1:4021/health")).json();
    expect(after.sla.latency.samples).toBe(1);
    expect(after.sla.latency.p50Ms).toEqual(expect.any(Number));
    expect(after.sla.latency.p95Ms).toBe(after.sla.latency.p50Ms);
    expect(after.sla.latency.p50Ms).toBeGreaterThanOrEqual(0);
  });

  it("prices funding and cluster lookup at 20000 USDC base units", async () => {
    const { app, facilitator } = await testApp();
    const unpaid = await app.request(
      "http://127.0.0.1:4021/wallet/funding?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
    );
    expect(unpaid.status).toBe(402);
    const required = await unpaid.json();
    expect(required.accepts.every((accept: { amount: string }) => accept.amount === "20000")).toBe(true);
    expect(required.inputSchema.properties.address.type).toBe("string");
    expect(required.inputSchema.properties.peers.description).toMatch(/8/);
    const accepted = required.accepts.find((accept: { network: string }) => accept.network === SOLANA_DEVNET);
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: { transaction: "mock" },
      extensions: required.extensions,
    });
    const paid = await app.request(
      "http://127.0.0.1:4021/wallet/funding?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM&peers=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      { headers: { "PAYMENT-SIGNATURE": header } },
    );
    expect(paid.status).toBe(200);
    const body = await paid.json();
    expect(body.cluster.id).toContain("funder:");
    expect(body.summary).toMatch(/funder/i);
    expect(facilitator.settleCalls.at(-1)?.amount).toBe("20000");

    const badPeers = await app.request(
      "http://127.0.0.1:4021/wallet/funding?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM&peers=not-a-wallet",
      { headers: { "PAYMENT-SIGNATURE": header } },
    );
    expect(badPeers.status).toBe(400);
    expect(await badPeers.json()).toMatchObject({ error: "invalid_peers", retryable: false });
    expect(facilitator.settleCalls).toHaveLength(1);

    const profile = await app.request(
      "http://127.0.0.1:4021/wallet/profile?address=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
    );
    expect(profile.status).toBe(402);
    expect((await profile.json()).accepts[0].amount).toBe("10000");
  });

  it("describes wallet_funding on the paid MCP surface", async () => {
    const { app } = await testApp();
    const listed = await app.request("http://127.0.0.1:4021/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listed.status).toBe(200);
    const tools = (await listed.json()).result.tools as Array<{ name: string; description: string }>;
    const funding = tools.find((tool) => tool.name === "wallet_funding");
    expect(funding?.description).toMatch(/first SOL funder/i);
    expect(funding?.description).toContain("$0.02");
    expect(funding?.description).toMatch(/cluster/i);
    expect(tools.find((tool) => tool.name === "wallet_profile")?.description).toContain("$0.01");
    expect(tools.find((tool) => tool.name === "ping")?.description).toMatch(/free/i);

    const called = await app.request("http://127.0.0.1:4021/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "wallet_funding", arguments: { address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM" } },
      }),
    });
    const payload = await called.json();
    expect(payload.result.isError).toBe(true);
    const payment = JSON.parse(payload.result.content[0].text);
    expect(payment.accepts.every((accept: { amount: string }) => accept.amount === "20000")).toBe(true);
    expect(payment.extensions.bazaar.info.input.toolName).toBe("wallet_funding");
  });
});

describe("quick and preview routes", () => {
  it("prices /wallet/quick at $0.002 and serves /wallet/preview free", async () => {
    const { createApp } = await import("../src/app.js");
    const helpers = await import("./helpers.js");
    const h: any = helpers;
    const facilitator = h.mockFacilitator();
    const { app } = await createApp({
      ...(h.testEnv ? { env: h.testEnv() } : {}),
      ...(facilitator ? { facilitator } : {}),
      preview: async (_env: unknown, address: string) => ({ address, preview: true, solBalance: 1 }),
    } as never);
    const addr = "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM";
    const q = await app.request(`/wallet/quick?address=${addr}`);
    expect(q.status).toBe(402);
    const body = await q.json();
    expect(body.accepts[0].amount).toBe("2000");
    const p = await app.request(`/wallet/preview?address=${addr}`);
    expect(p.status).toBe(200);
    expect((await p.json()).preview).toBe(true);
    expect((await app.request(`/wallet/preview?address=bad`)).status).toBe(400);
  });
});
