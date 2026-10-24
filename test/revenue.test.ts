import { readFileSync } from "node:fs";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  hashPayer,
  isoWeekKey,
  noteSettlement,
  recordRevenue,
  resetRevenueLedger,
  revenueSummary,
  routeFromResource,
} from "../src/revenue.js";
import { SOLANA_DEVNET, mockFacilitator, testEnv } from "./helpers.js";

const PAYER = "SecretPayer111111111111111111111111111111";
const ADDRESS = "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM";

afterEach(() => {
  resetRevenueLedger();
  delete process.env.SWI_INTERNAL_KEY;
  vi.restoreAllMocks();
});

describe("revenue ledger", () => {
  it("groups settled payments by UTC day and ISO week without the payer address", () => {
    expect(isoWeekKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-W01");
    expect(isoWeekKey(new Date("2025-12-28T12:00:00.000Z"))).toBe("2025-W52");
    expect(isoWeekKey(new Date("2026-10-18T00:00:00.000Z"))).not.toBe(
      isoWeekKey(new Date("2026-10-19T00:00:00.000Z")),
    );

    const hash = hashPayer(PAYER);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(PAYER);
    expect(hashPayer("0xABC")).toBe(hashPayer("0xabc"));

    recordRevenue({
      route: "/wallet/profile",
      amountBaseUnits: "9000",
      network: SOLANA_DEVNET,
      at: "2026-10-19T01:00:00.000Z",
      payerHash: hash,
    });
    recordRevenue({
      route: "/wallet/profile",
      amountBaseUnits: "9000",
      network: "eip155:8453",
      at: "2026-10-24T01:00:00.000Z",
      payerHash: hash,
    });
    recordRevenue({
      route: "/wallet/quick",
      amountBaseUnits: "2000",
      network: SOLANA_DEVNET,
      at: "2026-10-24T02:00:00.000Z",
      payerHash: null,
    });
    recordRevenue({
      route: "/token/trending",
      amountBaseUnits: "1800",
      network: SOLANA_DEVNET,
      at: "2026-10-18T02:00:00.000Z",
      payerHash: hashPayer("other-payer"),
    });

    const summary = revenueSummary(new Date("2026-10-24T12:00:00.000Z"));
    expect(summary.currency).toBe("USDC");
    expect(summary.payments).toBe(4);
    expect(summary.amountBaseUnits).toBe("21800");
    expect(summary.amountUsd).toBe(0.0218);
    expect(summary.uniquePayers).toBe(2);
    expect(JSON.stringify(summary)).not.toContain(PAYER);
    expect(summary.daily).toEqual([
      expect.objectContaining({ day: "2026-10-18", route: "/token/trending", payments: 1, amountUsd: 0.0018 }),
      expect.objectContaining({ day: "2026-10-19", route: "/wallet/profile", payments: 1, amountUsd: 0.009, uniquePayers: 1 }),
      expect.objectContaining({ day: "2026-10-24", route: "/wallet/profile", payments: 1, amountUsd: 0.009, uniquePayers: 1 }),
      expect.objectContaining({
        day: "2026-10-24",
        route: "/wallet/quick",
        payments: 1,
        amountBaseUnits: "2000",
        amountUsd: 0.002,
        uniquePayers: 0,
      }),
    ]);
    const profileWeek = summary.weekly.find((row) => row.route === "/wallet/profile");
    expect(profileWeek).toMatchObject({
      week: isoWeekKey(new Date("2026-10-19T00:00:00.000Z")),
      payments: 2,
      amountBaseUnits: "18000",
      amountUsd: 0.018,
      uniquePayers: 1,
    });
    expect(summary.weekly.some((row) => row.week === isoWeekKey(new Date("2026-10-18T00:00:00.000Z")))).toBe(true);
  });

  it("logs the route, amount, network, and address hash, and skips failed settlements", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    noteSettlement({
      success: false,
      payer: PAYER,
      amount: "9000",
      network: SOLANA_DEVNET,
      resourceUrl: `https://example.test/wallet/profile?address=${PAYER}`,
    });
    expect(revenueSummary().payments).toBe(0);
    expect(spy).not.toHaveBeenCalled();

    noteSettlement({
      success: true,
      payer: PAYER,
      amount: "9000",
      network: SOLANA_DEVNET,
      resourceUrl: `https://example.test/wallet/profile?address=${PAYER}`,
    });
    const logged = spy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("/wallet/profile");
    expect(logged).toContain("9000");
    expect(logged).toContain(SOLANA_DEVNET);
    expect(logged).toContain(hashPayer(PAYER));
    expect(logged).not.toContain(PAYER);
    expect(routeFromResource("mcp://tool/wallet_quick_batch")).toBe("/wallet/quick/batch");
    expect(routeFromResource("mcp://tool/token_trending")).toBe("/token/trending");
    const summary = revenueSummary();
    expect(summary.daily[0]?.route).toBe("/wallet/profile");
    expect(summary.amountUsd).toBe(0.009);
    expect(JSON.stringify(summary)).not.toContain(PAYER);
  });

  it("drops entries outside the 90-day window", () => {
    recordRevenue({
      route: "/wallet/funding",
      amountBaseUnits: "9000",
      network: SOLANA_DEVNET,
      at: "2026-01-01T00:00:00.000Z",
      payerHash: hashPayer(PAYER),
    });
    const summary = revenueSummary(new Date("2026-10-24T00:00:00.000Z"));
    expect(summary.payments).toBe(0);
    expect(summary.daily).toEqual([]);
    expect(summary.weekly).toEqual([]);
  });
});

