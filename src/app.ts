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
import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { enabledAccepts, operationForPath, paidOperations, type PaidOperation } from "./catalog.js";
import { createCache } from "./cache.js";
import { loadEnv, type AppEnv, type ChainAccept } from "./config.js";
import { createFacilitator } from "./facilitator.js";
import { parsePeerList } from "./funding.js";
import { redactSecrets, UpstreamError } from "./http.js";
import { buildLlmsTxt, trendingPricingNote } from "./llms.js";
import { createSlaTracker, runWithSla, type SlaSnapshot } from "./sla.js";
import { buildOpenApi } from "./openapi.js";
import { faviconIco } from "./favicon.js";
import { isSolanaAddress } from "./solana.js";
import { loadWalletFunding, type WalletFunding } from "./services/funding.js";
import { buildWalletProfile, type WalletProfile } from "./services/wallet.js";
import { buildWalletPreview } from "./services/preview.js";
import { loadTrending, type TrendingResponse } from "./services/trending.js";

type WalletLoader = (env: AppEnv, address: string, txLimit: number) => Promise<Omit<WalletProfile, "cached" | "stale">>;
type TrendingLoader = (env: AppEnv, limit: number) => Promise<Omit<TrendingResponse, "cached" | "stale">>;
type PreviewLoader = (env: AppEnv, address: string) => Promise<unknown>;
type FundingLoader = (env: AppEnv, address: string, peers: string[]) => Promise<Omit<WalletFunding, "cached" | "stale">>;

export type CreateAppOptions = {
  env?: AppEnv;
  facilitator?: FacilitatorClient;
  walletProfile?: WalletLoader;
  trending?: TrendingLoader;
  funding?: FundingLoader;
  preview?: PreviewLoader;
};

function originFrom(env: AppEnv, requestUrl: string): string {
  if (env.publicBaseUrl) return env.publicBaseUrl.replace(/\/$/, "");
  const url = new URL(requestUrl);
  return url.origin;
}

function publicFailure(error: unknown, fallback: string): { status: 502 | 500; body: { error: string; message: string; retryable: boolean } } {
  const raw = error instanceof Error ? error.message : "";
  if (raw) console.error(redactSecrets(raw));
  if (error instanceof UpstreamError) {
    return { status: 502, body: { error: "upstream_failed", message: redactSecrets(error.message), retryable: true } };
  }
  return { status: 500, body: { error: "lookup_failed", message: fallback, retryable: false } };
}

export function parseAddressList(raw: string | undefined, max = 10): string[] | null {
  const list = [...new Set(String(raw ?? "").split(",").map((a) => a.trim()).filter(Boolean))];
  if (list.length < 1 || list.length > max || !list.every(isSolanaAddress)) return null;
  return list;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (parsed < min || parsed > max) return null;
  return parsed;
}

