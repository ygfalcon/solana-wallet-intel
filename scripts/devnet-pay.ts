import "dotenv/config";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const baseUrl = process.env.PAY_TARGET_URL ?? "http://127.0.0.1:4021";
const secret = process.env.SOLANA_PRIVATE_KEY;

function fundingSteps(): string {
  return [
    "A live devnet settlement needs a buyer key with devnet USDC. The server does not hold a buyer key.",
    "",
    "1. Create a disposable buyer: solana-keygen new --outfile buyer.json --no-bip39-passphrase",
    "2. solana config set --url https://api.devnet.solana.com",
    "3. Fund devnet SOL only if you want to create accounts yourself. The public facilitator pays the transaction fee.",
    "4. Open https://faucet.circle.com and request Solana Devnet USDC to the buyer address.",
    "   The mint must be 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU.",
    "5. Export the buyer secret as base58 (the JSON keypair file is a byte array):",
    "     node --input-type=module -e \"import {readFileSync} from 'node:fs'; import {base58} from '@scure/base'; const k=JSON.parse(readFileSync('buyer.json','utf8')); console.log(base58.encode(Uint8Array.from(k)))\"",
    "6. Start this API with X402_NETWORK=devnet (the default) and SOLANA_PAY_TO=HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM.",
    "7. SOLANA_PRIVATE_KEY=<base58> PAY_TARGET_URL=http://127.0.0.1:4021 npm run pay:devnet",
    "",
    "If settlement says the merchant token account is missing, send any amount of that same devnet USDC to",
    "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM once so the associated token account exists, then retry.",
    "The x402.org facilitator sponsors the SOL fee. The buyer only spends devnet USDC.",
  ].join("\n");
}

if (!secret) {
  console.log(fundingSteps());
  process.exit(0);
}

const bytes = secret.trim().startsWith("[")
  ? Uint8Array.from(JSON.parse(secret) as number[])
  : base58.decode(secret.trim());
const signer = await createKeyPairSignerFromBytes(bytes);
const client = new x402Client().register("solana:*", new ExactSvmScheme(signer));
const payFetch = wrapFetchWithPayment(fetch, client);
const response = await payFetch(`${baseUrl}/token/trending?limit=5`);
const body = await response.json();
console.log(`HTTP ${response.status}`);
console.log(JSON.stringify(body, null, 2).slice(0, 2000));
console.log(response.headers.get("PAYMENT-RESPONSE") ?? "");
if (!response.ok) process.exit(1);
