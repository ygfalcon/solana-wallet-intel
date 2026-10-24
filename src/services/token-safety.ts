import type { TrendingToken } from "./trending.js";
import {
  assessAuthorities,
  assessHolders,
  assessLp,
  assessSnipers,
  inflowsForMint,
  readPoolLp,
  type TokenChecks,
} from "../token-risk.js";

export type SafetyRpc = {
  batch(requests: Array<{ method: string; params: unknown[] }>): Promise<unknown[]>;
};

type SignatureRow = { signature?: string; slot?: number; err?: unknown };

const EARLY_TX_CAP = 40;
const SIGNATURE_PAGE = 1_000;

export async function enrichTrendingTokens<T extends TrendingToken>(tokens: T[], rpc: SafetyRpc): Promise<Array<T & { checks: TokenChecks }>> {
  if (tokens.length === 0) return [];
  try {
    return await enrich(tokens, rpc);
  } catch {
    return tokens.map((token) => attach(token, unreadable()));
  }
}

async function enrich<T extends TrendingToken>(tokens: T[], rpc: SafetyRpc): Promise<Array<T & { checks: TokenChecks }>> {
  const requests: Array<{ method: string; params: unknown[] }> = [];
  for (const token of tokens) {
    requests.push(
      { method: "getAccountInfo", params: [token.mint, { encoding: "jsonParsed" }] },
      { method: "getTokenSupply", params: [token.mint] },
      { method: "getTokenLargestAccounts", params: [token.mint] },
    );
    if (token.pairAddress) requests.push({ method: "getAccountInfo", params: [token.pairAddress, { encoding: "base64" }] });
  }
  const base = await rpc.batch(requests);
  let cursor = 0;
  const drafts = tokens.map((token) => {
    const mintAccount = base[cursor];
    const supply = base[cursor + 1];
    const largest = base[cursor + 2];
    cursor += 3;
    const pairAccount = token.pairAddress ? base[cursor++] : null;
    const pool = decodePool(pairAccount);
    return { token, mintAccount, supply, largest, pool };
  });

  const lpMints = [...new Set(drafts.flatMap((draft) => (draft.pool.kind === "standard" ? [draft.pool.lpMint] : [])))];
  const lpSupply = new Map<string, unknown>();
  const lpLargest = new Map<string, unknown>();
  if (lpMints.length > 0) {
    const lpRows = await rpc.batch(
      lpMints.flatMap((mint) => [
        { method: "getTokenSupply", params: [mint] },
        { method: "getTokenLargestAccounts", params: [mint] },
      ]),
    );
    lpMints.forEach((mint, index) => {
      lpSupply.set(mint, lpRows[index * 2]);
      lpLargest.set(mint, lpRows[index * 2 + 1]);
    });
  }

  const lpAccounts = [
    ...new Set(
      lpMints.flatMap((mint) => (largestAccounts(lpLargest.get(mint)) ?? []).map((account) => account.address)),
    ),
  ];
  const lpOwners = await accountOwners(rpc, lpAccounts);
  const ownerPrograms = await accountPrograms(rpc, [...new Set([...lpOwners.values()].filter((owner): owner is string => Boolean(owner)))]);

  const signatures = new Map<string, { measured: boolean; rows: SignatureRow[] }>();
  const firstPages = await rpc.batch(
    tokens.map((token) => ({ method: "getSignaturesForAddress", params: [token.mint, { limit: SIGNATURE_PAGE }] })),
  );
  const continued: string[] = [];
  tokens.forEach((token, index) => {
    const page = asSignatures(firstPages[index]);
    if (page == null) signatures.set(token.mint, { measured: false, rows: [] });
    else if (page.length >= SIGNATURE_PAGE) continued.push(token.mint);
    else signatures.set(token.mint, { measured: true, rows: page });
  });
  if (continued.length > 0) {
    const second = await rpc.batch(
      continued.map((mint) => {
        const page = asSignatures(firstPages[tokens.findIndex((token) => token.mint === mint)]) ?? [];
        const before = page[page.length - 1]?.signature;
        return { method: "getSignaturesForAddress", params: [mint, { limit: SIGNATURE_PAGE, before }] };
      }),
    );
    continued.forEach((mint, index) => {
      const first = asSignatures(firstPages[tokens.findIndex((token) => token.mint === mint)]) ?? [];
      const extra = asSignatures(second[index]);
      const measured = extra != null && extra.length < SIGNATURE_PAGE;
      signatures.set(mint, { measured, rows: measured && extra ? [...first, ...extra] : [] });
    });
  }

  const txPlans = drafts.map((draft) => planEarlyTransactions(signatures.get(draft.token.mint)));
  const wanted = txPlans.flatMap((plan, index) =>
    plan.measured ? plan.rows.map((row) => ({ mint: drafts[index].token.mint, signature: row.signature as string, slot: row.slot as number })) : [],
  );
  const transactions = new Map<string, unknown>();
  if (wanted.length > 0) {
    const rows = await rpc.batch(
      wanted.map((row) => ({
        method: "getTransaction",
        params: [row.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
      })),
    );
    wanted.forEach((row, index) => transactions.set(row.signature, rows[index]));
  }

  return drafts.map((draft, index) => {
    const supply = tokenUiAmount(draft.supply);
    const holderAccounts = largestAccounts(draft.largest);
    const holders =
      holderAccounts == null
        ? { top10Share: null, note: "Holder concentration could not be measured.", riskFlags: [] as string[] }
        : assessHolders({
            supply,
            accounts: holderAccounts,
            exclude: draft.pool.kind === "standard" ? draft.pool.vaults : [],
          });
    const info = mintInfo(draft.mintAccount);
    const authorities = assessAuthorities({
      readable: info != null,
      mintAuthority: info?.mintAuthority ?? null,
      freezeAuthority: info?.freezeAuthority ?? null,
    });
    const lp = assessLp(lpInput(draft.pool, lpSupply, lpLargest, lpOwners, ownerPrograms));
    const plan = txPlans[index];
    const missingTransaction = plan.rows.some((row) => {
      const tx = transactions.get(row.signature as string);
      return tx == null || typeof tx !== "object";
    });
    const buys =
      plan.measured && !missingTransaction
        ? plan.rows.flatMap((row) => {
            const tx = transactions.get(row.signature as string);
            const exclude = draft.pool.kind === "standard" ? draft.pool.vaults : [];
            return inflowsForMint(tx as Parameters<typeof inflowsForMint>[0], draft.token.mint, exclude).map((inflow) => ({
              wallet: inflow.wallet,
              amount: inflow.amount,
              slot: row.slot as number,
            }));
          })
        : [];
    const snipers = assessSnipers({
      measured: plan.measured && !missingTransaction,
      supply,
      creationSlot: plan.creationSlot,
      buys,
    });
    const checks: TokenChecks = {
      holders: { top10Share: holders.top10Share, note: holders.note },
      authorities: {
        mintAuthority: authorities.mintAuthority,
        freezeAuthority: authorities.freezeAuthority,
        note: authorities.note,
      },
      lp: { status: lp.status, note: lp.note },
      snipers: { share: snipers.share, note: snipers.note },
    };
    return attach(draft.token, checks, [
      ...holders.riskFlags,
      ...authorities.riskFlags,
      ...lp.riskFlags,
      ...snipers.riskFlags,
    ]);
  });
}

function attach<T extends TrendingToken>(token: T, checks: TokenChecks, riskFlags: string[] = []): T & { checks: TokenChecks } {
  return { ...token, checks, riskFlags: [...token.riskFlags, ...riskFlags] };
}

function unreadable(): TokenChecks {
  return {
    holders: { top10Share: null, note: "Holder concentration could not be measured." },
    authorities: { mintAuthority: null, freezeAuthority: null, note: "Mint and freeze authority could not be read." },
    lp: { status: "unknown", note: "LP lock or burn status could not be read for this pool." },
    snipers: { share: null, note: "Sniper and bundle share of early supply could not be measured." },
  };
}

function decodePool(account: unknown): ReturnType<typeof readPoolLp> {
  const value = (account as { value?: { owner?: string; data?: [string, string] } | null } | null)?.value;
  if (!value?.owner || !value.data?.[0]) return { kind: "unknown" };
  try {
    return readPoolLp(value.owner, Uint8Array.from(Buffer.from(value.data[0], "base64")));
  } catch {
    return { kind: "unknown" };
  }
}

function mintInfo(account: unknown): { mintAuthority: string | null; freezeAuthority: string | null } | null {
  const info = (account as { value?: { data?: { parsed?: { info?: { mintAuthority?: unknown; freezeAuthority?: unknown } } } } } | null)
    ?.value?.data?.parsed?.info;
  if (!info) return null;
  return {
    mintAuthority: typeof info.mintAuthority === "string" ? info.mintAuthority : null,
    freezeAuthority: typeof info.freezeAuthority === "string" ? info.freezeAuthority : null,
  };
}

function tokenUiAmount(supply: unknown): number | null {
  const value = (supply as { value?: { uiAmount?: number | null; uiAmountString?: string; amount?: string; decimals?: number } } | null)
    ?.value;
  if (!value) return null;
  if (typeof value.uiAmount === "number" && Number.isFinite(value.uiAmount)) return value.uiAmount;
  if (typeof value.uiAmountString === "string" && Number.isFinite(Number(value.uiAmountString))) return Number(value.uiAmountString);
  if (typeof value.amount === "string" && typeof value.decimals === "number") {
    const parsed = Number(value.amount) / 10 ** value.decimals;
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function largestAccounts(payload: unknown): { address: string; amount: number }[] | null {
  if (payload == null || typeof payload !== "object") return null;
  const value = (payload as { value?: Array<{ address?: string; uiAmount?: number | null; amount?: string; decimals?: number }> }).value;
  if (!Array.isArray(value)) return null;
  const accounts: { address: string; amount: number }[] = [];
  for (const row of value) {
    if (!row.address) continue;
    let amount: number | null = null;
    if (typeof row.uiAmount === "number" && Number.isFinite(row.uiAmount)) amount = row.uiAmount;
    else if (typeof row.amount === "string" && typeof row.decimals === "number") amount = Number(row.amount) / 10 ** row.decimals;
    if (amount == null || !Number.isFinite(amount)) return null;
    accounts.push({ address: row.address, amount });
  }
  return accounts;
}

async function accountOwners(rpc: SafetyRpc, addresses: string[]): Promise<Map<string, string | null>> {
  const owners = new Map<string, string | null>();
  for (const slice of chunks(addresses, 100)) {
    const rows = await rpc.batch([{ method: "getMultipleAccounts", params: [slice, { encoding: "jsonParsed" }] }]);
    const value = (rows[0] as { value?: Array<{ data?: { parsed?: { info?: { owner?: string } } } } | null> } | null)?.value;
    slice.forEach((address, index) => {
      const owner = value?.[index]?.data?.parsed?.info?.owner;
      owners.set(address, typeof owner === "string" ? owner : null);
    });
  }
  return owners;
}

async function accountPrograms(rpc: SafetyRpc, addresses: string[]): Promise<Map<string, string | null>> {
  const programs = new Map<string, string | null>();
  for (const slice of chunks(addresses, 100)) {
    const rows = await rpc.batch([{ method: "getMultipleAccounts", params: [slice, { encoding: "base64" }] }]);
    const value = (rows[0] as { value?: Array<{ owner?: string } | null> } | null)?.value;
    slice.forEach((address, index) => {
      const owner = value?.[index]?.owner;
      programs.set(address, typeof owner === "string" ? owner : null);
    });
  }
  return programs;
}

function chunks<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let start = 0; start < values.length; start += size) groups.push(values.slice(start, start + size));
  return groups;
}

function lpInput(
  pool: ReturnType<typeof readPoolLp>,
  lpSupply: Map<string, unknown>,
  lpLargest: Map<string, unknown>,
  lpOwners: Map<string, string | null>,
  ownerPrograms: Map<string, string | null>,
) {
  if (pool.kind === "concentrated") return { kind: "concentrated" as const, supply: null, holders: [] };
  if (pool.kind !== "standard") return { kind: "unknown" as const, supply: null, holders: [] };
  const supply = tokenUiAmount(lpSupply.get(pool.lpMint));
  const rows = largestAccounts(lpLargest.get(pool.lpMint));
  if (supply == null || rows == null) return { kind: "unknown" as const, supply: null, holders: [] };
  const holders = rows.map((account) => {
    const owner = lpOwners.get(account.address) ?? null;
    return { owner: owner ?? account.address, amount: account.amount, ownerProgram: owner ? (ownerPrograms.get(owner) ?? null) : null };
  });
  return { kind: "standard" as const, supply, holders };
}

function asSignatures(payload: unknown): SignatureRow[] | null {
  return Array.isArray(payload) ? (payload as SignatureRow[]) : null;
}

function planEarlyTransactions(page: { measured: boolean; rows: SignatureRow[] } | undefined): {
  measured: boolean;
  creationSlot: number | null;
  rows: SignatureRow[];
} {
  if (!page?.measured) return { measured: false, creationSlot: null, rows: [] };
  const rows = page.rows.filter((row) => row.signature && row.slot != null && !row.err);
  if (rows.length === 0) return { measured: true, creationSlot: null, rows: [] };
  const oldestFirst = [...rows].reverse();
  const creationSlot = oldestFirst[0].slot as number;
  const inWindow = oldestFirst.filter((row) => (row.slot as number) <= creationSlot + 1);
  const counts = new Map<number, number>();
  for (const row of oldestFirst) counts.set(row.slot as number, (counts.get(row.slot as number) ?? 0) + 1);
  const earlySlots = new Set(oldestFirst.slice(0, EARLY_TX_CAP).map((row) => row.slot as number));
  const bundled = oldestFirst.filter((row) => earlySlots.has(row.slot as number) && (counts.get(row.slot as number) ?? 0) >= 3);
  const selected = new Map<string, SignatureRow>();
  for (const row of [...inWindow, ...bundled]) selected.set(row.signature as string, row);
  if (selected.size > EARLY_TX_CAP) return { measured: false, creationSlot, rows: [] };
  return { measured: true, creationSlot, rows: [...selected.values()] };
}
