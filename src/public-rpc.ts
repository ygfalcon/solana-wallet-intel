import { UpstreamError } from "./http.js";
import { currentSla, rpcBodyRateLimited } from "./sla.js";

export const PUBLIC_SOLANA_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
];

const BATCH_LIMIT = 8;

export type RpcRequest = { method: string; params: unknown[] };

type RpcOptions = {
  endpoints?: string[];
  fetch?: typeof fetch;
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function isUsableEndpoint(url: string): boolean {
  return !/helius|api-key=/i.test(url);
}

export function createPublicRpc(options: RpcOptions = {}) {
  const endpoints = (options.endpoints ?? PUBLIC_SOLANA_RPCS).filter(isUsableEndpoint);
  const fetchImpl = options.fetch;
  const minIntervalMs = options.minIntervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let cursor = 0;
  let nextAt = 0;

  async function pace() {
    const wait = Math.max(0, nextAt - now());
    if (wait > 0) await sleep(wait);
    nextAt = now() + minIntervalMs;
  }

  async function post(requests: RpcRequest[]): Promise<unknown[]> {
    if (endpoints.length === 0) throw new UpstreamError("public Solana RPC failed", "solana-rpc");
    await pace();
    const body = requests.map((request, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: request.method,
      params: request.params,
    }));
    for (let attempt = 0; attempt < endpoints.length; attempt += 1) {
      const endpoint = endpoints[cursor % endpoints.length];
      cursor += 1;
      try {
        const response = await (fetchImpl ?? globalThis.fetch)(endpoint, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8_000),
        });
        const limited = response.status === 429;
        if (limited || response.status >= 500) {
          currentSla()?.noteUpstream({ source: "solana-rpc", httpStatus: response.status, rateLimited: limited });
          continue;
        }
        if (!response.ok) {
          currentSla()?.noteUpstream({ source: "solana-rpc", httpStatus: response.status, rateLimited: false });
          continue;
        }
        const payload = (await response.json()) as unknown;
        if (!Array.isArray(payload)) {
          const rateLimited = rpcBodyRateLimited(payload);
          currentSla()?.noteUpstream({ source: "solana-rpc", httpStatus: response.status, rateLimited });
          continue;
        }
        const byId = new Map<number, unknown>();
        let rateLimited = false;
        for (const item of payload) {
          if (!item || typeof item !== "object" || !("id" in item)) continue;
          const id = Number((item as { id: unknown }).id);
          const error = (item as { error?: unknown }).error;
          if (error && rpcBodyRateLimited({ error })) rateLimited = true;
          byId.set(id, error ? null : ((item as { result?: unknown }).result ?? null));
        }
        if (rateLimited) {
          currentSla()?.noteUpstream({ source: "solana-rpc", httpStatus: 429, rateLimited: true });
          continue;
        }
        currentSla()?.noteUpstream({ source: "solana-rpc", httpStatus: response.status, rateLimited: false });
        return requests.map((_, index) => (byId.has(index + 1) ? byId.get(index + 1) : null));
      } catch {
        continue;
      }
    }
    throw new UpstreamError("public Solana RPC failed", "solana-rpc");
  }

  return {
    async batch(requests: RpcRequest[]): Promise<unknown[]> {
      const results: unknown[] = [];
      for (let start = 0; start < requests.length; start += BATCH_LIMIT) {
        const slice = requests.slice(start, start + BATCH_LIMIT);
        results.push(...(await post(slice)));
      }
      return results;
    },
  };
}

const sharedClients = new Map<string, ReturnType<typeof createPublicRpc>>();

/** One paced client per endpoint set, so warm isolates respect the free RPC interval across requests. */
export function sharedPublicRpc(endpoints: string[] = PUBLIC_SOLANA_RPCS) {
  const usable = endpoints.filter(isUsableEndpoint);
  const key = usable.join("\n");
  let client = sharedClients.get(key);
  if (!client) {
    client = createPublicRpc({ endpoints: usable });
    sharedClients.set(key, client);
  }
  return client;
}

export function mainnetPreviewEndpoints(primary: string): string[] {
  const primaryOk = isUsableEndpoint(primary);
  const urls = primaryOk ? [primary, ...PUBLIC_SOLANA_RPCS] : [...PUBLIC_SOLANA_RPCS];
  return [...new Set(urls)].filter(isUsableEndpoint);
}
