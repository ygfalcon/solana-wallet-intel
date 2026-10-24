import { cexExchange } from "./cex.js";
import { isSolanaAddress } from "./solana.js";

export const FUNDING_SIGNATURE_PAGE_SIZE = 1000;
export const FUNDING_MAX_SIGNATURE_PAGES = 5;
export const FUNDING_HISTORY_LIMIT = FUNDING_SIGNATURE_PAGE_SIZE * FUNDING_MAX_SIGNATURE_PAGES;
export const MAX_FUNDING_PEERS = 8;

const MIN_FUNDER_LAMPORTS = 10_000;
const MIN_OUTBOUND_LAMPORTS = 10_000_000;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export const FUNDING_DISCLAIMER =
  "This is a heuristic, not proof of common ownership. A shared personal funder or CEX deposit address is a risk signal. A shared exchange hot wallet is not.";

export type NativeTransfer = {
  signature: string;
  blockTime: number | null;
  from: string;
  to: string;
  lamports: number;
};

export type WalletActivity = {
  address: string;
  historyComplete: boolean;
  transfers: NativeTransfer[];
  recipientTransfers: NativeTransfer[];
};

export type FundingFunder = {
  address: string;
  amountSol: number;
  fundedAt: string | null;
  signature: string;
  exchange: string | null;
};

export type FundingDeposit = {
  address: string;
  exchange: string;
  hotWallet: string;
  amountSol: number;
  signature: string;
};

export type FundingReport = {
  address: string;
  summary: string;
  funder: FundingFunder | null;
  cexDeposit: FundingDeposit | null;
  cluster: {
    id: string | null;
    key: "funder" | "cex_deposit" | null;
    funderId: string | null;
    cexDepositId: string | null;
    members: string[];
  };
  shared: { funder: string[]; cexDeposit: string[] };
  risk: { level: "low" | "medium" | "high"; reasons: string[] };
  peersChecked: number;
  historyComplete: boolean;
  disclaimer: string;
  warnings: string[];
};

type ParsedInstruction = {
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
};

type ParsedTransaction = {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    innerInstructions?: Array<{ index?: number; instructions?: ParsedInstruction[] }>;
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
      instructions?: ParsedInstruction[];
    };
  };
};

type OutboundTotal = { lamports: number; signature: string; best: number };

type Facts = {
  address: string;
  historyComplete: boolean;
  funder: (FundingFunder & { lamports: number }) | null;
  cexDeposit: (FundingDeposit & { lamports: number }) | null;
  directCex: { address: string; exchange: string; amountSol: number; lamports: number } | null;
};

export function parsePeerList(
  value: string | undefined,
  primary: string,
): { peers: string[] } | { error: string } {
  if (!value?.trim()) return { peers: [] };
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const peers: string[] = [];
  for (const part of parts) {
    if (!isSolanaAddress(part)) {
      return { error: "peers must be a comma-separated list of Solana addresses." };
    }
    if (part === primary) return { error: "peers must not include the wallet address." };
    if (!peers.includes(part)) peers.push(part);
  }
  if (peers.length > MAX_FUNDING_PEERS) return { error: "peers accepts at most 8 wallets." };
  return { peers };
}

export function formatSol(lamports: number): string {
  const abs = Math.abs(Math.round(lamports));
  const whole = Math.floor(abs / 1_000_000_000);
  const frac = String(abs % 1_000_000_000)
    .padStart(9, "0")
    .replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : String(whole);
  return lamports < 0 ? `-${text}` : text;
}

function solNumber(lamports: number): number {
  return Number(formatSol(lamports));
}

function day(blockTime: number): string {
  return new Date(blockTime * 1000).toISOString().slice(0, 10);
}

function englishJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function peerNoun(count: number): string {
  return count === 1 ? "1 peer wallet" : `${count} peer wallets`;
}

function accountKey(key: string | { pubkey: string }): string {
  return typeof key === "string" ? key : key.pubkey;
}

