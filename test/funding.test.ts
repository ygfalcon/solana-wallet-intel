import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { paidOperations } from "../src/catalog.js";
import { loadEnv } from "../src/config.js";
import { assessFunding, nativeTransfersFromParsed, parsePeerList, type NativeTransfer, type WalletActivity } from "../src/funding.js";
import { buildLlmsTxt } from "../src/llms.js";
import { cexExchange } from "../src/cex.js";
import { loadWalletFunding } from "../src/services/funding.js";
import { testEnv } from "./helpers.js";

const WALLET = "HD1ryR3dYSXBVNGfJZydbpmnChiE1wrAQkupWWtHt4pM";
const PEER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PEER_B = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const FUNDER = "So11111111111111111111111111111111111111112";
const FUNDER_B = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const BINANCE = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const DEPOSIT = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const DEPOSIT_B = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const SYSTEM = "11111111111111111111111111111111";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function day(blockTime: number): string {
  return new Date(blockTime * 1000).toISOString().slice(0, 10);
}

function transfer(from: string, to: string, lamports: number, blockTime: number, signature: string): NativeTransfer {
  return { signature, blockTime, from, to, lamports };
}

function activity(
  address: string,
  options: {
    funder?: string;
    funderLamports?: number;
    funderTime?: number;
    outbound?: NativeTransfer[];
    recipientTransfers?: NativeTransfer[];
    historyComplete?: boolean;
    extra?: NativeTransfer[];
  } = {},
): WalletActivity {
  const transfers: NativeTransfer[] = [...(options.extra ?? [])];
  if (options.funder) {
    transfers.push(
      transfer(options.funder, address, options.funderLamports ?? 1_000_000_000, options.funderTime ?? 100, `${address}-fund`),
    );
  }
  transfers.push(...(options.outbound ?? []));
  return {
    address,
    historyComplete: options.historyComplete ?? true,
    transfers,
    recipientTransfers: options.recipientTransfers ?? [],
  };
}

function systemTx(from: string, to: string, lamports: number, blockTime: number) {
  return {
    blockTime,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [lamports + 5000, 0],
      postBalances: [0, lamports],
      innerInstructions: [],
    },
    transaction: {
      message: {
        accountKeys: [from, to],
        instructions: [
          {
            program: "system",
            programId: SYSTEM,
            parsed: { type: "transfer", info: { source: from, destination: to, lamports } },
          },
        ],
      },
    },
  };
}

