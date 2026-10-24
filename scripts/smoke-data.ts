import { loadEnv } from "../src/config.js";
import { buildWalletProfile } from "../src/services/wallet.js";
import { loadTrending } from "../src/services/trending.js";

async function main() {
  const env = loadEnv();
  const address = process.argv[2] ?? "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM";
  const profile = await buildWalletProfile(env, address, 5);
  console.log(JSON.stringify({
    holdings: profile.holdings.slice(0, 4).map((holding) => ({
      symbol: holding.symbol,
      amount: holding.amount,
      usd: holding.usdValue,
    })),
    portfolioUsd: profile.portfolioUsd,
    labels: profile.labels,
    swaps: profile.activity.swapCount,
    sources: profile.sources,
    warnings: profile.warnings,
  }, null, 2));
  const trending = await loadTrending(env, 3);
  console.log(JSON.stringify({
    sources: trending.sources,
    warnings: trending.warnings,
    tokens: trending.tokens.map((token) => ({
      symbol: token.symbol,
      liq: token.liquidityUsd,
      vol: token.volume24hUsd,
      age: token.ageHours,
      flags: token.riskFlags,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