function accountKeysOf(tx: ParsedTransaction): string[] {
  const messageKeys = (tx.transaction?.message?.accountKeys ?? []).map(accountKey);
  const balanceCount = tx.meta?.preBalances?.length ?? messageKeys.length;
  if (messageKeys.length >= balanceCount) return messageKeys;
  const keys = [...messageKeys];
  const loaded = [...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  for (const key of loaded) {
    if (keys.length >= balanceCount) break;
    keys.push(key);
  }
  return keys;
}

function pushTransfer(target: NativeTransfer[], signature: string, blockTime: number | null, from: unknown, to: unknown, lamports: unknown) {
  if (typeof from !== "string" || typeof to !== "string" || from === to) return;
  if (typeof lamports !== "number" || !Number.isFinite(lamports) || lamports <= 0) return;
  const duplicate = target.some((transfer) => transfer.from === from && transfer.to === to && transfer.lamports === lamports);
  if (duplicate) return;
  target.push({ signature, blockTime, from, to, lamports });
}

function readSystemInstruction(instruction: ParsedInstruction, signature: string, blockTime: number | null, target: NativeTransfer[]) {
  if (instruction.programId !== SYSTEM_PROGRAM || !instruction.parsed) return;
  const { type, info } = instruction.parsed;
  if (!info) return;
  if (type === "transfer" || type === "transferWithSeed") {
    pushTransfer(target, signature, blockTime, info.source, info.destination, info.lamports);
  } else if (type === "createAccount" || type === "createAccountWithSeed") {
    pushTransfer(target, signature, blockTime, info.source, info.newAccount, info.lamports);
  }
}

function transfersFromBalances(tx: ParsedTransaction, signature: string, blockTime: number | null): NativeTransfer[] {
  const meta = tx.meta;
  if (!meta?.preBalances || !meta.postBalances) return [];
  const keys = accountKeysOf(tx);
  const fee = meta.fee ?? 0;
  const deltas = keys.map((key, index) => {
    let delta = (meta.postBalances?.[index] ?? 0) - (meta.preBalances?.[index] ?? 0);
    if (index === 0) delta += fee;
    return { key, delta };
  });
  const senders = deltas.filter((delta) => delta.delta < 0);
  const receivers = deltas.filter((delta) => delta.delta > 0);
  if (senders.length !== 1 || receivers.length === 0) return [];
  const sent = -senders[0].delta;
  const received = receivers.reduce((sum, receiver) => sum + receiver.delta, 0);
  if (Math.abs(sent - received) > 1) return [];
  const transfers: NativeTransfer[] = [];
  for (const receiver of receivers) {
    pushTransfer(transfers, signature, blockTime, senders[0].key, receiver.key, receiver.delta);
  }
  return transfers;
}

export function nativeTransfersFromParsed(tx: ParsedTransaction, signature: string): NativeTransfer[] {
  if (!tx.meta || tx.meta.err) return [];
  const blockTime = tx.blockTime ?? null;
  const parsed: NativeTransfer[] = [];
  for (const instruction of tx.transaction?.message?.instructions ?? []) {
    readSystemInstruction(instruction, signature, blockTime, parsed);
  }
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const instruction of group.instructions ?? []) {
      readSystemInstruction(instruction, signature, blockTime, parsed);
    }
  }
  if (parsed.length > 0) return parsed;
  return transfersFromBalances(tx, signature, blockTime);
}

function earliestInbound(address: string, transfers: NativeTransfer[]): NativeTransfer | null {
  const inbound = transfers.filter(
    (transfer) =>
      transfer.to === address &&
      transfer.from !== address &&
      Number.isFinite(transfer.lamports) &&
      transfer.lamports >= MIN_FUNDER_LAMPORTS,
  );
  inbound.sort(
    (a, b) =>
      (a.blockTime ?? Number.MAX_SAFE_INTEGER) - (b.blockTime ?? Number.MAX_SAFE_INTEGER) ||
      a.signature.localeCompare(b.signature),
  );
  return inbound[0] ?? null;
}

function outboundTotals(address: string, transfers: NativeTransfer[]): Map<string, OutboundTotal> {
  const totals = new Map<string, OutboundTotal>();
  for (const transfer of transfers) {
    if (transfer.from !== address || transfer.to === address || !Number.isFinite(transfer.lamports) || transfer.lamports <= 0) {
      continue;
    }
    const current = totals.get(transfer.to);
    if (!current) {
      totals.set(transfer.to, { lamports: transfer.lamports, signature: transfer.signature, best: transfer.lamports });
      continue;
    }
    current.lamports += transfer.lamports;
    if (transfer.lamports > current.best) {
      current.best = transfer.lamports;
      current.signature = transfer.signature;
    }
  }
  return totals;
}

