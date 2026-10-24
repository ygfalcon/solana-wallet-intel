import type { AppEnv } from "./config.js";
import { fetchJson, UpstreamError } from "./http.js";
import { PUBLIC_SOLANA_RPCS } from "./public-rpc.js";
import { rpcBodyRateLimited } from "./sla.js";

type RpcEnvelope<T> = { result?: T; error?: { message?: string } };

/**
 * Mainnet reads try the configured RPC first, then free public endpoints.
 * Devnet stays on the configured URL so a mainnet fallback cannot return another cluster's accounts.
 */
export function rpcEndpoints(env: AppEnv): string[] {
  if (env.walletCluster !== "mainnet") return [env.solanaRpcUrl];
  return [env.solanaRpcUrl, ...PUBLIC_SOLANA_RPCS.filter((url) => url !== env.solanaRpcUrl)];
}

function failover(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) return false;
  if (error.status == null) return true;
  return error.status === 429 || error.status >= 500;
}

export async function solanaRpc<T>(env: AppEnv, method: string, params: unknown[]): Promise<T> {
  const endpoints = rpcEndpoints(env);
  let last: unknown;
  for (let index = 0; index < endpoints.length; index += 1) {
    const url = endpoints[index];
    const source = /helius/i.test(url) ? "helius" : "solana-rpc";
    try {
      const body = await fetchJson<RpcEnvelope<T>>(url, {
        source,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        timeoutMs: 8_000,
        retries: 0,
      });
      if (body.error) {
        const limited = rpcBodyRateLimited(body);
        const error = new UpstreamError(body.error.message ?? "RPC error", source, limited ? 429 : 400);
        if (!limited || index === endpoints.length - 1) throw error;
        last = error;
        continue;
      }
      return body.result as T;
    } catch (error) {
      last = error;
      if (!failover(error) || index === endpoints.length - 1) throw error;
    }
  }
  throw last instanceof Error ? last : new UpstreamError("solana-rpc request failed", "solana-rpc");
}
