import { decodePaymentRequiredHeader } from "@x402/core/http";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { paidOperations } from "../src/catalog.js";
import { createApp } from "../src/app.js";
import { SOLANA_DEVNET, mockFacilitator, testEnv } from "./helpers.js";

const PAID_AMOUNTS: Record<string, string> = {
  "/wallet/profile": "10000",
  "/wallet/funding": "20000",
  "/wallet/quick": "2000",
  "/wallet/quick/batch": "15000",
  "/token/trending": "5000",
};

/** Same Accept header @agentcash/discovery sends on an unpaid probe. */
const PROBE_ACCEPT = "application/json, text/plain;q=0.9, */*;q=0.8";

async function probedApp() {
  const facilitator = mockFacilitator();
  const created = await createApp({
    env: testEnv(),
    facilitator,
    walletProfile: async () => {
      throw new Error("probe must not run the paid handler");
    },
    trending: async () => {
      throw new Error("probe must not run the paid handler");
    },
    funding: async () => {
      throw new Error("probe must not run the paid handler");
    },
  });
  return { ...created, facilitator };
}

function probe(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  path: string,
  accept = PROBE_ACCEPT,
) {
  return app.request(`http://127.0.0.1:4021${path}`, { headers: { accept } });
}

describe("x402scan unpaid probe", () => {
  it.each([
    ["/wallet/profile", ""],
    ["/wallet/profile", "?address="],
    ["/wallet/profile", "?address=not-a-wallet"],
    ["/wallet/funding", ""],
    ["/wallet/funding", "?address=bad&peers=nope"],
    ["/wallet/quick", ""],
    ["/wallet/quick", "?address=bad"],
    ["/wallet/quick/batch", ""],
    ["/wallet/quick/batch", "?addresses=bad"],
    ["/wallet/quick/batch", "?addresses="],
    ["/token/trending", ""],
    ["/token/trending", "?limit=nope"],
  ])("GET %s%s returns a spec-valid 402 with no payment header", async (path, query) => {
    const { app } = await probedApp();
    const response = await probe(app, `${path}${query}`);
    expect(response.status).toBe(402);
    const encoded = response.headers.get("payment-required");
    expect(encoded).toBeTruthy();
    const challenge = decodePaymentRequiredHeader(encoded!);
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts.length).toBeGreaterThan(0);
    for (const accept of challenge.accepts) {
      expect(accept.scheme).toBe("exact");
      expect(accept.amount).toBe(PAID_AMOUNTS[path]);
      expect(accept.amount).toMatch(/^\d+$/);
      expect(accept.payTo.length).toBeGreaterThan(0);
      expect(accept.asset.length).toBeGreaterThan(0);
      expect(accept.maxTimeoutSeconds).toBeGreaterThan(0);
    }
    expect(challenge.accepts.some((accept: { network: string }) => accept.network === SOLANA_DEVNET)).toBe(true);
    const bazaar = challenge.extensions?.bazaar as { info?: { input?: { method?: string; queryParams?: object } }; schema?: unknown };
    expect(bazaar?.info?.input?.method).toBe("GET");
    expect(bazaar?.info?.input?.queryParams).toBeTruthy();
    expect(validateDiscoveryExtension(bazaar as never).valid).toBe(true);
    const body = await response.json();
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0].amount).toBe(PAID_AMOUNTS[path]);
    expect(body.inputSchema).toBeTruthy();
  });

  it("accepts the direct JSON probe x402scan uses when headers are large", async () => {
    const { app } = await probedApp();
    const response = await probe(app, "/wallet/quick", "application/json");
    expect(response.status).toBe(402);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.accepts[0].amount).toBe("2000");
  });

  it("does not settle a paid call whose input is missing or invalid", async () => {
    const { app, facilitator } = await probedApp();
    const unpaid = await probe(app, "/wallet/profile");
    const required = await unpaid.json();
    const accepted = required.accepts.find((accept: { network: string }) => accept.network === SOLANA_DEVNET);
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: { transaction: "mock" },
      extensions: required.extensions,
    });
    const cases = [
      "/wallet/profile",
      "/wallet/profile?address=not-a-wallet",
      "/wallet/quick?address=",
      "/wallet/funding?address=bad",
      "/wallet/quick/batch",
      "/wallet/quick/batch?addresses=bad",
    ];
    for (const path of cases) {
      const rejected = await app.request(`http://127.0.0.1:4021${path}`, {
        headers: { "PAYMENT-SIGNATURE": header, accept: PROBE_ACCEPT },
      });
      expect(rejected.status, path).toBe(400);
      const body = await rejected.json();
      expect(body.retryable).toBe(false);
      expect(body.message).toMatch(/not charged/i);
    }
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it("lists only paid resources on /.well-known/x402", async () => {
    const { app } = await probedApp();
    const discovery = await (await app.request("http://127.0.0.1:4021/.well-known/x402")).json();
    const paths = discovery.resources.map((resource: { path: string }) => resource.path);
    expect([...paths].sort()).toEqual(Object.keys(PAID_AMOUNTS).sort());
    expect(paths).toEqual(paidOperations(testEnv()).map((operation) => operation.path));
    for (const resource of discovery.resources) {
      expect(resource.amount).toBe(PAID_AMOUNTS[resource.path]);
      expect(resource.url).toBe(`http://127.0.0.1:4021${resource.path}`);
    }
    const freePaths = ["/wallet/preview", "/health", "/favicon.ico", "/llms.txt", "/openapi.json", "/mcp"];
    expect(paths.some((path: string) => freePaths.includes(path))).toBe(false);
  });

  it("publishes the contact email and marks free OpenAPI routes as unprotected", async () => {
    const { app } = await probedApp();
    const spec = await (await app.request("http://127.0.0.1:4021/openapi.json")).json();
    expect(spec.info.contact.email).toBe("falconsol@mail.grokbot.com");
    for (const path of Object.keys(PAID_AMOUNTS)) {
      const operation = spec.paths[path].get;
      expect(operation["x-payment-info"].price).toBe(
        path === "/wallet/profile"
          ? "$0.01"
          : path === "/wallet/funding"
            ? "$0.02"
            : path === "/wallet/quick"
              ? "$0.002"
              : path === "/wallet/quick/batch"
                ? "$0.015"
                : "$0.005",
      );
      expect(operation["x-payment-info"].amount).toBe(PAID_AMOUNTS[path]);
      expect(operation["x-payment-info"].protocols).toEqual([{ x402: {} }]);
      expect(operation.responses["402"]).toBeTruthy();
      expect(operation.security).toBeUndefined();
    }
    for (const path of ["/wallet/preview", "/health", "/.well-known/x402", "/llms.txt"]) {
      expect(spec.paths[path].get.security).toEqual([]);
      expect(spec.paths[path].get["x-payment-info"]).toBeUndefined();
    }
  });

  it("serves /favicon.ico without a paywall", async () => {
    const { app } = await probedApp();
    const response = await app.request("http://127.0.0.1:4021/favicon.ico");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/x-icon");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes[0]).toBe(0);
    expect(bytes[1]).toBe(0);
    expect(bytes[2]).toBe(1);
    expect(bytes[3]).toBe(0);
    expect(bytes.length).toBeGreaterThan(22);
  });
});
