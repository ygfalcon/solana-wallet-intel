import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import type { AppEnv } from "./config.js";

/**
 * Sends Solana and Base payments to the public PayAI facilitator. If Coinbase
 * CDP API keys are configured, Base payments go to the CDP facilitator instead.
 * Earlier x402 clients keep the first facilitator that advertises a network,
 * which would hide Base from CDP whenever the public facilitator also lists it.
 */
const PAYAI_FEE_PAYER = process.env.PAYAI_FEE_PAYER ?? "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";

export class RoutingFacilitatorClient implements FacilitatorClient {
  constructor(
    private readonly solana: FacilitatorClient,
    private readonly base: FacilitatorClient | null,
    private readonly solanaNetwork: string,
    private readonly baseNetwork: string | null,
  ) {}

  private clientFor(network: string): FacilitatorClient {
    if (this.base && this.baseNetwork && network === this.baseNetwork) {
      return this.base;
    }
    return this.solana;
  }

  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.clientFor(paymentRequirements.network).verify(paymentPayload, paymentRequirements);
  }

  settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.clientFor(paymentRequirements.network).settle(paymentPayload, paymentRequirements);
  }

  private lastGood: SupportedResponse | null = null;

  private async solanaSupportedResilient(): Promise<SupportedResponse> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await Promise.race([
          this.solana.getSupported(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("supported timeout")), 6_000)),
        ]);
        this.lastGood = result;
        return result;
      } catch (error) {
        console.warn(`facilitator /supported attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (this.lastGood) return this.lastGood;
    // Static PayAI snapshot so a slow /supported never takes paid routes down.
    return {
      kinds: [
        { x402Version: 2, scheme: "exact", network: this.solanaNetwork as never, extra: { feePayer: PAYAI_FEE_PAYER } },
        // PayAI settles Base USDC (eip155:8453 / 84532) for x402 v2 without Coinbase CDP keys.
        ...(this.baseNetwork ? [{ x402Version: 2, scheme: "exact", network: this.baseNetwork as never }] : []),
      ],
      extensions: ["bazaar"],
      signers: { "solana:*": [PAYAI_FEE_PAYER] },
    };
  }

  async getSupported(): Promise<SupportedResponse> {
    const solanaSupported = await this.solanaSupportedResilient();
    const baseSupported =
      this.base && this.base !== this.solana ? await this.base.getSupported().catch(() => null) : null;

    const kinds = [
      ...solanaSupported.kinds.filter(
        (kind) => kind.scheme === "exact" && kind.network === this.solanaNetwork,
      ),
    ];

    const baseSource = baseSupported ?? solanaSupported;
    if (this.baseNetwork) {
      kinds.push(
        ...baseSource.kinds.filter((kind) => kind.scheme === "exact" && kind.network === this.baseNetwork),
      );
    }

    return {
      kinds,
      extensions: [...new Set([...(solanaSupported.extensions ?? []), ...(baseSupported?.extensions ?? [])])],
      signers: { ...(solanaSupported.signers ?? {}), ...(baseSupported?.signers ?? {}) },
    };
  }
}

export function createFacilitator(env: AppEnv): RoutingFacilitatorClient {
  const solana = new HTTPFacilitatorClient({ url: env.publicFacilitatorUrl });
  const cdp =
    env.cdpApiKeyId && env.cdpApiKeySecret
      ? createCdpFacilitatorClient({
          apiKeyId: env.cdpApiKeyId,
          apiKeySecret: env.cdpApiKeySecret,
          baseUrl: env.cdpFacilitatorUrl,
        })
      : null;

  return new RoutingFacilitatorClient(
    solana,
    cdp,
    env.solana.network,
    env.base?.network ?? null,
  );
}
