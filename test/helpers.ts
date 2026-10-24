import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { BASE_SEPOLIA, DEFAULT_SOLANA_PAY_TO, loadEnv, SOLANA_DEVNET, USDC_BASE_SEPOLIA, USDC_SOLANA_DEVNET } from "../src/config.js";

export const TEST_EVM_PAY_TO = "0x1111111111111111111111111111111111111111";

export function testEnv() {
  return loadEnv({
    X402_NETWORK: "devnet",
    SOLANA_PAY_TO: DEFAULT_SOLANA_PAY_TO,
    EVM_PAY_TO: TEST_EVM_PAY_TO,
    WALLET_CLUSTER: "mainnet",
    PUBLIC_BASE_URL: "http://127.0.0.1:4021",
  });
}

export function mockFacilitator(): FacilitatorClient & {
  verifyCalls: PaymentRequirements[];
  settleCalls: PaymentRequirements[];
} {
  const verifyCalls: PaymentRequirements[] = [];
  const settleCalls: PaymentRequirements[] = [];
  const supported: SupportedResponse = {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: SOLANA_DEVNET,
        extra: { feePayer: DEFAULT_SOLANA_PAY_TO },
      },
      {
        x402Version: 2,
        scheme: "exact",
        network: BASE_SEPOLIA,
        extra: {},
      },
    ],
    extensions: ["bazaar"],
    signers: {},
  };
  return {
    verifyCalls,
    settleCalls,
    async getSupported() {
      return supported;
    },
    async verify(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
      verifyCalls.push(requirements);
      return { isValid: true, payer: DEFAULT_SOLANA_PAY_TO };
    },
    async settle(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
      settleCalls.push(requirements);
      return {
        success: true,
        transaction: "mock-settlement",
        network: requirements.network,
        payer: DEFAULT_SOLANA_PAY_TO,
        amount: requirements.amount,
      };
    },
  };
}

export { USDC_SOLANA_DEVNET, USDC_BASE_SEPOLIA, SOLANA_DEVNET, BASE_SEPOLIA };
