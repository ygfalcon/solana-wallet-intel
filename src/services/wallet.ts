import { QUOTE_MINTS, type AppEnv } from "../config.js";
import {
  describeWallet,
  estimatePnl,
  isSpeculativeSwap,
  isStableMint,
  isTwoSided,
  medianGapSeconds,
  netLegs,
  summarizeWallet,
  type TradeEvent,
  type TradeLeg,
} from "../analytics.js";
import { fetchJson, redactSecrets, UpstreamError } from "../http.js";
import { mapPool } from "../pool.js";
import { solanaRpc } from "../solana-rpc.js";
import {
  accumulateHoldings,
  holdingFromAsset,
  isLikelyNft,
  nativeSolHolding,
  parseUiAmount,
  presentHoldings,
  type AssetLike,
  type RawHolding,
} from "../holdings.js";
import { SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../solana.js";
import { positiveUsd, loadTokenMeta } from "./prices.js";
import { closeAt, loadSolUsdSeries } from "./sol-history.js";
import { scoreCopyTrade, type CopyTradeAssessment, type CopyTradeGrade } from "../copy-trade.js";

export type WalletProfile = {
  address: string;
  asOf: string;
  dataCluster: AppEnv["walletCluster"];
  summary: string;
  window: { transactions: number; from: string | null; to: string | null };
  activity: {
    signatureCount: number;
    swapCount: number;
    uniqueTokensTraded: number;
    lastActiveAt: string | null;
    medianSwapGapSeconds: number | null;
  };
  holdings: Array<{
    mint: string;
    symbol: string | null;
    name: string | null;
    amount: number;
    usdValue: number | null;
    sharePct: number | null;
  }>;
  omittedHoldings: number;
  unpricedHoldings: number;
  portfolioUsd: number | null;
  pnl: ReturnType<typeof estimatePnl>;
  labels: string[];
  labelDetails: ReturnType<typeof describeWallet>["details"];
  copyTradeScore: number | null;
  copyTradeGrade: CopyTradeGrade | null;
  copyTrade: CopyTradeAssessment;
  sources: string[];
  warnings: string[];
  cached: boolean;
  stale: boolean;
};

type RpcResponse<T> = { result?: T; error?: { message?: string } };

type ParsedTx = {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
  transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } };
};

type TokenBalance = {
  owner?: string;
  mint?: string;
  uiTokenAmount?: { uiAmountString?: string; uiAmount?: number | null; amount?: string; decimals?: number };
};

type HeliusTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number;
  amount?: number;
};

type HeliusTx = {
  signature?: string;
  timestamp?: number;
  type?: string;
  transactionError?: unknown;
  tokenTransfers?: HeliusTransfer[];
  nativeTransfers?: HeliusTransfer[];
};

type TimedTrade = TradeEvent;

type TokenAccountResponse = {
  value: Array<{
    account: {
      data: {
        parsed?: {
          info?: {
            mint?: string;
            tokenAmount?: { uiAmountString?: string; uiAmount?: number | null; amount?: string; decimals?: number };
          };
        };
      };
    };
  }>;
};

function accountKey(key: string | { pubkey: string }): string {
  return typeof key === "string" ? key : key.pubkey;
}