describe("funding source and clusters", () => {
  it("labels known exchange hot wallets and leaves personal wallets unlabeled", () => {
    expect(cexExchange(BINANCE)).toBe("Binance");
    expect(cexExchange(FUNDER)).toBeNull();
  });

  it("uses the earliest inbound SOL above dust as the funder", () => {
    const report = assessFunding(WALLET, [
      activity(WALLET, {
        extra: [
          transfer("later-guy", WALLET, 5_000_000_000, 500, "later"),
          transfer(FUNDER, WALLET, 1_500_000_000, 100, "first"),
          transfer("dust", WALLET, 5_000, 50, "dust"),
          transfer(WALLET, WALLET, 2_000_000_000, 10, "self"),
        ],
      }),
    ]);
    expect(report.funder).toEqual({
      address: FUNDER,
      amountSol: 1.5,
      fundedAt: new Date(100 * 1000).toISOString(),
      signature: "first",
      exchange: null,
    });
    expect(report.cluster).toMatchObject({
      id: `funder:${FUNDER}`,
      key: "funder",
      funderId: `funder:${FUNDER}`,
      cexDepositId: null,
      members: [WALLET],
    });
    expect(report.risk.level).toBe("low");
    expect(report.risk.reasons).toEqual([
      `First SOL came from ${FUNDER}: 1.5 SOL on ${day(100)}. That address is not a labeled exchange hot wallet.`,
      `Cluster id funder:${FUNDER} matches any other wallet with the same first funder.`,
    ]);
    expect(report.summary).toBe(report.risk.reasons.join(" "));
    expect(report.disclaimer).toBe(
      "This is a heuristic, not proof of common ownership. A shared personal funder or CEX deposit address is a risk signal. A shared exchange hot wallet is not.",
    );
  });

  it("does not cluster wallets that only share an exchange hot wallet", () => {
    const report = assessFunding(WALLET, [
      activity(WALLET, { funder: BINANCE, funderLamports: 2_000_000_000, funderTime: 100 }),
      activity(PEER, { funder: BINANCE, funderLamports: 3_000_000_000, funderTime: 120 }),
    ]);
    expect(report.funder?.exchange).toBe("Binance");
    expect(report.cluster.id).toBeNull();
    expect(report.cluster.funderId).toBeNull();
    expect(report.shared).toEqual({ funder: [], cexDeposit: [] });
    expect(report.risk.level).toBe("medium");
    expect(report.risk.reasons).toContain(
      `First SOL came from Binance hot wallet ${BINANCE}: 2 SOL on ${day(100)}. Many unrelated customers withdraw from that wallet, so it is not used as a cluster id.`,
    );
    expect(report.risk.reasons).toContain(
      `1 peer wallet was also funded by Binance hot wallet ${BINANCE}. They are not clustered together.`,
    );
  });

  it("assigns one cluster id when wallets share a personal first funder", () => {
    const report = assessFunding(WALLET, [
      activity(WALLET, { funder: FUNDER, funderTime: 100 }),
      activity(PEER, { funder: FUNDER, funderTime: 140 }),
      activity(PEER_B, { funder: FUNDER_B, funderTime: 180 }),
    ]);
    const alone = assessFunding(PEER, [activity(PEER, { funder: FUNDER, funderTime: 140 })]);
    expect(report.cluster.id).toBe(`funder:${FUNDER}`);
    expect(alone.cluster.id).toBe(report.cluster.id);
    expect(report.cluster.members).toEqual([WALLET, PEER]);
    expect(report.shared).toEqual({ funder: [PEER], cexDeposit: [] });
    expect(report.peersChecked).toBe(2);
    expect(report.risk.level).toBe("high");
    expect(report.risk.reasons).toContain(
      `${PEER} shares that first SOL funder. Wallets opened by the same funder are often one operator or a sybil set.`,
    );
    expect(report.risk.reasons).toContain(`Cluster id is funder:${FUNDER}.`);
    expect(report.risk.reasons).toContain(
      `Checked 2 peer wallets. None share a CEX deposit address.`,
    );
  });

  it("clusters wallets that sent SOL to the same exchange deposit address", () => {
    const sweep = [transfer(DEPOSIT, BINANCE, 3_000_000_000, 400, "sweep")];
    const outbound = [transfer(WALLET, DEPOSIT, 3_000_000_000, 300, "deposit-out")];
    const peerOut = [transfer(PEER, DEPOSIT, 1_000_000_000, 320, "peer-out")];
    const report = assessFunding(WALLET, [
      activity(WALLET, { funder: FUNDER, outbound, recipientTransfers: sweep }),
      activity(PEER, { funder: FUNDER_B, outbound: peerOut, recipientTransfers: sweep }),
    ]);
    expect(report.cexDeposit).toEqual({
      address: DEPOSIT,
      exchange: "Binance",
      hotWallet: BINANCE,
      amountSol: 3,
      signature: "deposit-out",
    });
    expect(report.cluster).toMatchObject({
      id: `cex-deposit:${DEPOSIT}`,
      key: "cex_deposit",
      funderId: `funder:${FUNDER}`,
      cexDepositId: `cex-deposit:${DEPOSIT}`,
      members: [WALLET, PEER],
    });
    expect(report.shared).toEqual({ funder: [], cexDeposit: [PEER] });
    expect(report.risk.level).toBe("high");
    expect(report.risk.reasons).toContain(
      `This wallet sent 3 SOL to ${DEPOSIT}, which later forwarded SOL to Binance hot wallet ${BINANCE}. That looks like a Binance deposit address.`,
    );
    expect(report.risk.reasons).toContain(
      `${PEER} sent SOL to the same Binance deposit address. Shared exchange deposit addresses usually belong to one account.`,
    );
    expect(report.risk.reasons).toContain(`Cluster id is cex-deposit:${DEPOSIT}.`);
  });

  it("keeps the deposit cluster when a peer only shares the personal funder", () => {
    const sweep = [transfer(DEPOSIT, BINANCE, 4_000_000_000, 400, "sweep")];
    const report = assessFunding(WALLET, [
      activity(WALLET, {
        funder: FUNDER,
        outbound: [transfer(WALLET, DEPOSIT, 4_000_000_000, 300, "out")],
        recipientTransfers: sweep,
      }),
      activity(PEER, {
        funder: FUNDER_B,
        outbound: [transfer(PEER, DEPOSIT, 1_000_000_000, 310, "peer-out")],
        recipientTransfers: sweep,
      }),
      activity(PEER_B, { funder: FUNDER }),
    ]);
    expect(report.cluster.id).toBe(`cex-deposit:${DEPOSIT}`);
    expect(report.cluster.members).toEqual([WALLET, PEER]);
    expect(report.cluster.funderId).toBe(`funder:${FUNDER}`);
    expect(report.shared).toEqual({ funder: [PEER_B], cexDeposit: [PEER] });
    expect(report.risk.level).toBe("high");
    expect(report.risk.reasons.join(" ")).toContain(PEER_B);
    expect(report.risk.reasons.join(" ")).toContain(PEER);
  });

  it("does not treat a direct send to an exchange hot wallet as a shared deposit", () => {
    const report = assessFunding(WALLET, [
      activity(WALLET, {
        funder: FUNDER,
        outbound: [transfer(WALLET, BINANCE, 2_000_000_000, 300, "to-binance")],
      }),
      activity(PEER, {
        funder: FUNDER_B,
        outbound: [transfer(PEER, BINANCE, 2_000_000_000, 310, "peer-binance")],
      }),
    ]);
    expect(report.cexDeposit).toBeNull();
    expect(report.cluster.id).toBe(`funder:${FUNDER}`);
    expect(report.shared).toEqual({ funder: [], cexDeposit: [] });
    expect(report.risk.level).toBe("medium");
    expect(report.risk.reasons).toContain(
      `This wallet sent 2 SOL straight to Binance hot wallet ${BINANCE}. That address is shared by many customers, so it is not a deposit-address cluster.`,
    );
    expect(report.risk.reasons).toContain("Checked 1 peer wallet. None share this funder or a CEX deposit address.");
  });

  it("prefers the larger swept deposit and ignores history that never reached the first transaction", () => {
    const report = assessFunding(WALLET, [
      {
        address: WALLET,
        historyComplete: false,
        transfers: [
          transfer(FUNDER, WALLET, 9_000_000_000, 50, "not-the-first"),
          transfer(WALLET, DEPOSIT, 1_000_000_000, 200, "small"),
          transfer(WALLET, DEPOSIT_B, 5_000_000_000, 220, "large"),
        ],
        recipientTransfers: [
          transfer(DEPOSIT, BINANCE, 1_000_000_000, 230, "sweep-small"),
          transfer(DEPOSIT_B, BINANCE, 5_000_000_000, 240, "sweep-large"),
        ],
      },
    ]);
    expect(report.funder).toBeNull();
    expect(report.historyComplete).toBe(false);
    expect(report.cexDeposit?.address).toBe(DEPOSIT_B);
    expect(report.cexDeposit?.amountSol).toBe(5);
    expect(report.cluster.id).toBe(`cex-deposit:${DEPOSIT_B}`);
    expect(report.risk.level).toBe("medium");
    expect(report.warnings).toContain(
      "Transaction history exceeds 5000 signatures, so the first SOL funder was not identified.",
    );
    expect(report.risk.reasons).toContain(
      "Transaction history exceeds 5000 signatures, so the first SOL funder was not identified.",
    );
  });

  it("says when the wallet has no real inbound SOL", () => {
    const report = assessFunding(WALLET, [activity(WALLET)]);
    expect(report.funder).toBeNull();
    expect(report.cluster.id).toBeNull();
    expect(report.risk.level).toBe("low");
    expect(report.risk.reasons).toEqual([
      "No inbound SOL transfer above 0.00001 SOL was found in this wallet's history.",
    ]);
  });

  it("parses system transfers, createAccount, and inner instructions without double counting", () => {
    const parsed = nativeTransfersFromParsed(
      {
        blockTime: 100,
        meta: {
          fee: 5000,
          preBalances: [2_000_005_000, 0],
          postBalances: [1_000_000_000, 1_000_000_000],
          innerInstructions: [
            {
              index: 1,
              instructions: [
                {
                  programId: SYSTEM,
                  parsed: {
                    type: "createAccount",
                    info: { source: FUNDER, newAccount: PEER, lamports: 890_880, space: 0, owner: SYSTEM },
                  },
                },
              ],
            },
          ],
        },
        transaction: {
          message: {
            accountKeys: [{ pubkey: FUNDER }, { pubkey: WALLET }],
            instructions: [
              {
                programId: SYSTEM,
                parsed: { type: "transfer", info: { source: FUNDER, destination: WALLET, lamports: 1_000_000_000 } },
              },
            ],
          },
        },
      },
      "sig-1",
    );
    expect(parsed).toEqual([
      { signature: "sig-1", blockTime: 100, from: FUNDER, to: WALLET, lamports: 1_000_000_000 },
      { signature: "sig-1", blockTime: 100, from: FUNDER, to: PEER, lamports: 890_880 },
    ]);

    const fromBalances = nativeTransfersFromParsed(
      {
        blockTime: 50,
        meta: {
          fee: 5000,
          preBalances: [2_000_000_000, 0],
          postBalances: [999_995_000, 1_000_000_000],
        },
        transaction: { message: { accountKeys: [FUNDER, WALLET] } },
      },
      "sig-2",
    );
    expect(fromBalances).toEqual([
      { signature: "sig-2", blockTime: 50, from: FUNDER, to: WALLET, lamports: 1_000_000_000 },
    ]);
  });

  it("rejects peer lists that are not Solana addresses", () => {
    expect(parsePeerList(undefined, WALLET)).toEqual({ peers: [] });
    expect(parsePeerList("  ,  ", WALLET)).toEqual({ peers: [] });
    expect(parsePeerList(` ${PEER}, ${PEER}, ${FUNDER} `, WALLET)).toEqual({ peers: [PEER, FUNDER] });
    expect(parsePeerList("not-a-wallet", WALLET)).toEqual({
      error: "peers must be a comma-separated list of Solana addresses.",
    });
    expect(parsePeerList(WALLET, WALLET)).toEqual({ error: "peers must not include the wallet address." });
    const extra = "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP";
    expect(parsePeerList([PEER, PEER_B, FUNDER, FUNDER_B, BINANCE, DEPOSIT, DEPOSIT_B, SYSTEM, extra].join(","), WALLET)).toEqual({
      error: "peers accepts at most 8 wallets.",
    });
  });
});