function sweepTarget(deposit: string, recipientTransfers: NativeTransfer[]): { hotWallet: string; exchange: string } | null {
  let best: { hotWallet: string; exchange: string; lamports: number } | null = null;
  for (const transfer of recipientTransfers) {
    if (transfer.from !== deposit) continue;
    const exchange = cexExchange(transfer.to);
    if (!exchange || !Number.isFinite(transfer.lamports)) continue;
    if (!best || transfer.lamports > best.lamports) {
      best = { hotWallet: transfer.to, exchange, lamports: transfer.lamports };
    }
  }
  return best ? { hotWallet: best.hotWallet, exchange: best.exchange } : null;
}

function factsFor(activity: WalletActivity): Facts {
  const inbound = activity.historyComplete ? earliestInbound(activity.address, activity.transfers) : null;
  const funder = inbound
    ? {
        address: inbound.from,
        amountSol: solNumber(inbound.lamports),
        fundedAt: inbound.blockTime == null ? null : new Date(inbound.blockTime * 1000).toISOString(),
        signature: inbound.signature,
        exchange: cexExchange(inbound.from),
        lamports: inbound.lamports,
      }
    : null;

  let cexDeposit: Facts["cexDeposit"] = null;
  let directCex: Facts["directCex"] = null;
  for (const [destination, total] of outboundTotals(activity.address, activity.transfers)) {
    if (total.lamports < MIN_OUTBOUND_LAMPORTS) continue;
    const exchange = cexExchange(destination);
    if (exchange) {
      if (!directCex || total.lamports > directCex.lamports) {
        directCex = { address: destination, exchange, amountSol: solNumber(total.lamports), lamports: total.lamports };
      }
      continue;
    }
    const sweep = sweepTarget(destination, activity.recipientTransfers);
    if (!sweep) continue;
    if (!cexDeposit || total.lamports > cexDeposit.lamports) {
      cexDeposit = {
        address: destination,
        exchange: sweep.exchange,
        hotWallet: sweep.hotWallet,
        amountSol: solNumber(total.lamports),
        signature: total.signature,
        lamports: total.lamports,
      };
    }
  }

  return { address: activity.address, historyComplete: activity.historyComplete, funder, cexDeposit, directCex };
}

function clusterChoice(facts: Facts): { id: string; key: "funder" | "cex_deposit" } | null {
  if (facts.cexDeposit) return { id: `cex-deposit:${facts.cexDeposit.address}`, key: "cex_deposit" };
  if (facts.funder && !facts.funder.exchange) return { id: `funder:${facts.funder.address}`, key: "funder" };
  return null;
}

function funderSentence(funder: FundingFunder & { lamports: number }): string {
  const when = funder.fundedAt ? day(Math.floor(new Date(funder.fundedAt).getTime() / 1000)) : "an unknown date";
  const amount = formatSol(funder.lamports);
  if (funder.exchange) {
    return `First SOL came from ${funder.exchange} hot wallet ${funder.address}: ${amount} SOL on ${when}. Many unrelated customers withdraw from that wallet, so it is not used as a cluster id.`;
  }
  return `First SOL came from ${funder.address}: ${amount} SOL on ${when}. That address is not a labeled exchange hot wallet.`;
}