describe("published prices", () => {
  it("matches glama.json to the live USDC prices", () => {
    const description = JSON.parse(readFileSync(new URL("../glama.json", import.meta.url), "utf8")).description as string;
    expect(description).toContain("wallet_profile ($0.009");
    expect(description).toContain("wallet_funding ($0.009");
    expect(description).toContain("token_trending ($0.0018");
    expect(description).toContain("wallet_quick ($0.002");
    expect(description).toContain("wallet_quick_batch ($0.015");
    expect(description).not.toContain("$0.02");
    expect(description).not.toContain("$0.005");
    expect(description).not.toContain("($0.01 ");
  });
});

describe("GET /internal/revenue", () => {
  it("requires SWI_INTERNAL_KEY and totals settled routes", async () => {
    const facilitator = mockFacilitator();
    const { app } = await createApp({
      env: testEnv(),
      facilitator,
      walletProfile: async () =>
        ({
          address: ADDRESS,
          asOf: "2026-10-24T00:00:00.000Z",
          labels: [],
          summary: "s",
          pnl: { realizedUsd: 1, winRate: 1, closedTrades: 1 },
          copyTradeScore: 0.5,
          copyTradeGrade: "C",
        }) as never,
    });

    expect((await app.request("http://127.0.0.1:4021/internal/revenue")).status).toBe(503);
    process.env.SWI_INTERNAL_KEY = "placeholder-key";
    expect((await app.request("http://127.0.0.1:4021/internal/revenue", {
      headers: { "x-swi-internal-key": "placeholder-key" },
    })).status).toBe(503);
    process.env.SWI_INTERNAL_KEY = "revenue-key";
    const denied = await app.request("http://127.0.0.1:4021/internal/revenue", {
      headers: { "x-swi-internal-key": "nope" },
    });
    expect(denied.status).toBe(401);

    const unpaid = await app.request(`http://127.0.0.1:4021/wallet/profile?address=${ADDRESS}`);
    const required = await unpaid.json();
    const accepted = required.accepts.find((item: { network: string }) => item.network === SOLANA_DEVNET);
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: { transaction: "mock" },
      extensions: required.extensions,
    });
    const paid = await app.request(`http://127.0.0.1:4021/wallet/profile?address=${ADDRESS}`, {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(paid.status).toBe(200);
    expect(facilitator.settleCalls).toHaveLength(1);

    const quickUnpaid = await app.request(`http://127.0.0.1:4021/wallet/quick?address=${ADDRESS}`);
    const quickRequired = await quickUnpaid.json();
    const quickAccepted = quickRequired.accepts.find((item: { network: string }) => item.network === SOLANA_DEVNET);
    const quickHeader = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: quickRequired.resource,
      accepted: quickAccepted,
      payload: { transaction: "mock" },
      extensions: quickRequired.extensions,
    });
    const quick = await app.request(`http://127.0.0.1:4021/wallet/quick?address=${ADDRESS}`, {
      headers: { "PAYMENT-SIGNATURE": quickHeader },
    });
    expect(quick.status).toBe(200);

    const summaryResponse = await app.request("http://127.0.0.1:4021/internal/revenue", {
      headers: { "x-swi-internal-key": "revenue-key" },
    });
    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.headers.get("cache-control")).toContain("no-store");
    const body = await summaryResponse.json();
    expect(body.payments).toBe(2);
    expect(body.amountUsd).toBe(0.011);
    expect(body.amountBaseUnits).toBe("11000");
    const routes = body.daily.map((row: { route: string; amountBaseUnits: string }) => [row.route, row.amountBaseUnits]);
    expect(routes).toEqual(expect.arrayContaining([
      ["/wallet/profile", "9000"],
      ["/wallet/quick", "2000"],
    ]));
    expect(body.weekly).toHaveLength(2);
    const text = JSON.stringify(body);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain("payer");
  });
});
