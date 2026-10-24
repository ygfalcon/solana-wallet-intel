import { currentSla, rpcBodyRateLimited } from "./sla.js";

export class UpstreamError extends Error {
  readonly status?: number;

  constructor(message: string, readonly source: string, status?: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }

  /** Agents can retry timeouts, rate limits, and 5xx. A 4xx from upstream will not succeed on retry. */
  get retryable(): boolean {
    if (this.status == null) return true;
    return this.status === 429 || this.status >= 500;
  }
}

export function redactSecrets(value: string): string {
  return value
    .replace(/api-key=[^&\s]+/gi, "api-key=redacted")
    .replace(/\b((?:api[_-]?key|apikey|key|token|secret|password)=)[^&\s]+/gi, "$1redacted")
    .replace(/\b(x-api-key|authorization)\b(\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1$2redacted")
    .replace(/\b(bearer)\s+\S+/gi, "$1 redacted");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry transient network and gateway failures once. Never retry 429: that makes a free RPC limit worse. */
function shouldRetry(error: UpstreamError): boolean {
  if (/timed out/i.test(error.message)) return false;
  if (error.status == null) return true;
  return error.status >= 500 && error.status <= 504;
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; source: string; retries?: number },
): Promise<T> {
  const retries = init.retries ?? 1;
  let attempt = 0;
  for (;;) {
    try {
      return await fetchJsonOnce<T>(url, init);
    } catch (error) {
      if (!(error instanceof UpstreamError) || attempt >= retries || !shouldRetry(error)) throw error;
      attempt += 1;
      await sleep(200 * attempt);
    }
  }
}

async function fetchJsonOnce<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; source: string; retries?: number },
): Promise<T> {
  const { timeoutMs = 8_000, source, retries: _retries, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        "user-agent": "solana-wallet-x402/1.1",
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
    throw new UpstreamError(`${source} returned HTTP ${response.status}`, source, response.status);
  }
  try {
    const body = (await response.json()) as T;
    currentSla()?.noteUpstream({ source, httpStatus: response.status, rateLimited: rpcBodyRateLimited(body) });
    return body;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(`${source} returned a non-JSON body`, source, response.status);
  }
}