function discoveryDocument(
  env: AppEnv,
  operations: PaidOperation[],
  accepts: ChainAccept[],
  origin: string,
  sla: SlaSnapshot,
) {
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
            reason: "Set EVM_PAY_TO. Base settlements use the Coinbase CDP facilitator when CDP_API_KEY_ID and CDP_API_KEY_SECRET are set.",
          },
    },
    resources: operations.filter((operation) => operation.amount !== "0").map((operation) => ({
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
    llms: `${origin}/llms.txt`,
    health: `${origin}/health`,
    sla,
    pricingNotes: [trendingPricingNote(operations.find((operation) => operation.id === "token_trending"))].filter(
      (note) => note != null,
    ),
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
  const sla = createSlaTracker();
  const loadWallet = options.walletProfile ?? buildWalletProfile;
  const loadTrendingTokens = options.trending ?? loadTrending;
  const loadFunding = options.funding ?? loadWalletFunding;
  const loadPreview = options.preview ?? buildWalletPreview;

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

  const PARTNER_MARKER = "x-swi-partner-dispatch";
  const partnerToken = randomBytes(32).toString("hex");
  const app = new Hono();
  app.use("*", async (c, next) => {
    const started = Date.now();
    await runWithSla(sla, async () => {
      await next();
    });
    if (new URL(c.req.url).pathname !== "/health") sla.recordLatency(Date.now() - started);
  });
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

  // x402scan probes paid routes with no query, or with a placeholder query, and
  // treats anything other than a 402 as unprotected. Let those unpaid calls
  // reach the paywall. Once a PAYMENT-SIGNATURE is present, reject bad input
  // here so settlement never runs.
  app.use("*", async (c, next) => {
    const paymentSignature = c.req.header("payment-signature")?.trim();
    if (!paymentSignature) {
      await next();
      return;
    }
    const path = new URL(c.req.url).pathname;
    if (path === "/wallet/profile" || path === "/wallet/quick" || path === "/wallet/funding") {
      const a = c.req.query("address")?.trim() ?? "";
      if (!isSolanaAddress(a)) return c.json({ error: "invalid_address", message: "Query address must be a Solana base58 public key. You were not charged.", retryable: false }, 400);
    }
    if (path === "/wallet/quick/batch" && parseAddressList(c.req.query("addresses")) === null) {
      return c.json({ error: "invalid_addresses", message: "addresses must be 1 to 10 comma-separated base58 Solana addresses. You were not charged.", retryable: false }, 400);
    }
    await next();
  });

  // Partner channels re-dispatch internally with a per-process random token (never sent to clients),
  // already authenticated by their shared secret, so they skip the x402 payment step.
  const pay = paymentMiddleware(routes as never, resourceServer);
  app.use("*", async (c, next) => {
    const marker = c.req.header(PARTNER_MARKER);
    if (marker && marker.length === partnerToken.length && timingSafeEqual(Buffer.from(marker), Buffer.from(partnerToken))) {
      return next();
    }
    return pay(c, next);
  });

  app.get("/", (c) => {
    const origin = originFrom(env, c.req.url);
    return c.json({
      service: "solana-wallet-x402",
      description: "Pay per call in USDC for a Solana wallet profile or the current trending-token list.",
      networkMode: env.networkMode,
      payTo: { solana: env.solanaPayTo, base: env.evmPayTo ?? null },
      endpoints: {
        health: `${origin}/health`,
        openapi: `${origin}/openapi.json`,
        discovery: `${origin}/.well-known/x402`,
        mcp: `${origin}/mcp`,
        walletProfile: `${origin}/wallet/profile`,
        walletQuick: `${origin}/wallet/quick`,
        walletQuickBatch: `${origin}/wallet/quick/batch`,
        walletPreview: `${origin}/wallet/preview`,
        walletFunding: `${origin}/wallet/funding`,
        trending: `${origin}/token/trending`,
        llms: `${origin}/llms.txt`,
      },
    });
  });

  app.get("/favicon.ico", (c) => {
    return new Response(faviconIco, {
      status: 200,
      headers: {
        "content-type": "image/x-icon",
        "cache-control": "public, max-age=86400",
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
      sla: sla.snapshot(cache.stats()),
    }),
  );

  app.get("/openapi.json", (c) => c.json(buildOpenApi(env, operations, activeAccepts, originFrom(env, c.req.url))));
  app.get("/.well-known/x402", (c) =>
    c.json(discoveryDocument(env, operations, activeAccepts, originFrom(env, c.req.url), sla.snapshot(cache.stats()))),
  );
  app.get("/llms.txt", (c) => c.text(buildLlmsTxt(originFrom(env, c.req.url), operations)));

  function quickOf(p: Omit<WalletProfile, "cached" | "stale">) {
    const labels = p.labels ?? [];
    return {
      address: p.address,
      asOf: p.asOf,
      realizedUsd: p.pnl?.realizedUsd ?? null,
      winRate: p.pnl?.winRate ?? null,
      closedTrades: p.pnl?.closedTrades ?? 0,
      exchangeLike: labels.some((l) => /exchange|custodial/i.test(l)),
      bot: labels.some((l) => /bot/i.test(l)),
      smartMoney: labels.some((l) => /smart/i.test(l)),
      netWinner: labels.includes("net winner"),
      dormant: labels.includes("dormant"),
      portfolioUsd: p.portfolioUsd ?? null,
      lastActiveAt: p.activity?.lastActiveAt ?? null,
      windowTransactions: p.window?.transactions ?? null,
      labels,
      summary: p.summary,
    };
  }
  const quickLoad = (address: string) =>
    cache.getOrSet(`wallet:${env.walletCluster}:${address}:25`, 60_000, () => loadWallet(env, address, 25));

  async function quickBatch(list: string[]) {
    const wallets: Array<ReturnType<typeof quickOf> & { cached: boolean; stale: boolean }> = [];
    const errors: Array<{ address: string; error: string; message: string; retryable: boolean }> = [];
    await Promise.all(list.map(async (address) => {
      try {
        const hit = await quickLoad(address);
        wallets.push({ ...quickOf(hit.value), cached: hit.cached, stale: hit.stale });
      } catch (error) {
        errors.push({ address, ...publicFailure(error, "Wallet lookup failed").body });
      }
    }));
    wallets.sort((x, y) => (y.realizedUsd ?? -1e12) - (x.realizedUsd ?? -1e12));
    return { asOf: new Date().toISOString(), wallets, errors };
  }

  app.get("/wallet/quick/batch", async (c) => {
    const list = parseAddressList(c.req.query("addresses"));
    if (!list) {
      return c.json({ error: "invalid_addresses", message: "addresses must be 1 to 10 comma-separated base58 Solana addresses.", retryable: false }, 400);
    }
    return c.json(await quickBatch(list));
  });

  app.get("/wallet/quick", async (c) => {
    const address = c.req.query("address")?.trim() ?? "";
    if (!isSolanaAddress(address)) {
      return c.json({ error: "invalid_address", message: "Query address must be a Solana base58 public key.", retryable: false }, 400);
    }
    try {
      const hit = await quickLoad(address);
      return c.json({ ...quickOf(hit.value), cached: hit.cached, stale: hit.stale });
    } catch (error) {
      const failure = publicFailure(error, "Wallet lookup failed");
      return c.json(failure.body, failure.status);
    }
  });

  app.get("/wallet/preview", async (c) => {
    const address = c.req.query("address")?.trim() ?? "";
    if (!isSolanaAddress(address)) {
      return c.json({ error: "invalid_address", message: "Query address must be a Solana base58 public key.", retryable: false }, 400);
    }
    try {
      const hit = await cache.getOrSet(`preview:${env.walletCluster}:${address}`, 30_000, () => loadPreview(env, address));
      return c.json(hit.value as Record<string, unknown>);
    } catch (error) {
      const failure = publicFailure(error, "Wallet preview failed");
      return c.json(failure.body, failure.status);
    }
  });

  app.get("/wallet/profile", async (c) => {
    const address = c.req.query("address")?.trim() ?? "";
    if (!isSolanaAddress(address)) {
      return c.json(
        { error: "invalid_address", message: "Query address must be a Solana base58 public key.", retryable: false },
        400,
      );
    }
    const txLimit = clampInt(c.req.query("txLimit"), 20, 5, 25);
    if (txLimit === null) {
      return c.json({ error: "invalid_tx_limit", message: "txLimit must be an integer from 5 to 25.", retryable: false }, 400);
    }
    try {
      const hit = await cache.getOrSet(`wallet:${env.walletCluster}:${address}:${txLimit}`, 60_000, () =>
        loadWallet(env, address, txLimit),
      );
      return c.json({ ...hit.value, cached: hit.cached, stale: hit.stale });
    } catch (error) {
      const failure = publicFailure(error, "Wallet lookup failed");
      return c.json(failure.body, failure.status);
    }
  });

  app.get("/wallet/funding", async (c) => {
    const address = c.req.query("address")?.trim() ?? "";
    if (!isSolanaAddress(address)) {
      return c.json(
        { error: "invalid_address", message: "Query address must be a Solana base58 public key.", retryable: false },
        400,
      );
    }
    const peers = parsePeerList(c.req.query("peers"), address);
    if ("error" in peers) {
      return c.json({ error: "invalid_peers", message: peers.error, retryable: false }, 400);
    }
    try {
      const hit = await cache.getOrSet(`funding:${env.walletCluster}:${address}:${peers.peers.join(",")}`, 60_000, () =>
        loadFunding(env, address, peers.peers),
      );
      return c.json({ ...hit.value, cached: hit.cached, stale: hit.stale });
    } catch (error) {
      const failure = publicFailure(error, "Funding lookup failed");
      return c.json(failure.body, failure.status);
    }
  });

  app.get("/token/trending", async (c) => {
    const limit = clampInt(c.req.query("limit"), 15, 1, 25);
    if (limit === null) {
      return c.json({ error: "invalid_limit", message: "limit must be an integer from 1 to 25.", retryable: false }, 400);
    }
    try {
      const hit = await cache.getOrSet(`trending:${limit}:${Boolean(env.birdeyeApiKey)}`, 60_000, () =>
        loadTrendingTokens(env, limit),
      );
      return c.json({ ...hit.value, cached: hit.cached, stale: hit.stale });
    } catch (error) {
      const failure = publicFailure(error, "Trending lookup failed");
      return c.json(failure.body, failure.status);
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
    // Stateless server: no standalone SSE stream. Open GETs otherwise hang until the 300s function timeout.
    if (c.req.method === "GET") return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. POST JSON-RPC to /mcp." }, id: null }, 405, { Allow: "POST" });
    const mcp = new McpServer({ name: "solana-wallet-x402", version: "1.0.0" });
    mcp.tool("ping", "Free health check. Does not spend USDC.", {}, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));

    const walletOp = operations.find((operation) => operation.id === "wallet_profile");
    const trendingOp = operations.find((operation) => operation.id === "token_trending");
    const fundingOp = operations.find((operation) => operation.id === "wallet_funding");
    if (!walletOp || !trendingOp || !fundingOp) throw new Error("paid catalog is missing a tool");

    const unpaidTool = async () => ({
      isError: true,
      content: [{ type: "text" as const, text: "Payment facilitator is unavailable, so this tool is not priced yet." }],
    });

    const walletPaid = await wrapperFor(walletOp).catch(() => null);
    const walletHandler = walletPaid
      ? walletPaid(async ({ address }: { address: string }) => {
          if (!isSolanaAddress(address)) {
            return { isError: true, content: [{ type: "text" as const, text: "Query address must be a Solana base58 public key." }] };
          }
          try {
            const hit = await cache.getOrSet(`wallet:${env.walletCluster}:${address}:20`, 60_000, () => loadWallet(env, address, 20));
            return { content: [{ type: "text" as const, text: JSON.stringify({ ...hit.value, cached: hit.cached, stale: hit.stale }) }] };
          } catch (error) {
            const failure = publicFailure(error, "Wallet lookup failed");
            return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(failure.body) }] };
          }
        })
      : unpaidTool;
    mcp.tool(
      walletOp.mcpTool,
      `${walletOp.description} Costs ${walletOp.price} USDC.`,
      { address: z.string().describe("Solana wallet address") },
      walletHandler,
    );

    const trendingPaid = await wrapperFor(trendingOp).catch(() => null);
    const trendingHandler = trendingPaid
      ? trendingPaid(async ({ limit }: { limit?: string }) => {
          const parsed = clampInt(limit, 15, 1, 25);
          if (parsed === null) {
            return { isError: true, content: [{ type: "text" as const, text: "limit must be an integer from 1 to 25." }] };
          }
          try {
            const hit = await cache.getOrSet(`trending:${parsed}:${Boolean(env.birdeyeApiKey)}`, 60_000, () =>
              loadTrendingTokens(env, parsed),
            );
            return { content: [{ type: "text" as const, text: JSON.stringify({ ...hit.value, cached: hit.cached, stale: hit.stale }) }] };
          } catch (error) {
            const failure = publicFailure(error, "Trending lookup failed");
            return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(failure.body) }] };
          }
        })
      : unpaidTool;
    mcp.tool(
      trendingOp.mcpTool,
      `${trendingOp.description} Costs ${trendingOp.price} USDC.`,
      { limit: z.string().optional().describe("1 to 25, default 15") },
      trendingHandler,
    );

    const fundingPaid = await wrapperFor(fundingOp).catch(() => null);
    const fundingHandler = fundingPaid
      ? fundingPaid(async ({ address, peers }: { address: string; peers?: string }) => {
          if (!isSolanaAddress(address)) {
            return { isError: true, content: [{ type: "text" as const, text: "Query address must be a Solana base58 public key." }] };
          }
          const parsed = parsePeerList(peers, address);
          if ("error" in parsed) {
            return { isError: true, content: [{ type: "text" as const, text: parsed.error }] };
          }
          try {
            const hit = await cache.getOrSet(
              `funding:${env.walletCluster}:${address}:${parsed.peers.join(",")}`,
              60_000,
              () => loadFunding(env, address, parsed.peers),
            );
            return { content: [{ type: "text" as const, text: JSON.stringify({ ...hit.value, cached: hit.cached, stale: hit.stale }) }] };
          } catch (error) {
            const failure = publicFailure(error, "Funding lookup failed");
            return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(failure.body) }] };
          }
        })
      : unpaidTool;
    mcp.tool(
      fundingOp.mcpTool,
      `${fundingOp.description} Costs ${fundingOp.price} USDC.`,
      {
        address: z.string().describe("Solana wallet address"),
        peers: z.string().optional().describe("Comma-separated peer wallets, up to 8"),
      },
      fundingHandler,
    );

    const quickOp = operations.find((operation) => operation.id === "wallet_quick");
    if (quickOp) {
      const quickPaid = await wrapperFor(quickOp).catch(() => null);
      const quickHandler = quickPaid
        ? quickPaid(async ({ address }: { address: string }) => {
            if (!isSolanaAddress(address)) {
              return { isError: true, content: [{ type: "text" as const, text: "Query address must be a Solana base58 public key." }] };
            }
            try {
              const hit = await quickLoad(address);
              return { content: [{ type: "text" as const, text: JSON.stringify({ ...quickOf(hit.value), cached: hit.cached, stale: hit.stale }) }] };
            } catch (error) {
              const failure = publicFailure(error, "Wallet lookup failed");
              return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(failure.body) }] };
            }
          })
        : unpaidTool;
      mcp.tool(quickOp.mcpTool, `${quickOp.description} Costs ${quickOp.price} USDC.`, { address: z.string().describe("Solana wallet address") }, quickHandler);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  // Partner channels (Apify Actor, RapidAPI): the same handlers as the x402 routes, authenticated by a
  // server-side shared secret instead of a per-call USDC payment. A missing or placeholder secret disables it.
  function secretOk(expected: string, given: string | undefined): boolean {
    if (!given) return false;
    const a = createHash("sha256").update(expected).digest();
    const b = createHash("sha256").update(given).digest();
    return timingSafeEqual(a, b);
  }
  const partners: Array<{ prefix: string; channel: string; header: string; secret: () => string | undefined }> = [
    { prefix: "/internal/v1", channel: "apify", header: "x-swi-internal-key", secret: () => process.env.SWI_INTERNAL_KEY?.trim() },
    { prefix: "/rapidapi/v1", channel: "rapidapi", header: "x-rapidapi-proxy-secret", secret: () => process.env.RAPIDAPI_PROXY_SECRET?.trim() },
  ];
  const partnerPaths = ["/wallet/preview", "/wallet/quick", "/wallet/quick/batch", "/wallet/profile", "/wallet/funding", "/token/trending"];
  for (const partner of partners) {
    app.use(`${partner.prefix}/*`, async (c, next) => {
      const expected = partner.secret();
      if (!expected || /^placeholder/i.test(expected)) {
        return c.json({ error: "channel_disabled", message: `The ${partner.channel} channel is not configured.` }, 503);
      }
      if (!secretOk(expected, c.req.header(partner.header))) {
        return c.json({ error: "unauthorized", message: `Missing or invalid ${partner.header} header.` }, 401);
      }
      await next();
      c.header("x-swi-channel", partner.channel);
      c.header("cache-control", "no-store");
    });
    app.get(`${partner.prefix}/health`, (c) =>
      c.json({ ok: true, channel: partner.channel, dataCluster: env.walletCluster, asOf: new Date().toISOString() }),
    );
    for (const path of partnerPaths) {
      // Re-dispatch to the public handler with the prefix stripped. The payment middleware is skipped
      // because the inner request carries the partner marker header set only here.
      app.get(`${partner.prefix}${path}`, async (c) => {
        const url = new URL(c.req.url);
        url.pathname = path;
        const inner = new Request(url, { method: "GET", headers: { [PARTNER_MARKER]: partnerToken } });
        return app.fetch(inner);
      });
    }
  }

  return { app, env, accepts: activeAccepts, operations };
}
