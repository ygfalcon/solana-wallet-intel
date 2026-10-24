export {};

const devnet = process.env.SOLANA_FACILITATOR_URL ?? "https://x402.org/facilitator";
const mainnet = "https://facilitator.payai.network";

async function summarize(name: string, url: string) {
  const response = await fetch(`${url.replace(/\/$/, "")}/supported`);
  const body = await response.json() as {
    kinds?: Array<{ x402Version?: number; scheme?: string; network?: string }>;
    extensions?: string[];
  };
  const exact = (body.kinds ?? []).filter((kind) => kind.scheme === "exact" && kind.x402Version === 2);
  const networks = [...new Set(exact.map((kind) => kind.network))];
  console.log(`${name} ${url} HTTP ${response.status}`);
  console.log(`  extensions: ${(body.extensions ?? []).join(", ") || "(none)"}`);
  console.log(`  exact v2: ${networks.filter((network) => network?.startsWith("solana:") || network?.startsWith("eip155:845")).join(", ")}`);
}

await summarize("devnet-public", devnet);
await summarize("mainnet-public", mainnet);
