import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { createPaymentWrapper } from "@x402/mcp";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { enabledAccepts, operationForPath, paidOperations, type PaidOperation } from "./catalog.js";
import { createCache } from "./cache.js";
import { loadEnv, type AppEnv, type ChainAccept } from "./config.js";
import { createFacilitator } from "./facilitator.js";
import { UpstreamError } from "./http.js";
import { buildOpenApi } from "./openapi.js";
import { isSolanaAddress } from "./solana.js";
import { buildWalletProfile, buildWalletPreview, type WalletProfile } from "./services/wallet.js";
import { loadTrending, type TrendingResponse } from "./services/trending.js";

type WalletLoader = (env: AppEnv, address: string, txLimit: number) => Promise<Omit<WalletProfile, "cached" | "stale">>;
type TrendingLoader = (env: AppEnv, limit: number) => Promise<Omit<TrendingResponse, "cached" | "stale">>;

export type CreateAppOptions = {
  env?: AppEnv;
  facilitator?: FacilitatorClient;
  walletProfile?: WalletLoader;
  trending?: TrendingLoader;
};

function originFrom(env: AppEnv, requestUrl: string): string {
  if (env.publicBaseUrl) return env.publicBaseUrl.replace(/\/$/, "");
  const url = new URL(requestUrl);
  return url.origin;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (parsed < min || parsed > max) return null;
  return parsed;
}

function discoveryDocument(env: AppEnv, operations: PaidOperation[], accepts: ChainAccept[], origin: string) {
  return {
    protocol: "x402",
    version: 2,
    service: "solana-wallet-x402",
    networkMode: env.networkMode,
    dataCluster: env.walletCluster,
    facilitators: {
      solana: {
        provider: "public",
        url: env.publicFacilitatorUrl,
        network: env.solana.network,
        asset: env.solana.asset,
        payTo: env.solana.payTo,
        bazaar: true,
      },
      base: env.base
        ? {
            provider: env.cdpApiKeyId ? "coinbase-cdp" : "public",
            url: env.cdpApiKeyId ? env.cdpFacilitatorUrl : env.publicFacilitatorUrl,
            network: env.base.network,
            asset: env.base.asset,
            payTo: env.base.payTo,
            bazaar: true,
            advertised: accepts.some((accept) => accept.chain === "base"),
          }
        : {
            advertised: false,
            reason: "Set EVM_PAY_TO to accept USDC on Base. Base settles through the public PayAI facilitator; no Coinbase CDP keys are needed.",
          },
    },
    resources: operations.map((operation) => ({
      method: operation.method,
      path: operation.path,
      url: `${origin}${operation.path}`,
      description: operation.description,
      mimeType: "application/json",
      protocol: "x402",
      scheme: "exact",
      price: operation.price,
      amount: operation.amount,
      currency: "USDC",
      decimals: 6,
      inputSchema: operation.inputSchema,
      example: operation.example,
      accepts: accepts.map((accept) => ({
        scheme: "exact",
        network: accept.network,
        amount: operation.amount,
        asset: accept.asset,
        payTo: accept.payTo,
        decimals: 6,
      })),
    })),
    mcp: {
      transport: "streamable-http",
      url: `${origin}/mcp`,
      tools: operations.map((operation) => ({
        name: operation.mcpTool,
        description: operation.description,
        price: operation.price,
        amount: operation.amount,
        inputSchema: operation.inputSchema,
      })),
    },
    openapi: `${origin}/openapi.json`,
  };
}

