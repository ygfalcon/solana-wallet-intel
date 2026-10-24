import { BRAND } from "./brand.js";
import { FREE_WALLET_PREVIEW, type PaidOperation } from "./catalog.js";

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

function priceOf(operations: PaidOperation[], id: PaidOperation["id"]): string {
  return operations.find((operation) => operation.id === id)?.price ?? "";
}

function callOrder(operations: PaidOperation[]): string[] {
  return [
    `- Call \`wallet_quick\` (${priceOf(operations, "wallet_quick")}) for a copy-trade screen: realized PnL, win rate, closed trades, copyTradeScore, copyTradeGrade, and bot, exchange, net-winner, and dormant flags.`,
    `- Call \`wallet_quick_batch\` (${priceOf(operations, "wallet_quick_batch")}) to screen up to 10 wallets in one paid call, ranked by realized PnL, each with copyTradeScore and copyTradeGrade. \`addresses\` is 1 to 10 comma-separated base58 addresses.`,
    `- Call \`wallet_profile\` (${priceOf(operations, "wallet_profile")}) for priced holdings, windowed PnL, and evidence-backed labels. \`txLimit\` is an integer from 5 to 25 and defaults to 20.`,
    `- Call \`wallet_funding\` (${priceOf(operations, "wallet_funding")}) for the first SOL funder and a sybil cluster. \`peers\` compares up to 8 other wallets.`,
    `- Call \`token_trending\` (${priceOf(operations, "token_trending")}) for trending Solana tokens with plain-English risk flags. \`limit\` is an integer from 1 to 25 and defaults to 15.`,
  ];
}

export function buildLlmsTxt(origin: string, operations: PaidOperation[]): string {
  const lines = [
    "# Solana Wallet x402",
    "",
    `${BRAND.blurb} X: ${BRAND.links.x} · GitHub: ${BRAND.links.github} · Apify: ${BRAND.links.apify}`,
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
    `- [Wallet preview](${origin}/wallet/preview): free SOL balance, last active time and 24h transaction count. Required query: address. No payment. MCP tool \`${FREE_WALLET_PREVIEW.mcpTool}\`. ${FREE_WALLET_PREVIEW.description}`,
    `- [Health](${origin}/health): free freshness and SLA. Reports version, p50 and p95 latency over a rolling window, upstream RPC rate-limit status, and cache age. No payment. The same sla object is on /.well-known/x402.`,
    `- [OpenAPI](${origin}/openapi.json): machine-readable API with x-payment-info on paid routes and the health SLA schema.`,
    `- [x402 discovery](${origin}/.well-known/x402): prices, accepts, input schemas, facilitator URLs, and the live SLA snapshot.`,
    `- [MCP](${origin}/mcp): POST JSON-RPC. GET returns 405. Tools ${operations.map((operation) => `\`${operation.mcpTool}\``).join(", ")}, plus free \`${FREE_WALLET_PREVIEW.mcpTool}\` and \`ping\`. Every tool is read-only.`,
    "",
    "## Which call to make",
    "",
    "- Call `wallet_preview` first when you need SOL balance, last active time, or a 24h transaction count. It is free.",
    ...callOrder(operations),
    "",
    "An unpaid call to a paid route returns HTTP 402 even when address, addresses, txLimit, limit, or peers is missing or invalid. After a PAYMENT-SIGNATURE is attached, a bad query returns HTTP 400 and is not charged. Settlement is cancelled when a paid route returns a non-2xx status.",
    "",
    "Responses include `cached`, `stale`, and `cacheAgeMs`. `stale: true` means a previous result was returned while a refresh runs or the upstream failed. Paid responses are `Cache-Control: private, no-store` so a shared CDN cannot skip payment. The free preview may be cached briefly at the edge.",
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