export function assessFunding(primary: string, wallets: WalletActivity[]): FundingReport {
  const primaryActivity = wallets.find((wallet) => wallet.address === primary);
  if (!primaryActivity) throw new Error("primary wallet is missing from the funding set");
  const ordered = [
    primaryActivity,
    ...wallets.filter((wallet) => wallet !== primaryActivity && wallet.address !== primary),
  ];
  const facts = ordered.map(factsFor);
  const self = facts[0];
  const peers = facts.slice(1);
  const choice = clusterChoice(self);
  const members = facts
    .filter((wallet) => {
      const other = clusterChoice(wallet);
      return choice != null && other?.id === choice.id;
    })
    .map((wallet) => wallet.address);

  const sharedFunder =
    self.funder && !self.funder.exchange
      ? peers
          .filter((wallet) => wallet.funder && !wallet.funder.exchange && wallet.funder.address === self.funder?.address)
          .map((wallet) => wallet.address)
      : [];
  const sharedDeposit = self.cexDeposit
    ? peers.filter((wallet) => wallet.cexDeposit?.address === self.cexDeposit?.address).map((wallet) => wallet.address)
    : [];

  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!self.historyComplete) {
    const truncated = `Transaction history exceeds ${FUNDING_HISTORY_LIMIT} signatures, so the first SOL funder was not identified.`;
    reasons.push(truncated);
    warnings.push(truncated);
  }
  if (self.funder) reasons.push(funderSentence(self.funder));
  else if (self.historyComplete) {
    reasons.push("No inbound SOL transfer above 0.00001 SOL was found in this wallet's history.");
  }
  if (self.directCex) {
    reasons.push(
      `This wallet sent ${formatSol(self.directCex.lamports)} SOL straight to ${self.directCex.exchange} hot wallet ${self.directCex.address}. That address is shared by many customers, so it is not a deposit-address cluster.`,
    );
  }
  if (self.cexDeposit) {
    reasons.push(
      `This wallet sent ${formatSol(self.cexDeposit.lamports)} SOL to ${self.cexDeposit.address}, which later forwarded SOL to ${self.cexDeposit.exchange} hot wallet ${self.cexDeposit.hotWallet}. That looks like a ${self.cexDeposit.exchange} deposit address.`,
    );
  }
  if (sharedFunder.length > 0) {
    const verb = sharedFunder.length === 1 ? "shares" : "share";
    reasons.push(
      `${englishJoin(sharedFunder)} ${verb} that first SOL funder. Wallets opened by the same funder are often one operator or a sybil set.`,
    );
  }
  if (sharedDeposit.length > 0 && self.cexDeposit) {
    reasons.push(
      `${englishJoin(sharedDeposit)} sent SOL to the same ${self.cexDeposit.exchange} deposit address. Shared exchange deposit addresses usually belong to one account.`,
    );
  }
  if (self.funder?.exchange) {
    const sameExchange = peers.filter((wallet) => wallet.funder?.address === self.funder?.address).length;
    if (sameExchange > 0) {
      const subject = sameExchange === 1 ? "1 peer wallet was" : `${sameExchange} peer wallets were`;
      reasons.push(
        `${subject} also funded by ${self.funder.exchange} hot wallet ${self.funder.address}. They are not clustered together.`,
      );
    }
  }
  if (peers.length > 0 && sharedDeposit.length === 0 && sharedFunder.length === 0) {
    reasons.push(`Checked ${peerNoun(peers.length)}. None share this funder or a CEX deposit address.`);
  } else if (peers.length > 0 && sharedDeposit.length === 0 && sharedFunder.length > 0) {
    reasons.push(`Checked ${peerNoun(peers.length)}. None share a CEX deposit address.`);
  }
  if (choice && members.length > 1) reasons.push(`Cluster id is ${choice.id}.`);
  else if (choice?.key === "funder") {
    reasons.push(`Cluster id ${choice.id} matches any other wallet with the same first funder.`);
  } else if (choice?.key === "cex_deposit") {
    reasons.push(`Cluster id ${choice.id} matches any wallet that sends to the same deposit address.`);
  }

  const level: FundingReport["risk"]["level"] =
    sharedFunder.length > 0 || sharedDeposit.length > 0
      ? "high"
      : !self.historyComplete || self.funder?.exchange || self.cexDeposit || self.directCex
        ? "medium"
        : "low";

  return {
    address: primary,
    summary: reasons.join(" "),
    funder: self.funder
      ? {
          address: self.funder.address,
          amountSol: self.funder.amountSol,
          fundedAt: self.funder.fundedAt,
          signature: self.funder.signature,
          exchange: self.funder.exchange,
        }
      : null,
    cexDeposit: self.cexDeposit
      ? {
          address: self.cexDeposit.address,
          exchange: self.cexDeposit.exchange,
          hotWallet: self.cexDeposit.hotWallet,
          amountSol: self.cexDeposit.amountSol,
          signature: self.cexDeposit.signature,
        }
      : null,
    cluster: {
      id: choice?.id ?? null,
      key: choice?.key ?? null,
      funderId: self.funder && !self.funder.exchange ? `funder:${self.funder.address}` : null,
      cexDepositId: self.cexDeposit ? `cex-deposit:${self.cexDeposit.address}` : null,
      members: choice ? members : [],
    },
    shared: { funder: sharedFunder, cexDeposit: sharedDeposit },
    risk: { level, reasons },
    peersChecked: peers.length,
    historyComplete: self.historyComplete,
    disclaimer: FUNDING_DISCLAIMER,
    warnings,
  };
}
