import { describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { RoutingFacilitatorClient } from "../src/facilitator.js";
import { BASE_SEPOLIA, SOLANA_DEVNET } from "../src/config.js";

function stub(name: string, kinds: SupportedResponse["kinds"]): FacilitatorClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getSupported() {
      return { kinds, extensions: name === "cdp" ? ["bazaar"] : [], signers: {} };
    },
    async verify() {
      calls.push("verify");
      return { isValid: true };
    },
    async settle(_payload, requirements) {
      calls.push(`settle:${requirements.network}`);
      return { success: true, transaction: name, network: requirements.network };
    },
  };
}

describe("facilitator routing", () => {
  it("settles Solana on the public facilitator and Base on CDP", async () => {
    const solana = stub("public", [
      { x402Version: 2, scheme: "exact", network: SOLANA_DEVNET, extra: { feePayer: "fee" } },
      { x402Version: 2, scheme: "exact", network: BASE_SEPOLIA },
    ]);
    const cdp = stub("cdp", [
      { x402Version: 2, scheme: "exact", network: BASE_SEPOLIA },
      { x402Version: 2, scheme: "exact", network: SOLANA_DEVNET },
    ]);
    const router = new RoutingFacilitatorClient(solana, cdp, SOLANA_DEVNET, BASE_SEPOLIA);
    const supported = await router.getSupported();
    expect(supported.kinds.map((kind) => kind.network).sort()).toEqual([BASE_SEPOLIA, SOLANA_DEVNET].sort());
    expect(supported.extensions).toContain("bazaar");

    const solanaReq = { network: SOLANA_DEVNET } as unknown as PaymentRequirements;
    const baseReq = { network: BASE_SEPOLIA } as unknown as PaymentRequirements;
    await router.settle({} as never, solanaReq);
    await router.settle({} as never, baseReq);
    expect(solana.calls).toEqual([`settle:${SOLANA_DEVNET}`]);
    expect(cdp.calls).toEqual([`settle:${BASE_SEPOLIA}`]);
  });
});
