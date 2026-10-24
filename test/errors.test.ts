import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { fetchJson, redactSecrets, UpstreamError } from "../src/http.js";

describe("upstream errors", () => {
  it("redacts API keys before they can reach a client", () => {
    const message = redactSecrets("helius request failed: https://api.helius.xyz/v0/addresses/abc/transactions?api-key=supersecret&limit=20");
    expect(message).not.toContain("supersecret");
    expect(message).toContain("api-key=redacted");
    const bearer = redactSecrets("upstream said Authorization: Bearer supersecret and api_key=supersecret");
    expect(bearer).not.toContain("supersecret");
    expect(bearer).toMatch(/authorization:\s*redacted/i);
    expect(bearer).toContain("api_key=redacted");
    expect(redactSecrets("Bearer supersecret")).toBe("Bearer redacted");
  });

  it("retries a gateway error once and does not retry HTTP 429", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      if (hits === 1) {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("unavailable");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      await expect(fetchJson(`http://127.0.0.1:${address.port}/v1`, { source: "dexscreener" })).resolves.toEqual({ ok: true });
      expect(hits).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("turns a non-JSON 200 into an upstream error without echoing the body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("api-key=supersecret");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      await expect(fetchJson(`http://127.0.0.1:${address.port}/v0?api-key=supersecret`, { source: "helius" })).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(UpstreamError);
          const message = error instanceof Error ? error.message : "";
          expect(message).toContain("non-JSON");
          expect(message).not.toContain("supersecret");
          return true;
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
