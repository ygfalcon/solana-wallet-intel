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
      contact: { name: "falcon.sol", email: "falconsol@mail.grokbot.com" },
      title: "Solana Wallet x402",
      version: "1.0.0",
      description:
        "Pay-per-call Solana wallet profiles and trending tokens. Agents pay USDC over x402 on Solana, and on Base when enabled, both settled by the PayAI facilitator.",
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
      "/health": {
        get: {
          summary: "Liveness",
          responses: { "200": { description: "The process is up." } },
        },
      },
      "/.well-known/x402": {
        get: {
          summary: "x402 discovery document",
          responses: { "200": { description: "Paid endpoints, prices, and facilitator routes." } },
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
