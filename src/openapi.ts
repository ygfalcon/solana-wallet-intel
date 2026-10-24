import type { ChainAccept } from "./config.js";
import type { AppEnv } from "./config.js";
import type { PaidOperation } from "./catalog.js";

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
          "400": { description: "The query failed validation. Settlement is cancelled." },
          "502": { description: "Upstream market data was unavailable. Settlement is cancelled." },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Solana Wallet x402",
      version: "1.0.0",
      description:
        "Pay-per-call Solana wallet profiles, funding-source clusters, and trending tokens. Agents pay USDC over x402 on Solana, and on Base through the Coinbase CDP facilitator when it is configured. GET /token/trending costs $0.005 and includes holder concentration, mint and freeze authority, LP lock or burn status, and sniper or bundle share of early supply. Risky results are plain-English risk flags.",
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
          operationId: "wallet_preview",
          summary: "Free wallet preview",
          description: "Free SOL balance, last active time and 24h transaction count. No payment.",
          tags: ["free"],
          parameters: [{ name: "address", in: "query", required: true, schema: { type: "string", description: "Solana wallet address in base58." } }],
          responses: { "200": { description: "Wallet preview" }, "400": { description: "Invalid address" } },
        },
      },
      "/health": {
        get: {
          summary: "Liveness, freshness, and SLA",
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
                          version: { type: "string", examples: ["1.0.0"] },
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
          responses: { "200": { description: "Paid endpoints, prices, and facilitator routes." } },
        },
      },
      "/llms.txt": {
        get: {
          summary: "Agent-facing service index",
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
                    examples: ["10000", "5000"],
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
