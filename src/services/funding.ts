import type { AppEnv } from "../config.js";
import { cexExchange } from "../cex.js";
import {
  assessFunding,
  FUNDING_MAX_SIGNATURE_PAGES,
  FUNDING_SIGNATURE_PAGE_SIZE,
  nativeTransfersFromParsed,
  type FundingReport,
  type NativeTransfer,
  type WalletActivity,
} from "../funding.js";
import { fetchJson, UpstreamError } from "../http.js";

const RECENT_TRANSACTIONS = 20;
const OLDEST_TRANSACTIONS = 8;
const MAX_DEPOSIT_TRACES = 3;
const MIN_TRACE_LAMPORTS = 10_000_000;

type SignatureRow = { signature: string; blockTime: number | null; err?: unknown };
type RpcResponse<T> = { result?: T; error?: { message?: string } };

export type WalletFunding = FundingReport & {
  asOf: string;
  dataCluster: AppEnv["walletCluster"];
  sources: string[];
};

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const body = await fetchJson<RpcResponse<T>>(url, {
    source: "solana-rpc",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (body.error) throw new UpstreamError(body.error.message ?? "RPC error", "solana-rpc");
  return body.result as T;
}

async function signaturesFor(env: AppEnv, address: string, limit: number, before?: string): Promise<SignatureRow[]> {
  const config: { limit: number; before?: string } = { limit };
  if (before) config.before = before;
  const rows = await rpc<SignatureRow[] | null>(env.solanaRpcUrl, "getSignaturesForAddress", [address, config]);
  return rows ?? [];
}

async function pageSignatures(env: AppEnv, address: string): Promise<{ signatures: SignatureRow[]; exhausted: boolean }> {
  const signatures: SignatureRow[] = [];
  let before: string | undefined;
  for (let page = 0; page < FUNDING_MAX_SIGNATURE_PAGES; page += 1) {
    const batch = await signaturesFor(env, address, FUNDING_SIGNATURE_PAGE_SIZE, before);
    signatures.push(...batch);
    if (batch.length < FUNDING_SIGNATURE_PAGE_SIZE) return { signatures, exhausted: true };
    before = batch[batch.length - 1]?.signature;
    if (!before) return { signatures, exhausted: true };
  }
  return { signatures, exhausted: false };
}

async function transfersFor(env: AppEnv, rows: SignatureRow[]): Promise<NativeTransfer[]> {
  const transfers: NativeTransfer[] = [];
  await Promise.all(
    rows.map(async (row) => {
      if (row.err) return;
      const tx = await rpc<Parameters<typeof nativeTransfersFromParsed>[0] | null>(env.solanaRpcUrl, "getTransaction", [
        row.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
      if (!tx) return;
      transfers.push(...nativeTransfersFromParsed(tx, row.signature));
    }),
  );
  return transfers;
}

async function activityFor(env: AppEnv, address: string): Promise<{ activity: WalletActivity; warnings: string[] }> {
  const warnings: string[] = [];
  const { signatures, exhausted } = await pageSignatures(env, address);
  const successful = signatures.filter((row) => !row.err);
  const recent = successful.slice(0, RECENT_TRANSACTIONS);
  const oldest = exhausted ? [...successful].reverse().slice(0, OLDEST_TRANSACTIONS) : [];
  const wanted = new Map<string, SignatureRow>();
  for (const row of [...oldest, ...recent]) wanted.set(row.signature, row);
  const transfers = await transfersFor(env, [...wanted.values()]);

  const outbound = new Map<string, number>();
  for (const transfer of transfers) {
    if (transfer.from !== address || transfer.to === address || cexExchange(transfer.to)) continue;
    if (transfer.lamports < MIN_TRACE_LAMPORTS) continue;
    outbound.set(transfer.to, (outbound.get(transfer.to) ?? 0) + transfer.lamports);
  }
  const candidates = [...outbound.entries()].sort((a, b) => b[1] - a[1]);
  if (candidates.length > MAX_DEPOSIT_TRACES) {
    warnings.push(`Only the ${MAX_DEPOSIT_TRACES} largest outbound SOL recipients were checked for an exchange sweep.`);
  }
  const recipientTransfers: NativeTransfer[] = [];
  for (const [deposit] of candidates.slice(0, MAX_DEPOSIT_TRACES)) {
    const rows = await signaturesFor(env, deposit, RECENT_TRANSACTIONS);
    recipientTransfers.push(...(await transfersFor(env, rows.filter((row) => !row.err).slice(0, OLDEST_TRANSACTIONS))));
  }

  return {
    activity: { address, historyComplete: exhausted, transfers, recipientTransfers },
    warnings,
  };
}

export async function loadWalletFunding(env: AppEnv, address: string, peers: string[]): Promise<WalletFunding> {
  const loaded = [];
  for (const wallet of [address, ...peers]) loaded.push(await activityFor(env, wallet));
  const report = assessFunding(
    address,
    loaded.map((item) => item.activity),
  );
  const warnings = [...report.warnings, ...loaded.flatMap((item) => item.warnings)];
  return {
    ...report,
    warnings,
    asOf: new Date().toISOString(),
    dataCluster: env.walletCluster,
    sources: ["solana-rpc"],
  };
}
