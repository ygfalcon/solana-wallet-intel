import { base58 } from "@scure/base";

export const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const ORCA_WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export const METEORA_DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

export const LP_BURN_AUTHORITIES = [
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
] as const;

/** Programs whose PDAs hold LP as a lock, from Raydium, Streamflow, and UNCX docs. */
export const LP_LOCKER_PROGRAMS = [
  "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE",
  "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m",
  "strmdbLr6w7QNmsiEXyFwWg3VSfg1GiELgU27P8aCGw",
  "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo",
  "UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN",
  "UNCXdvMRxvz91g3HqFmpZ5NgmL77UH4QRM4NfeL4mQB",
  "UNCXrB8cZXnmtYM1aSo1Wx3pQaeSZYuF2jCTesXvECs",
  "uNCXmCod5WAkjfkNJPMZ9WRKDNiwQnM778RVbP17a6U",
  "unCXpWPXnYnP9i6E8JeVy7nkv4B9PW9uvudakMLLzdQ",
] as const;

const CONCENTRATED = new Set<string>([RAYDIUM_CLMM, ORCA_WHIRLPOOL, METEORA_DLMM]);
const BURN = new Set<string>(LP_BURN_AUTHORITIES);
const LOCKERS = new Set<string>(LP_LOCKER_PROGRAMS);

export type LpStatus = "burned" | "locked" | "unlocked" | "concentrated" | "unknown";

export type TokenChecks = {
  holders: { top10Share: number | null; note: string };
  authorities: { mintAuthority: string | null; freezeAuthority: string | null; note: string };
  lp: { status: LpStatus; note: string };
  snipers: { share: number | null; note: string };
};

type PoolRead =
  | { kind: "standard"; lpMint: string; vaults: string[] }
  | { kind: "concentrated" }
  | { kind: "unknown" };

function roundShare(share: number): number {
  return Math.round(share * 10_000) / 10_000;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function readPubkey(data: Uint8Array, offset: number): string | null {
  if (offset < 0 || data.length < offset + 32) return null;
  return base58.encode(data.subarray(offset, offset + 32));
}

export function readPoolLp(ownerProgram: string, data: Uint8Array): PoolRead {
  if (CONCENTRATED.has(ownerProgram)) return { kind: "concentrated" };
  if (ownerProgram === RAYDIUM_AMM_V4) {
    const lpOffset = 32 * 8 + (16 + 16 + 8 + 16 + 16 + 8) + 32 * 4;
    const lpMint = readPubkey(data, lpOffset);
    const baseVault = readPubkey(data, lpOffset - 32 * 4);
    const quoteVault = readPubkey(data, lpOffset - 32 * 3);
    if (!lpMint || !baseVault || !quoteVault) return { kind: "unknown" };
    return { kind: "standard", lpMint, vaults: [baseVault, quoteVault] };
  }
  if (ownerProgram === RAYDIUM_CPMM) {
    const lpMint = readPubkey(data, 8 + 32 * 4);
    const vault0 = readPubkey(data, 8 + 32 * 2);
    const vault1 = readPubkey(data, 8 + 32 * 3);
    if (!lpMint || !vault0 || !vault1) return { kind: "unknown" };
    return { kind: "standard", lpMint, vaults: [vault0, vault1] };
  }
  return { kind: "unknown" };
}

export function assessHolders(input: {
  supply: number | null;
  accounts: { address: string; amount: number }[];
  exclude?: string[];
}): { top10Share: number | null; note: string; riskFlags: string[] } {
  if (input.supply == null || !Number.isFinite(input.supply) || input.supply <= 0) {
    return { top10Share: null, note: "Holder concentration could not be measured.", riskFlags: [] };
  }
  if (input.accounts.some((account) => !Number.isFinite(account.amount) || account.amount < 0)) {
    return { top10Share: null, note: "Holder concentration could not be measured.", riskFlags: [] };
  }
  const excluded = new Set(input.exclude ?? []);
  const top = input.accounts
    .filter((account) => !excluded.has(account.address))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);
  const share = roundShare(top.reduce((sum, account) => sum + account.amount, 0) / input.supply);
  const note = `Top 10 holders control ${percent(share)} of supply.`;
  return { top10Share: share, note, riskFlags: share >= 0.5 ? [note] : [] };
}

export function assessAuthorities(input: {
  readable: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}): { mintAuthority: string | null; freezeAuthority: string | null; note: string; riskFlags: string[] } {
  if (!input.readable) {
    return {
      mintAuthority: null,
      freezeAuthority: null,
      note: "Mint and freeze authority could not be read.",
      riskFlags: [],
    };
  }
  const riskFlags: string[] = [];
  const notes: string[] = [];
  if (input.mintAuthority) {
    const flag = "Mint authority is still active, so the issuer can create more tokens.";
    notes.push(flag);
    riskFlags.push(flag);
  } else notes.push("Mint authority is revoked.");
  if (input.freezeAuthority) {
    const flag = "Freeze authority is still active, so the issuer can freeze token accounts.";
    notes.push(flag);
    riskFlags.push(flag);
  } else notes.push("Freeze authority is revoked.");
  return {
    mintAuthority: input.mintAuthority,
    freezeAuthority: input.freezeAuthority,
    note: notes.join(" "),
    riskFlags,
  };
}