export async function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? loadEnv();
  const facilitator = options.facilitator ?? createFacilitator(env);
  const operations = paidOperations(env);
  const resourceServer = new x402ResourceServer(facilitator).register(
    env.solana.network as Network,
    new ExactSvmScheme({ rpcUrl: env.solanaRpcUrl }),
  );
  if (env.base) resourceServer.register(env.base.network as Network, new ExactEvmScheme());
  resourceServer.registerExtension(bazaarResourceServerExtension);

  let supported = new Set<string>([env.solana.network, ...(env.base ? [env.base.network] : [])]);
  try {
    const reported = await facilitator.getSupported();
    const exact = reported.kinds
      .filter((kind) => kind.x402Version === 2 && kind.scheme === "exact")
      .map((kind) => kind.network);
    if (exact.length > 0) supported = new Set(exact);
  } catch (error) {
    console.warn(`Facilitator /supported failed at startup: ${error instanceof Error ? error.message : error}`);
  }

  const accepts = enabledAccepts(env, supported);
  const activeAccepts = accepts.length > 0 ? accepts : [env.solana];
  const cache = createCache();
  const loadWallet = options.walletProfile ?? buildWalletProfile;
  const loadTrendingTokens = options.trending ?? loadTrending;

  const routes: Record<string, {
    accepts: Array<{ scheme: "exact"; price: string; network: string; payTo: string; maxTimeoutSeconds: number }>;
    description: string;
    mimeType: string;
    serviceName: string;
    tags: string[];
    extensions: ReturnType<typeof declareDiscoveryExtension>;
  }> = {};

  for (const operation of operations) {
    routes[`${operation.method} ${operation.path}`] = {
      accepts: activeAccepts.map((accept) => ({
        scheme: "exact" as const,
        price: operation.price,
        network: accept.network,
        payTo: accept.payTo,
        maxTimeoutSeconds: 60,
      })),
      description: operation.description,
      mimeType: "application/json",
      serviceName: "solana-wallet-x402",
      tags: ["solana", "wallet", "x402"],
      extensions: declareDiscoveryExtension({
        input: operation.example,
        inputSchema: {
          properties: operation.inputSchema.properties,
          required: operation.inputSchema.required,
        },
        output: { example: operation.outputExample },
      }),
    };
  }

  const app = new Hono();
  app.use("*", cors());
  app.use("*", async (c, next) => {
    await next();
    if (c.res.status !== 402) return;
    const encoded = c.res.headers.get("PAYMENT-REQUIRED");
    if (!encoded) return;
    if ((c.res.headers.get("content-type") ?? "").includes("text/html")) return;
    let paymentRequired: { extensions?: Record<string, unknown> };
    try {
      paymentRequired = decodePaymentRequiredHeader(encoded);
    } catch {
      return;
    }
    const operation = operationForPath(new URL(c.req.url).pathname, env);
    const bazaar = paymentRequired.extensions?.bazaar as { schema?: { properties?: { input?: { properties?: { queryParams?: unknown } } } } } | undefined;
    const inputSchema = operation?.inputSchema ?? bazaar?.schema?.properties?.input?.properties?.queryParams ?? { type: "object" };
    const headers = new Headers(c.res.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    c.res = new Response(JSON.stringify({ ...paymentRequired, inputSchema }), { status: 402, headers });
  });

  // Reject malformed input before asking for payment, so buyers never pay for a 400.
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/wallet/profile" || path === "/wallet/quick") {
      const a = c.req.query("address");
      if (a !== undefined && !isSolanaAddress(a)) return c.json({ error: "invalid_address", message: "Query address must be a Solana base58 public key. You were not charged." }, 400);
    }
    if (path === "/wallet/quick/batch") {
      const raw = c.req.query("addresses");
      if (raw !== undefined) {
        const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
        if (list.length < 1 || list.length > 10 || !list.every(isSolanaAddress)) return c.json({ error: "invalid_addresses", message: "addresses must be 1 to 10 comma-separated base58 Solana addresses. You were not charged." }, 400);
      }
    }
    await next();
  });

  app.use("*", paymentMiddleware(routes as never, resourceServer));

  app.get("/", (c) => {
    const origin = originFrom(env, c.req.url);
    return c.json({
      service: "solana-wallet-x402",
      description: "Pay-per-call Solana wallet intel for agents. $0.002 USDC gets a quick screen (realized PnL, win rate, bot and smart-money flags; batch 10 for $0.015). Free /wallet/preview. $0.01 USDC gets a wallet's priced holdings, realized/unrealized PnL, win rate, trading cadence and labels (smart-money candidate, bot-like cadence, memecoin trader). $0.005 gets trending Solana tokens with liquidity, volume, age and rug-risk flags. No signup, no API key: x402 v2 on Solana mainnet.",
      pricing: { "/wallet/quick": "$0.002", "/wallet/quick/batch": "$0.015 (up to 10 wallets)", "/wallet/profile": "$0.01", "/token/trending": "$0.005", "/wallet/preview": "free" },
      quickstart: "npm i @x402/fetch @x402/svm @solana/kit; const f = wrapFetchWithPayment(fetch, client); await (await f(`${origin}/wallet/profile?address=<wallet>`)).json()",
      networkMode: env.networkMode,
      payTo: { solana: env.solanaPayTo, base: env.evmPayTo ?? null },
      endpoints: {
        health: `${origin}/health`,
        openapi: `${origin}/openapi.json`,
        discovery: `${origin}/.well-known/x402`,
        mcp: `${origin}/mcp`,
        walletPreview: `${origin}/wallet/preview?address=<base58>  (free: SOL balance + last active)`,
        walletQuick: `${origin}/wallet/quick?address=<base58>`,
        walletQuickBatch: `${origin}/wallet/quick/batch?addresses=<a>,<b>,...`,
        walletProfile: `${origin}/wallet/profile`,
        trending: `${origin}/token/trending`,
      },
    });
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "solana-wallet-x402",
      networkMode: env.networkMode,
      dataCluster: env.walletCluster,
      accepts: activeAccepts.map((accept) => ({
        chain: accept.chain,
        network: accept.network,
        facilitator: accept.facilitator,
      })),
    }),
  );

  app.get("/openapi.json", (c) => c.json(buildOpenApi(env, operations, activeAccepts, originFrom(env, c.req.url))));
  app.get("/.well-known/x402", (c) => c.json(discoveryDocument(env, operations, activeAccepts, originFrom(env, c.req.url))));

  function quickOf(p: any) {
    const labels: string[] = p.labels ?? [];
    return {
      address: p.address,
      realizedUsd: p.pnl?.realizedUsd ?? null,
      winRate: p.pnl?.winRate ?? null,
      closedTrades: p.pnl?.closedTrades ?? 0,
      swapsPerDay: p.trading?.swapsPerDay ?? null,
      txsPerDay: p.trading?.txsPerDay ?? null,
      exchangeLike: labels.includes("exchange or custodial wallet"),
      bot: labels.includes("bot-like cadence"),
      smartMoney: labels.includes("smart-money candidate"),
      netWinner: labels.includes("net winner"),
      dormant: labels.includes("dormant"),
      portfolioUsd: p.portfolioUsd ?? null,
      lastActiveAt: p.activity?.lastActiveAt ?? null,
      windowTransactions: p.window?.transactions ?? null,
    };
  }
  const profile50 = (address: string) =>
    cache.getOrSet(`wallet:${env.walletCluster}:${address}:50`, 60_000, () => loadWallet(env, address, 50));
  async function quickBatch(raw: string) {
    const list = [...new Set(raw.split(",").map((a) => a.trim()).filter(Boolean))];
    if (list.length === 0 || list.length > 10 || !list.every(isSolanaAddress)) return null;
    const wallets: ReturnType<typeof quickOf>[] = [];
    const errors: Array<{ address: string; error: string }> = [];
    await Promise.all(list.map(async (a) => {
      try { wallets.push(quickOf((await profile50(a)).value)); }
      catch (e) { errors.push({ address: a, error: e instanceof Error ? e.message : "lookup failed" }); }
    }));
    wallets.sort((x, y) => (y.realizedUsd ?? -1e12) - (x.realizedUsd ?? -1e12));
    return { asOf: new Date().toISOString(), wallets, errors };
  }

  app.get("/wallet/quick", async (c) => {
    const address = c.req.query("address")?.trim() ?? "";
    if (!isSolanaAddress(address)) return c.json({ error: "invalid_address", message: "Query address must be a Solana base58 public key." }, 400);
    try { return c.json(quickOf((await profile50(address)).value)); }
    catch (error) { return c.json({ error: "upstream_failed", message: error instanceof Error ? error.message : "lookup failed" }, 502); }
  });

  app.get("/wallet/quick/batch", async (c) => {
    const out = await quickBatch(c.req.query("addresses") ?? "");
    if (!out) return c.json({ error: "invalid_addresses", message: "addresses must be 1 to 10 comma-separated base58 Solana addresses." }, 400);
    return c.json(out);
  });

  app.get("/wallet/preview", async (c) => {
    const address = c.req.query("address")?.trim() ?? "";
    if (!isSolanaAddress(address)) {
      return c.json({ error: "invalid_address", message: "Query address must be a Solana base58 public key." }, 400);
    }
    try {
      const hit = await cache.getOrSet(`preview:${address}`, 30_000, () => buildWalletPreview(env, address));
      return c.json(hit.value);
    } catch (error) {
      return c.json({ error: "upstream_failed", message: error instanceof Error ? error.message : "lookup failed" }, 502);
    }
  });

  app.get("/wallet/profile", async (c) => {
    const address = c.req.query("address")?.trim() ?? "";
    if (!isSolanaAddress(address)) {
      return c.json({ error: "invalid_address", message: "Query address must be a Solana base58 public key." }, 400);
    }
    const txLimit = clampInt(c.req.query("txLimit"), 100, 5, 300);
    if (txLimit === null) return c.json({ error: "invalid_tx_limit", message: "txLimit must be an integer from 5 to 300." }, 400);
    try {
      const hit = await cache.getOrSet(`wallet:${env.walletCluster}:${address}:${txLimit}`, 60_000, () =>
        loadWallet(env, address, txLimit),
      );
      return c.json({ ...hit.value, cached: hit.cached, stale: hit.stale });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet lookup failed";
      const status = error instanceof UpstreamError ? 502 : 500;
      return c.json({ error: "upstream_failed", message }, status);
    }
  });

  app.get("/token/trending", async (c) => {
    const limit = clampInt(c.req.query("limit"), 15, 1, 25);
    if (limit === null) return c.json({ error: "invalid_limit", message: "limit must be an integer from 1 to 25." }, 400);
    try {
      const hit = await cache.getOrSet(`trending:${limit}:${Boolean(env.birdeyeApiKey)}`, 60_000, () =>
        loadTrendingTokens(env, limit),
      );
      return c.json({ ...hit.value, cached: hit.cached, stale: hit.stale });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Trending lookup failed";
      const status = error instanceof UpstreamError ? 502 : 500;
      return c.json({ error: "upstream_failed", message }, status);
    }
  });

  const wrappers = new Map<string, ReturnType<typeof createPaymentWrapper>>();
  async function wrapperFor(operation: PaidOperation) {
    const existing = wrappers.get(operation.id);
    if (existing) return existing;
    await resourceServer.initialize();
    const requirements: PaymentRequirements[] = [];
    for (const accept of activeAccepts) {
      const built = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        network: accept.network as Network,
        payTo: accept.payTo,
        price: operation.price,
        maxTimeoutSeconds: 60,
      });
      requirements.push(...built);
    }
    const paid = createPaymentWrapper(resourceServer, {
      accepts: requirements,
      resource: {
        url: `mcp://tool/${operation.mcpTool}`,
        description: operation.description,
        mimeType: "application/json",
        serviceName: "solana-wallet-x402",
      },
      extensions: declareDiscoveryExtension({
        toolName: operation.mcpTool,
        description: operation.description,
        transport: "streamable-http",
        inputSchema: operation.inputSchema,
        output: { example: operation.outputExample },
      }),
    });
    wrappers.set(operation.id, paid);
    return paid;
  }

  app.all("/mcp", async (c) => {
    const mcp = new McpServer({ name: "solana-wallet-x402", version: "1.0.0" });
    mcp.tool("ping", "Free health check. Does not spend USDC.", {}, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));

    const walletPaid = await wrapperFor(operations[0]).catch(() => null);
    const walletHandler = walletPaid
      ? walletPaid(async ({ address }: { address: string }) => {
          if (!isSolanaAddress(address)) {
            return { isError: true, content: [{ type: "text" as const, text: "Query address must be a Solana base58 public key." }] };
          }
          const hit = await cache.getOrSet(`wallet:${env.walletCluster}:${address}:50`, 60_000, () => loadWallet(env, address, 50));
          return { content: [{ type: "text" as const, text: JSON.stringify({ ...hit.value, cached: hit.cached, stale: hit.stale }) }] };
        })
      : async () => ({
          isError: true,
          content: [{ type: "text" as const, text: "Payment facilitator is unavailable, so this tool is not priced yet." }],
        });
    mcp.tool(
      "wallet_profile",
      `${operations[0].description} Costs ${operations[0].price} USDC.`,
      { address: z.string().describe("Solana wallet address (base58)") },
      walletHandler,
    );

    const trendingPaid = await wrapperFor(operations[1]).catch(() => null);
    const trendingHandler = trendingPaid
      ? trendingPaid(async ({ limit }: { limit?: string }) => {
          const parsed = clampInt(limit, 15, 1, 25);
          if (parsed === null) {
            return { isError: true, content: [{ type: "text" as const, text: "limit must be an integer from 1 to 25." }] };
          }
          const hit = await cache.getOrSet(`trending:${parsed}:${Boolean(env.birdeyeApiKey)}`, 60_000, () =>
            loadTrendingTokens(env, parsed),
          );
          return { content: [{ type: "text" as const, text: JSON.stringify({ ...hit.value, cached: hit.cached, stale: hit.stale }) }] };
        })
      : async () => ({
          isError: true,
          content: [{ type: "text" as const, text: "Payment facilitator is unavailable, so this tool is not priced yet." }],
        });
    mcp.tool(
      "token_trending",
      `${operations[1].description} Costs ${operations[1].price} USDC.`,
      { limit: z.string().optional().describe("1 to 25, default 15") },
      trendingHandler,
    );

    const quickPaid = await wrapperFor(operations[2]).catch(() => null);
    mcp.tool(
      "wallet_quick",
      `${operations[2].description} Costs ${operations[2].price} USDC.`,
      { address: z.string().describe("Solana wallet address (base58)") },
      quickPaid
        ? quickPaid(async ({ address }: { address: string }) => {
            if (!isSolanaAddress(address)) return { isError: true, content: [{ type: "text" as const, text: "Invalid Solana address." }] };
            return { content: [{ type: "text" as const, text: JSON.stringify(quickOf((await profile50(address)).value)) }] };
          })
        : async () => ({ isError: true, content: [{ type: "text" as const, text: "Payment facilitator is unavailable." }] }),
    );
    const batchPaid = await wrapperFor(operations[3]).catch(() => null);
    mcp.tool(
      "wallet_quick_batch",
      `${operations[3].description} Costs ${operations[3].price} USDC.`,
      { addresses: z.string().describe("Up to 10 comma-separated Solana addresses") },
      batchPaid
        ? batchPaid(async ({ addresses }: { addresses: string }) => {
            const out = await quickBatch(addresses);
            if (!out) return { isError: true, content: [{ type: "text" as const, text: "addresses must be 1 to 10 valid Solana addresses." }] };
            return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
          })
        : async () => ({ isError: true, content: [{ type: "text" as const, text: "Payment facilitator is unavailable." }] }),
    );

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return { app, env, accepts: activeAccepts, operations };
}
