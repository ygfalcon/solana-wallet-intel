import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { fetchJson, redactSecrets, UpstreamError } from "../src/http.js";

describe("upstream errors", () => {
  it("redacts API keys before they can reach a client", () => {
    const message = redactSecrets("helius request failed: https://api.helius.xyz/v0/addresses/abc/transactions?api-key=supersecret&limit=20");
    expect(message).not.toContain("supersecret");
    expect(message).toContain("api-key=redacted");
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