export function assessLp(input: {
  kind: "standard" | "concentrated" | "unknown";
  supply: number | null;
  holders: { owner: string; amount: number; ownerProgram: string | null }[];
}): { status: LpStatus; note: string; riskFlags: string[] } {
  if (input.kind === "concentrated") {
    return {
      status: "concentrated",
      note: "This pool uses concentrated liquidity, so there is no single LP token to lock or burn.",
      riskFlags: [],
    };
  }
  if (input.kind === "unknown" || input.supply == null || !Number.isFinite(input.supply) || input.supply <= 0) {
    return {
      status: "unknown",
      note: "LP lock or burn status could not be read for this pool.",
      riskFlags: [],
    };
  }
  const burned = input.holders.filter((holder) => BURN.has(holder.owner)).reduce((sum, holder) => sum + holder.amount, 0);
  if (burned * 100 >= input.supply * 95) {
    return {
      status: "burned",
      note: `LP is burned. Burn addresses hold ${percent(burned / input.supply)} of the LP supply.`,
      riskFlags: [],
    };
  }
  const locked = input.holders
    .filter((holder) => (holder.ownerProgram != null && LOCKERS.has(holder.ownerProgram)) || LOCKERS.has(holder.owner))
    .reduce((sum, holder) => sum + holder.amount, 0);
  if (locked * 100 >= input.supply * 95) {
    return {
      status: "locked",
      note: `LP is locked. A known locker holds ${percent(locked / input.supply)} of the LP supply.`,
      riskFlags: [],
    };
  }
  const largest = [...input.holders].sort((a, b) => b.amount - a.amount)[0];
  return {
    status: "unlocked",
    note: largest
      ? `LP is held by ${largest.owner}, which is not a known burn address or locker.`
      : "LP is unlocked, so liquidity can be pulled.",
    riskFlags: ["LP is unlocked, so liquidity can be pulled."],
  };
}

export function assessSnipers(input: {
  measured: boolean;
  supply: number | null;
  creationSlot?: number | null;
  buys: { wallet: string; slot: number; amount: number }[];
}): { share: number | null; note: string; riskFlags: string[] } {
  if (!input.measured || input.supply == null || !Number.isFinite(input.supply) || input.supply <= 0) {
    return { share: null, note: "Sniper and bundle share of early supply could not be measured.", riskFlags: [] };
  }
  const buys = input.buys.filter((buy) => Number.isFinite(buy.amount) && buy.amount > 0 && Number.isFinite(buy.slot));
  const creationSlot =
    input.creationSlot != null && Number.isFinite(input.creationSlot)
      ? input.creationSlot
      : buys.reduce<number | null>((min, buy) => (min == null || buy.slot < min ? buy.slot : min), null);
  const buyersBySlot = new Map<number, Set<string>>();
  for (const buy of buys) {
    const buyers = buyersBySlot.get(buy.slot) ?? new Set<string>();
    buyers.add(buy.wallet);
    buyersBySlot.set(buy.slot, buyers);
  }
  const bundleSlots = new Set(
    [...buyersBySlot.entries()].filter(([, buyers]) => buyers.size >= 3).map(([slot]) => slot),
  );
  const qualifying = buys.filter((buy) => {
    const sniper = creationSlot != null && (buy.slot === creationSlot || buy.slot === creationSlot + 1);
    return sniper || bundleSlots.has(buy.slot);
  });
  const amount = qualifying.reduce((sum, buy) => sum + buy.amount, 0);
  const share = roundShare(amount / input.supply);
  const note = `Snipers and bundled wallets took ${percent(share)} of supply in the earliest slots.`;
  return { share, note, riskFlags: share >= 0.2 ? [note] : [] };
}

type TokenBalance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { uiAmount?: number | null; uiAmountString?: string; amount?: string; decimals?: number };
};

export function inflowsForMint(
  tx: {
    meta?: { err?: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
    transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } };
  },
  mint: string,
  excludeAccounts: string[],
): { wallet: string; amount: number }[] {
  if (!tx.meta || tx.meta.err) return [];
  const excluded = new Set(excludeAccounts);
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((key) => (typeof key === "string" ? key : key.pubkey));
  const totals = new Map<string, { pre: number; post: number }>();
  const add = (balances: TokenBalance[] | undefined, side: "pre" | "post") => {
    for (const balance of balances ?? []) {
      if (balance.mint !== mint || balance.accountIndex == null || !balance.owner) continue;
      const account = keys[balance.accountIndex];
      if (!account || excluded.has(account)) continue;
      const amount = uiAmount(balance.uiTokenAmount);
      if (amount == null) continue;
      const row = totals.get(balance.owner) ?? { pre: 0, post: 0 };
      row[side] += amount;
      totals.set(balance.owner, row);
    }
  };
  add(tx.meta.preTokenBalances, "pre");
  add(tx.meta.postTokenBalances, "post");
  return [...totals.entries()]
    .map(([wallet, row]) => ({ wallet, amount: row.post - row.pre }))
    .filter((row) => row.amount > 0);
}

function uiAmount(amount: TokenBalance["uiTokenAmount"]): number | null {
  if (!amount) return null;
  if (typeof amount.uiAmount === "number" && Number.isFinite(amount.uiAmount)) return amount.uiAmount;
  if (typeof amount.uiAmountString === "string" && amount.uiAmountString.trim()) {
    const parsed = Number(amount.uiAmountString);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof amount.amount === "string" && typeof amount.decimals === "number") {
    const parsed = Number(amount.amount) / 10 ** amount.decimals;
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
