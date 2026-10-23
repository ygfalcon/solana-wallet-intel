export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
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
    const message = error instanceof Error ? error.message : "request failed";
    throw new UpstreamError(`${source} request failed: ${message}`, source);
  }
  if (!response.ok) {
    throw new UpstreamError(`${source} returned HTTP ${response.status}`, source);
  }
  return (await response.json()) as T;
}
