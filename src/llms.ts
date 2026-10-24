import type { PaidOperation } from "./catalog.js";

export const TRENDING_CHECKS = [
  "top-10 holder share",
  "mint and freeze authority",
  "LP lock or burn status",
  "sniper and bundle share of early supply",
] as const;

export const TRENDING_PRICE_NOTE =
  "GET /token/trending costs $0.0018 (1800 base units). That price includes holder concentration (top-10 share), mint and freeze authority, LP lock or burn status, and sniper or bundle share of early supply. Each risky result is a plain-English risk flag. The checks are read from free public Solana RPCs. When a check cannot be read, the response says so.";

export function trendingPricingNote(operation: PaidOperation | undefined) {
  if (!operation || operation.id !== "token_trending") return null;
  return {
    path: operation.path,
    price: operation.price,
    amount: operation.amount,
    checks: [...TRENDING_CHECKS],
    note: TRENDING_PRICE_NOTE,
  };
}

export function buildLlmsTxt(origin: string, operations: PaidOperation[]): string {
  const lines = [
    "# Solana Wallet x402",
    "",
    "> Pay-per-call Solana wallet intelligence. Agents pay USDC over x402 on Solana or Base. An unpaid call returns HTTP 402. accepts[].amount is USDC base units (6 decimals).",
    "",
    "## Paid",
    "",
  ];
  for (const operation of operations) {
    const optional = Object.keys(operation.inputSchema.properties).filter(
      (name) => !operation.inputSchema.required.includes(name),
    );
    const required = operation.inputSchema.required.length
      ? `Required query: ${operation.inputSchema.required.join(", ")}.`
      : "No required query.";
    const optionalText = optional.length ? ` Optional query: ${optional.join(", ")}.` : "";
    lines.push(
      `- [${operation.summary}](${origin}${operation.path}): ${operation.price} USDC (${operation.amount} base units). ${operation.description} ${required}${optionalText} MCP tool \`${operation.mcpTool}\`.`,
    );
  }
  lines.push(
    "",
    "## Free",
    "",
    `- [Wallet preview](${origin}/wallet/preview): free SOL balance, last active time and 24h transaction count. Required query: address. No payment.`,
    `- [Health](${origin}/health): free freshness and SLA. Reports version, p50 and p95 latency over a rolling window, upstream RPC rate-limit status, and cache age. No payment. The same sla object is on /.well-known/x402.`,
    `- [OpenAPI](${origin}/openapi.json): machine-readable API with x-payment-info on paid routes and the health SLA schema.`,
    `- [x402 discovery](${origin}/.well-known/x402): prices, accepts, input schemas, facilitator URLs, and the live SLA snapshot.`,
    `- [MCP](${origin}/mcp): tools ${operations.map((operation) => `\`${operation.mcpTool}\``).join(", ")}, plus free \`ping\`.`,
    "",
    "## Pricing note",
    "",
    TRENDING_PRICE_NOTE,
    "",
    "Pay with an x402 client (PAYMENT-SIGNATURE) or the official MCP payment wrapper. Settlement is cancelled when the route returns a non-2xx error.",
    "",
  );
  return lines.join("\n");
}
