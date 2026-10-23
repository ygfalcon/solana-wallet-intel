import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const { app, env, accepts } = await createApp();

serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
  const chains = accepts.map((accept) => `${accept.chain}:${accept.network}`).join(", ");
  console.log(`solana-wallet-x402 listening on http://127.0.0.1:${info.port}`);
  console.log(`payments: ${env.networkMode} via ${chains || "none"}`);
  console.log(`solana payTo ${env.solanaPayTo}`);
  if (!env.evmPayTo) console.log("Base is hidden until EVM_PAY_TO is set");
});
