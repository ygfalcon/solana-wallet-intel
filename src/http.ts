import { currentSla, rpcBodyRateLimited } from "./sla.js";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export function redactSecrets(value: string): string {
  return value
    .replace(/api-key=[^&\s]+/gi, "api-key=redacted")
    .replace(/([?&](?:key|token|secret)=)[^&\s]+/gi, "$1redacted")
    .replace(/\b(x-api-key|authorization)\b(\s*[:=]\s*)\S+/gi, "$1$2redacted");
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; source: string },
): Promise<T> {
  const { timeoutMs = 8_000, source, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        "user-agent": "solana-wallet-x402/1.0",
        ...(rest.headers ?? {}),
      },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new UpstreamError(`${source} timed out`, source);
    }
    const message = error instanceof Error ? error.message : "request failed";
    throw new UpstreamError(`${source} request failed: ${redactSecrets(message)}`, source);
  }
  if (!response.ok) {
    currentSla()?.noteUpstream({ source, httpStatus: response.status, rateLimited: response.status === 429 });
    throw new UpstreamError(`${source} returned HTTP ${response.status}`, source);
  }
  try {
    const body = (await response.json()) as T;
    currentSla()?.noteUpstream({ source, httpStatus: response.status, rateLimited: rpcBodyRateLimited(body) });
    return body;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(`${source} returned a non-JSON body`, source);
  }
}
