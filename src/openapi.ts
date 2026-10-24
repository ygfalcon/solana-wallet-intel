import { BRAND } from "./brand.js";
import type { ChainAccept } from "./config.js";
import type { AppEnv } from "./config.js";
import { FREE_WALLET_PREVIEW, type PaidOperation } from "./catalog.js";

export function buildOpenApi(env: AppEnv, operations: PaidOperation[], accepts: ChainAccept[], origin: string) {
  const paths: Record<string, unknown> = {};
  for (const operation of operations) {
    paths[operation.path] = {
      get: {
        operationId: operation.id,
        summary: operation.summary,
        description: operation.description,
        tags: ["paid"],
        parameters: Object.entries(operation.inputSchema.properties).map(([name, schema]) => ({
          name,
          in: "query",
          required: operation.inputSchema.required.includes(name),
          schema: { type: "string", description: schema.description },
        })),
        "x-payment-info": {
          protocol: "x402",
          protocols: [{ x402: {} }],
          scheme: "exact",
          price: operation.price,
          amount: operation.amount,
          currency: "USDC",
          decimals: 6,
          networks: accepts.map((accept) => ({
            network: accept.network,
            asset: accept.asset,
            payTo: accept.payTo,
            chain: accept.chain,
            facilitator: accept.facilitator,
          })),
        },
        responses: {
          "200": {
            description: operation.summary,
            content: {
              "application/json": {
                schema: { type: "object" },
                example: operation.outputExample,
              },
            },
          },
          "402": {
            description:
              "Payment required. The body is an x402 PaymentRequired document: accepts[].amount is USDC base units (6 decimals, so $0.01 is \"10000\"), and inputSchema describes the query.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PaymentRequired" },
              },
            },
          },
          "400": {
            description: "A signed request failed validation before settlement. Unpaid probes receive 402 instead. The buyer is not charged.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "502": {
            description: "Upstream market data was unavailable. Settlement is cancelled. retryable is true for timeouts, rate limits, and 5xx.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Solana Wallet x402 " + BRAND.tagline,
      version: "1.0.0",
      description:
        "Pay-per-call Solana wallet profiles, funding-source clusters, and trending tokens. Agents pay USDC over x402 on Solana, and on Base through the Coinbase CDP facilitator when it is configured. Call free GET /wallet/preview or MCP wallet_preview before paying. Unpaid calls to paid routes return HTTP 402 even when the query is missing or invalid. A signed request with a bad query returns HTTP 400 and is not charged. GET /token/trending costs $0.0018 and includes holder concentration, mint and freeze authority, LP lock or burn status, and sniper or bundle share of early supply. Risky results are plain-English risk flags. Successful bodies include cached, stale, and cacheAgeMs.",
      contact: { name: BRAND.name, url: BRAND.links.x, email: "falconsol@mail.grokbot.com" },
      "x-provider": BRAND,
      "x-payment-info": {
        protocol: "x402",
        scheme: "exact",
        currency: "USDC",
        decimals: 6,
        networkMode: env.networkMode,
      },
    },
    servers: [{ url: origin }],
    paths: {
      ...paths,
      "/wallet/preview": {
        get: {
          operationId: FREE_WALLET_PREVIEW.id,
          summary: FREE_WALLET_PREVIEW.summary,
          description: `${FREE_WALLET_PREVIEW.description} MCP tool ${FREE_WALLET_PREVIEW.mcpTool}.`,
          tags: ["free"],
          security: [],
          parameters: [
            {
              name: "address",
              in: "query",
              required: true,
              schema: { type: "string", description: FREE_WALLET_PREVIEW.inputSchema.properties.address.description },
            },
          ],
          responses: {
            "200": {
              description: "Wallet preview. May be cached at the edge for a few seconds.",
              content: {
                "application/json": {
                  schema: { type: "object" },
                  example: {
                    address: "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM",
                    solBalance: 1.25,
                    lastActiveAt: "2026-10-23T18:00:00.000Z",
                    recentTxs24h: 3,
                    recentTxs24hCapped: false,
                    labels: ["recently active"],
                    preview: true,
                    cached: false,
                    stale: false,
                    cacheAgeMs: 0,
                  },
                },
              },
            },
            "400": {
              description: "Invalid address. No payment.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "502": {
              description: "Public Solana RPC was unavailable.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/health": {
        get: {
          summary: "Liveness, freshness, and SLA",
          security: [],
          description:
            "Free process check. sla.version is this build. sla.latency is p50 and p95 over a rolling window of non-health requests. sla.upstream is the Solana RPC rate-limit status. sla.cache.ageMs is the age of the oldest live cache entry. The same sla object is copied onto GET /.well-known/x402.",
          responses: {
            "200": {
              description: "The process is up, with a freshness and SLA snapshot.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok", "service", "sla"],
                    properties: {
                      ok: { type: "boolean" },
                      service: { type: "string" },
                      networkMode: { type: "string" },
                      dataCluster: { type: "string" },
                      sla: {
                        type: "object",
                        required: ["version", "windowMs", "latency", "upstream", "cache"],
                        properties: {
                          version: { type: "string", examples: ["1.1.0"] },
                          windowMs: { type: "integer", description: "Rolling window for latency and upstream samples. Default 300000." },
                          latency: {
                            type: "object",
                            properties: {
                              p50Ms: { type: ["integer", "null"] },
                              p95Ms: { type: ["integer", "null"] },
                              samples: { type: "integer" },
                            },
                          },
                          upstream: {
                            type: "object",
                            properties: {
                              status: { type: "string", enum: ["unknown", "ok", "rate_limited"] },
                              rateLimited: { type: "boolean" },
                              http429: { type: "integer", description: "HTTP 429 responses from solana-rpc and helius inside the window." },
                              lastLimitedAt: { type: ["string", "null"], format: "date-time" },
                              sources: { type: "array", items: { type: "object" } },
                            },
                          },
                          cache: {
                            type: "object",
                            properties: {
                              ageMs: { type: ["integer", "null"], description: "Age of the oldest live cache entry." },
                              newestAgeMs: { type: ["integer", "null"] },
                              entries: { type: "integer" },
                              ttlMs: { type: ["integer", "null"] },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/.well-known/x402": {
        get: {
          summary: "x402 discovery document",
          description: "Lists only paid resources. Free routes are omitted from resources.",
          security: [],
          responses: { "200": { description: "Paid endpoints, prices, and facilitator routes." } },
        },
      },
      "/llms.txt": {
        get: {
          summary: "Agent-facing service index",
          security: [],
          responses: {
            "200": {
              description: "Plain-text catalog of paid routes, USDC prices, and free discovery URLs.",
              content: { "text/plain": { schema: { type: "string" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error", "message", "retryable"],
          properties: {
            error: {
              type: "string",
              description: "Stable machine code.",
              examples: ["invalid_address", "invalid_tx_limit", "invalid_limit", "invalid_peers", "upstream_failed"],
            },
            message: { type: "string", description: "What to change. Secrets are redacted." },
            retryable: { type: "boolean", description: "True when a later attempt can succeed. False for validation errors." },
          },
        },
        PaymentRequired: {
          type: "object",
          required: ["x402Version", "accepts", "inputSchema"],
          properties: {
            x402Version: { type: "integer", const: 2 },
            error: { type: "string" },
            resource: { type: "object" },
            accepts: {
              type: "array",
              items: {
                type: "object",
                required: ["scheme", "network", "amount", "asset", "payTo"],
                properties: {
                  scheme: { type: "string", const: "exact" },
                  network: { type: "string" },
                  amount: {
                    type: "string",
                    description: "USDC base units. 6 decimals, so 0.01 USDC is \"10000\".",
                    examples: ["9000", "1800", "15000", "2000"],
                  },
                  asset: { type: "string", description: "USDC mint or contract." },
                  payTo: { type: "string" },
                  maxTimeoutSeconds: { type: "integer" },
                  extra: { type: "object" },
                },
              },
            },
            extensions: { type: "object" },
            inputSchema: { type: "object" },
          },
        },
      },
    },
  };
}
