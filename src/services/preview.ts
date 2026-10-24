import type { AppEnv } from "../config.js";
import { UpstreamError } from "../http.js";
import { createPublicRpc, PUBLIC_SOLANA_RPCS } from "../public-rpc.js";

type RpcResponse<T> = { result?: T; error?: { message?: string } };

/** Free teaser: SOL balance and recent activity in one batched JSON-RPC request. */
export async function buildWalletPreview(env: AppEnv, address: string) {
  const endpoints = [env.solanaRpcUrl, ...PUBLIC_SOLANA_RPCS.filter((u) => u !== env.solanaRpcUrl)];
  let results: unknown[];
  try {
    results = await createPublicRpc({ endpoints }).batch([
      { method: "getBalance", params: [address] },
      { method: "getSignaturesForAddress", params: [address, { limit: 25 }] },
    ]);
  } catch {
    throw new UpstreamError("solana-rpc rate limited or unavailable", "solana-rpc");
  }
  const bal = { result: results[0] } as RpcResponse<unknown>;
  const sigsRes = { result: results[1] } as RpcResponse<unknown>;
  if (results[0] == null || results[1] == null) throw new UpstreamError("RPC error", "solana-rpc");
  const lamportsRaw = bal.result as { value: number } | number;
  const lamports = typeof lamportsRaw === "number" ? lamportsRaw : lamportsRaw?.value ?? 0;
  const sigs = (sigsRes.result as Array<{ blockTime: number | null }>) ?? [];
  const sol = lamports / 1_000_000_000;
  const last = sigs[0]?.blockTime ?? null;
  const now = Date.now() / 1000;
  const recent24 = sigs.filter((x) => x.blockTime && now - x.blockTime < 86_400).length;
  const count = recent24 >= 25 ? "25+" : String(recent24);
  return {
    address,
    asOf: new Date().toISOString(),
    solBalance: sol,
    lastActiveAt: last ? new Date(last * 1000).toISOString() : null,
    recentTxs24h: recent24,
    recentTxs24hCapped: recent24 >= 25,
    summary: last
      ? `Holds ${sol.toFixed(4)} SOL. Last active ${new Date(last * 1000).toISOString().slice(0, 10)}, with ${count} transactions in the last 24h.`
      : `Holds ${sol.toFixed(4)} SOL. No transactions found.`,
    labels: last ? (now - last > 14 * 86_400 ? ["dormant"] : ["recently active"]) : ["no activity"],
    preview: true,
    upgrade: `${env.priceWalletQuick} at /wallet/quick for realized PnL, win rate and bot flags; ${env.priceWalletProfile} at /wallet/profile for priced holdings and the full report.`,
  };
}