function resolvedAccountKeys(tx: ParsedTx): string[] {
  const messageKeys = (tx.transaction?.message?.accountKeys ?? []).map(accountKey);
  const balanceCount = tx.meta?.preBalances?.length ?? messageKeys.length;
  if (messageKeys.length >= balanceCount) return messageKeys;
  const keys = [...messageKeys];
  const loaded = [...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  for (const key of loaded) {
    if (keys.length >= balanceCount) break;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function legsFromParsedTransaction(tx: ParsedTx, owner: string): TradeLeg[] {
  if (!tx.meta || tx.meta.err) return [];
  const legs: TradeLeg[] = [];
  const pre = new Map<string, number>();
  const post = new Map<string, number>();
  for (const balance of tx.meta.preTokenBalances ?? []) {
    if (balance.owner === owner && balance.mint) pre.set(balance.mint, parseUiAmount(balance.uiTokenAmount).amount);
  }
  for (const balance of tx.meta.postTokenBalances ?? []) {
    if (balance.owner === owner && balance.mint) post.set(balance.mint, parseUiAmount(balance.uiTokenAmount).amount);
  }
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const delta = (post.get(mint) ?? 0) - (pre.get(mint) ?? 0);
    if (Math.abs(delta) > 0) legs.push({ mint, delta });
  }

  const keys = resolvedAccountKeys(tx);
  const index = keys.findIndex((key) => key === owner);
  if (index >= 0) {
    const preLamports = tx.meta.preBalances?.[index] ?? 0;
    const postLamports = tx.meta.postBalances?.[index] ?? 0;
    let deltaLamports = postLamports - preLamports;
    if (index === 0) deltaLamports += tx.meta.fee ?? 0;
    const sol = deltaLamports / 1_000_000_000;
    if (Math.abs(sol) >= 0.00001) legs.push({ mint: SOL_MINT, delta: sol });
  }
  return netLegs(legs);
}

export function legsFromHelius(tx: HeliusTx, owner: string): TradeLeg[] {
  if (tx.transactionError || tx.type === "FAILED") return [];
  const legs: TradeLeg[] = [];
  for (const transfer of tx.tokenTransfers ?? []) {
    if (!transfer.mint || transfer.tokenAmount == null || !Number.isFinite(transfer.tokenAmount)) continue;
    if (transfer.tokenAmount === 0) continue;
    if (transfer.toUserAccount === owner && transfer.fromUserAccount !== owner) {
      legs.push({ mint: transfer.mint, delta: transfer.tokenAmount });
    } else if (transfer.fromUserAccount === owner && transfer.toUserAccount !== owner) {
      legs.push({ mint: transfer.mint, delta: -transfer.tokenAmount });
    }
  }
  for (const transfer of tx.nativeTransfers ?? []) {
    const sol = (transfer.amount ?? 0) / 1_000_000_000;
    if (sol < 0.00001) continue;
    if (transfer.toUserAccount === owner && transfer.fromUserAccount !== owner) {
      legs.push({ mint: SOL_MINT, delta: sol });
    } else if (transfer.fromUserAccount === owner && transfer.toUserAccount !== owner) {
      legs.push({ mint: SOL_MINT, delta: -sol });
    }
  }
  return netLegs(legs);
}

async function loadRpcActivity(env: AppEnv, address: string, txLimit: number) {
  const signatures = await solanaRpc<Array<{ signature: string; blockTime: number | null; err?: unknown }>>(
    env,
    "getSignaturesForAddress",
    [address, { limit: txLimit }],
  );
  const rows = signatures ?? [];
  const transactions = await mapPool(rows.slice(0, txLimit), 4, async (item) => {
    if (item.err) return { legs: [] as TradeLeg[], blockTime: item.blockTime };
    try {
      const tx = await solanaRpc<ParsedTx | null>(env, "getTransaction", [
        item.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
      return { legs: tx ? legsFromParsedTransaction(tx, address) : [], blockTime: item.blockTime };
    } catch {
      return { legs: [] as TradeLeg[], blockTime: item.blockTime };
    }
  });
  const trades: TimedTrade[] = transactions
    .filter((item) => item.legs.length > 0)
    .map((item) => ({ at: item.blockTime, legs: item.legs }));
  const times = rows.map((item) => item.blockTime).filter((time): time is number => Boolean(time));
  return { trades, signatureCount: rows.length, times, source: "solana-rpc" };
}

async function loadHeliusActivity(env: AppEnv, address: string, txLimit: number) {
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.heliusApiKey}&limit=${txLimit}`;
  const txs = await fetchJson<HeliusTx[]>(url, { source: "helius" });
  const rows = txs ?? [];
  const trades: TimedTrade[] = rows
    .map((tx) => ({ at: tx.timestamp ?? null, legs: legsFromHelius(tx, address) }))
    .filter((trade) => trade.legs.length > 0);
  const times = rows.map((tx) => tx.timestamp).filter((time): time is number => Boolean(time));
  return { trades, signatureCount: rows.length, times, source: "helius" };
}

type DasResult = { items?: AssetLike[]; nativeBalance?: { lamports?: number } };

async function loadDasHoldings(
  env: AppEnv,
  address: string,
): Promise<{ items: RawHolding[]; warnings: string[]; sawNativeBalance: boolean }> {
  const warnings: string[] = [];
  let lastError: unknown;
  for (const method of ["searchAssets", "getAssetsByOwner"] as const) {
    try {
      const collected: RawHolding[] = [];
      let nativeLamports = 0;
      let sawNativeBalance = false;
      let skipped = 0;
      for (let page = 1; page <= 3; page += 1) {
        const params =
          method === "searchAssets"
            ? {
                ownerAddress: address,
                tokenType: "fungible",
                page,
                limit: 1000,
                displayOptions: { showNativeBalance: true, showFungible: true },
              }
            : {
                ownerAddress: address,
                page,
                limit: 1000,
                displayOptions: { showFungible: true, showNativeBalance: true },
              };
        const body = await fetchJson<RpcResponse<DasResult>>(env.solanaRpcUrl, {
          source: "helius",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
        });
        if (body.error) throw new UpstreamError(body.error.message ?? "RPC error", "helius");
        if (page === 1 && body.result && Object.prototype.hasOwnProperty.call(body.result, "nativeBalance")) {
          sawNativeBalance = true;
          nativeLamports = body.result.nativeBalance?.lamports ?? 0;
        }
        const items = body.result?.items ?? [];
        for (const item of items) {
          const holding = holdingFromAsset(item);
          if (holding) collected.push(holding);
          else if (item.id && item.interface && item.interface !== "FungibleToken" && item.interface !== "FungibleAsset") {
            skipped += 1;
          }
        }
        if (items.length < 1000) break;
      }
      const sol = nativeSolHolding(nativeLamports);
      if (sol) collected.push(sol);
      if (skipped > 0) warnings.push(`Skipped ${skipped} non-fungible assets.`);
      return { items: collected, warnings, sawNativeBalance };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new UpstreamError("Helius asset lookup failed", "helius");
}

function holdingFromRpcAccount(account: TokenAccountResponse["value"][number]): RawHolding | null {
  const info = account.account.data.parsed?.info;
  if (!info?.mint) return null;
  const parsed = parseUiAmount(info.tokenAmount);
  if (parsed.amount <= 0 || isLikelyNft(parsed.decimals, parsed.amount)) return null;
  return {
    mint: info.mint,
    amount: parsed.amount,
    symbol: null,
    name: null,
    priceHint: null,
    decimals: parsed.decimals,
  };
}

async function loadRpcHoldings(env: AppEnv, address: string): Promise<RawHolding[]> {
  const [lamports, tokenAccounts, token2022] = await Promise.all([
    solanaRpc<number>(env, "getBalance", [address]),
    solanaRpc<TokenAccountResponse>(env, "getTokenAccountsByOwner", [
      address,
      { programId: TOKEN_PROGRAM },
      { encoding: "jsonParsed" },
    ]),
    solanaRpc<TokenAccountResponse>(env, "getTokenAccountsByOwner", [
      address,
      { programId: TOKEN_2022_PROGRAM },
      { encoding: "jsonParsed" },
    ]).catch(() => ({ value: [] })),
  ]);
  const items: RawHolding[] = [];
  const sol = nativeSolHolding(lamports);
  if (sol) items.push(sol);
  for (const account of [...(tokenAccounts.value ?? []), ...(token2022.value ?? [])]) {
    const holding = holdingFromRpcAccount(account);
    if (holding) items.push(holding);
  }
  return items;
}

async function loadHoldings(env: AppEnv, address: string) {
  const warnings: string[] = [];
  const sources: string[] = [];
  if (env.heliusApiKey) {
    try {
      const das = await loadDasHoldings(env, address);
      sources.push("helius");
      warnings.push(...das.warnings);
      if (!das.sawNativeBalance) {
        try {
          const lamports = await solanaRpc<number>(env, "getBalance", [address]);
          const sol = nativeSolHolding(lamports);
          if (sol) das.items.push(sol);
          sources.push("solana-rpc");
        } catch (error) {
          warnings.push(redactSecrets(error instanceof Error ? error.message : "Native SOL balance lookup failed"));
        }
      }
      return { items: das.items, sources, warnings };
    } catch (error) {
      warnings.push(redactSecrets(error instanceof Error ? error.message : "Helius asset lookup failed"));
    }
  }

  sources.push("solana-rpc");
  if (!env.heliusApiKey) {
    warnings.push("Holdings and recent swaps come from public Solana RPC endpoints.");
  }
  const items = await loadRpcHoldings(env, address);
  return { items, sources, warnings };
}

function stampExecutionPrices(
  trades: TimedTrade[],
  sol: { prices: Map<number, number>; granularity: number },
): boolean {
  let missingSol = false;
  for (const trade of trades) {
    for (const leg of trade.legs) {
      if (isStableMint(leg.mint)) {
        leg.usdPrice = 1;
        continue;
      }
      if (leg.mint !== SOL_MINT) continue;
      if (trade.at == null) {
        missingSol = true;
        continue;
      }
      const price = closeAt(sol.prices, trade.at, sol.granularity);
      if (price == null) missingSol = true;
      else leg.usdPrice = price;
    }
  }
  return missingSol;
}

async function loadActivity(env: AppEnv, address: string, txLimit: number) {
  const warnings: string[] = [];
  try {
    const activity = env.heliusApiKey
      ? await loadHeliusActivity(env, address, txLimit)
      : await loadRpcActivity(env, address, txLimit);
    return { activity, warnings };
  } catch (error) {
    if (!env.heliusApiKey) throw error;
    warnings.push(redactSecrets(error instanceof Error ? error.message : "Helius history failed"));
    return { activity: await loadRpcActivity(env, address, txLimit), warnings };
  }
}

export async function buildWalletProfile(
  env: AppEnv,
  address: string,
  txLimit: number,
): Promise<Omit<WalletProfile, "cached" | "stale">> {
  const [activityResult, holdingResult] = await Promise.all([
    loadActivity(env, address, txLimit),
    loadHoldings(env, address),
  ]);
  const activity = activityResult.activity;
  const warnings = [...activityResult.warnings, ...holdingResult.warnings];
  const sources = [activity.source, ...holdingResult.sources];
  const merged = accumulateHoldings(holdingResult.items);

  const usesSol = activity.trades.some((trade) => trade.legs.some((leg) => leg.mint === SOL_MINT));
  if (usesSol) {
    const history = await loadSolUsdSeries(activity.trades.flatMap((trade) => (trade.at == null ? [] : [trade.at])));
    const missingSolPrice = stampExecutionPrices(activity.trades, history);
    if (!history.ok) {
      warnings.push("Historical SOL prices were unavailable, so SOL notionals in this window use the current SOL price.");
    } else {
      sources.push("coinbase");
      if (missingSolPrice) {
        warnings.push("Some SOL transfers had no hourly price, so those notionals use the current SOL price.");
      }
    }
  } else {
    for (const trade of activity.trades) {
      for (const leg of trade.legs) {
        if (isStableMint(leg.mint)) leg.usdPrice = 1;
      }
    }
  }

  const mints = [...merged.map((holding) => holding.mint), ...activity.trades.flatMap((trade) => trade.legs.map((leg) => leg.mint)), SOL_MINT];
  const priced = await loadTokenMeta(env, mints);
  sources.push(...priced.sources);

  const drafts = merged.map((holding) => {
    const token = priced.meta.get(holding.mint);
    const price = token?.priceUsd ?? positiveUsd(holding.priceHint);
    return {
      mint: holding.mint,
      symbol: holding.symbol ?? token?.symbol ?? null,
      name: holding.name ?? token?.name ?? null,
      amount: holding.amount,
      usdValue: price == null ? null : holding.amount * price,
    };
  });
  const presented = presentHoldings(drafts, 10_000);
  const holdings = presented.holdings.slice(0, 12);
  const omittedHoldings = Math.max(0, presented.holdings.length - holdings.length);

  const prices = new Map<string, number>();
  for (const [mint, token] of priced.meta) {
    const hint = merged.find((holding) => holding.mint === mint)?.priceHint;
    const price = token.priceUsd ?? positiveUsd(hint);
    if (price != null) prices.set(mint, price);
  }
  for (const holding of merged) {
    const hint = positiveUsd(holding.priceHint);
    if (hint != null && !prices.has(holding.mint)) prices.set(holding.mint, hint);
  }

  const pnl = estimatePnl(activity.trades, prices);
  const swaps = activity.trades.filter((trade) => isTwoSided(trade.legs));
  const memecoinSwaps = swaps.filter((trade) => isSpeculativeSwap(trade.legs)).length;
  const times = [...activity.times].sort((a, b) => a - b);
  const lastActiveAt = times.length ? new Date(times[times.length - 1] * 1000).toISOString() : null;
  const firstActiveAt = times.length ? new Date(times[0] * 1000).toISOString() : null;
  const historyTruncated = activity.signatureCount >= txLimit;
  const swapTimes = swaps.map((trade) => trade.at).filter((time): time is number => time != null);
  const medianSwapGap = medianGapSeconds(swapTimes);
  const described = describeWallet({
    swapCount: swaps.length,
    lastActiveAt,
    firstActiveAt,
    historyTruncated,
    medianSwapGapSeconds: medianSwapGap,
    signatureCount: activity.signatureCount,
    holdings: presented.holdings,
    memecoinSwaps,
    pnl,
  });

  if (historyTruncated) {
    warnings.push(`Transaction history is capped at ${txLimit} signatures. PnL ignores older trades.`);
  }
  if (presented.unpricedHoldings > 0) {
    warnings.push(
      `${presented.unpricedHoldings} holdings have no USD price and are excluded from portfolio value.`,
    );
  }
  if (pnl.partialCostBasis) {
    warnings.push("Cost basis is partial for this window. Realized PnL omits sells that had no in-window basis, and some open lots may be unpriced.");
  }
  if (omittedHoldings > 0) {
    warnings.push(`Showing 12 of ${presented.holdings.length} fungible holdings, ranked by USD value.`);
  }

  const uniqueTokensTraded = new Set(
    swaps.flatMap((trade) => trade.legs.map((leg) => leg.mint).filter((mint) => !QUOTE_MINTS.has(mint))),
  ).size;
  const summary = summarizeWallet({
    portfolioUsd: presented.portfolioUsd,
    pricedHoldings: presented.pricedHoldings,
    holdings,
    omittedHoldings,
    unpricedHoldings: presented.unpricedHoldings,
    window: {
      transactions: activity.signatureCount,
      from: firstActiveAt,
      to: lastActiveAt,
    },
    activity: {
      signatureCount: activity.signatureCount,
      swapCount: swaps.length,
      uniqueTokensTraded,
    },
    pnl,
    labels: described.labels,
  });
  const copyTrade = scoreCopyTrade({
    trades: activity.trades,
    prices,
    labels: described.labels,
    medianSwapGapSeconds: medianSwapGap,
    swapCount: swaps.length,
    historyTruncated,
    firstActiveAt,
  });
  const summaryWithScore =
    copyTrade.score == null || copyTrade.grade == null
      ? summary
      : `${summary} Copy-trade score is ${copyTrade.score.toFixed(3)} (${copyTrade.grade}) after a 3s delay and a 3.6% round trip on ${copyTrade.sampleSize} copyable ${copyTrade.sampleSize === 1 ? "close" : "closes"}.`;

  return {
    address,
    asOf: new Date().toISOString(),
    dataCluster: env.walletCluster,
    summary: summaryWithScore,
    window: {
      transactions: activity.signatureCount,
      from: firstActiveAt,
      to: lastActiveAt,
    },
    activity: {
      signatureCount: activity.signatureCount,
      swapCount: swaps.length,
      uniqueTokensTraded,
      lastActiveAt,
      medianSwapGapSeconds: medianSwapGap,
    },
    holdings,
    omittedHoldings,
    unpricedHoldings: presented.unpricedHoldings,
    portfolioUsd: presented.portfolioUsd,
    pnl,
    labels: described.labels,
    labelDetails: described.details,
    copyTradeScore: copyTrade.score,
    copyTradeGrade: copyTrade.grade,
    copyTrade,
    sources: [...new Set(sources)],
    warnings: warnings.map((warning) => redactSecrets(warning)),
  };
}
