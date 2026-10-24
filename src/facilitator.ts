import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import type { AppEnv } from "./config.js";

/**
 * Sends Solana payments to the public facilitator and Base payments to the
 * Coinbase CDP facilitator when CDP API keys are configured.
 * Earlier x402 clients keep the first facilitator that advertises a network,
 * which would hide Base from CDP whenever the public facilitator also lists it.
 */
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

  async getSupported(): Promise<SupportedResponse> {
    const solanaSupported = await this.solana.getSupported();
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