describe("funding loader", () => {
  it("pages to the oldest transfer and follows a deposit sweep to Binance", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = init?.body ? JSON.parse(String(init.body)) : null;
      const method = payload?.method;
      const address = payload?.params?.[0];
      let result: unknown;
      if (method === "getSignaturesForAddress" && address === WALLET) {
        result = [
          { signature: "new", blockTime: 300, err: null },
          { signature: "failed", blockTime: 200, err: { InstructionError: [0, "Custom"] } },
          { signature: "old", blockTime: 100, err: null },
        ];
      } else if (method === "getSignaturesForAddress" && address === DEPOSIT) {
        result = [{ signature: "sweep", blockTime: 400, err: null }];
      } else if (method === "getSignaturesForAddress") {
        result = [];
      } else if (method === "getTransaction" && payload.params?.[0] === "old") {
        result = systemTx(FUNDER, WALLET, 1_000_000_000, 100);
      } else if (method === "getTransaction" && payload.params?.[0] === "new") {
        result = systemTx(WALLET, DEPOSIT, 3_000_000_000, 300);
      } else if (method === "getTransaction" && payload.params?.[0] === "sweep") {
        result = systemTx(DEPOSIT, BINANCE, 3_000_000_000, 400);
      } else if (method === "getTransaction" && payload.params?.[0] === "failed") {
        throw new Error("failed signatures should not be fetched");
      } else {
        throw new Error(`unexpected ${method} ${address ?? payload?.params?.[0] ?? ""}`);
      }
      return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const env = loadEnv({
      X402_NETWORK: "devnet",
      WALLET_CLUSTER: "mainnet",
      SOLANA_RPC_URL: "https://rpc.test",
      HELIUS_API_KEY: "",
    });
    const report = await loadWalletFunding(env, WALLET, []);
    expect(report.funder?.address).toBe(FUNDER);
    expect(report.funder?.amountSol).toBe(1);
    expect(report.funder?.signature).toBe("old");
    expect(report.cexDeposit).toMatchObject({ address: DEPOSIT, exchange: "Binance", hotWallet: BINANCE, amountSol: 3 });
    expect(report.cluster.id).toBe(`cex-deposit:${DEPOSIT}`);
    expect(report.historyComplete).toBe(true);
    expect(report.sources).toEqual(["solana-rpc"]);
    expect(report.dataCluster).toBe("mainnet");
    expect(report.warnings).toEqual([]);
  });

  it("does not call a truncated window's oldest transfer the first funder", async () => {
    const fetched = new Set<string>();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = init?.body ? JSON.parse(String(init.body)) : null;
      const method = payload?.method;
      const address = payload?.params?.[0];
      let result: unknown = [];
      if (method === "getSignaturesForAddress" && address === WALLET) {
        const before = payload.params?.[1]?.before as string | undefined;
        const page = before ? Number(before.split("-")[1]) + 1 : 0;
        result = Array.from({ length: 1000 }, (_, index) => ({
          signature: index === 0 && page === 0 ? "recent-out" : `sig-${page}-${index}`,
          blockTime: 1_000_000 - page * 1000 - index,
          err: null,
        }));
      } else if (method === "getSignaturesForAddress" && address === DEPOSIT) {
        result = [{ signature: "sweep", blockTime: 500, err: null }];
      } else if (method === "getTransaction") {
        const signature = String(payload.params?.[0]);
        fetched.add(signature);
        if (signature === "recent-out") result = systemTx(WALLET, DEPOSIT, 2_000_000_000, 900_000);
        else if (signature === "sweep") result = systemTx(DEPOSIT, BINANCE, 2_000_000_000, 900_100);
        else result = systemTx(FUNDER, WALLET, 9_000_000_000, 1);
      } else {
        throw new Error(`unexpected ${method} ${address ?? ""}`);
      }
      return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const env = loadEnv({
      WALLET_CLUSTER: "mainnet",
      SOLANA_RPC_URL: "https://rpc.test",
    });
    const report = await loadWalletFunding(env, WALLET, []);
    expect(report.historyComplete).toBe(false);
    expect(report.funder).toBeNull();
    expect(report.cexDeposit?.address).toBe(DEPOSIT);
    expect(fetched.has("recent-out")).toBe(true);
    expect(fetched.has("sig-4-999")).toBe(false);
    expect(report.warnings[0]).toContain("5000 signatures");
  });
});

describe("llms.txt", () => {
  it("matches the generator for the public host and prices the funding route at $0.009", () => {
    const expected = buildLlmsTxt("https://solana-wallet-intel-phi.vercel.app", paidOperations(testEnv()));
    const file = readFileSync(new URL("../llms.txt", import.meta.url), "utf8");
    expect(file.trim()).toBe(expected.trim());
    expect(file).toContain("/wallet/funding");
    expect(file).toContain("$0.009");
    expect(file).toContain("9000");
    expect(file).toContain("wallet_funding");
    expect(file).toContain("$0.009");
    expect(file).toContain("$0.0018");
  });
});
