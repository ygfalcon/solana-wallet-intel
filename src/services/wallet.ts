import { QUOTE_MINTS, type AppEnv } from "../config.js";
import { estimatePnl, labelWallet, type TradeLeg } from "../analytics.js";
import { fetchJson, UpstreamError } from "../http.js";
import { SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../solana.js";
import { loadTokenMeta } from "./prices.js";

export type WalletProfile = {
  address: string;
  asOf: string;
  dataCluster: AppEnv["walletCluster"];
  window: { transactions: number; from: string | null; to: string | null };
  activity: {
    signatureCount: number;
    swapCount: number;
    uniqueTokensTraded: number;
    lastActiveAt: string | null;
  };
  holdings: Array<{
    mint: string;
    symbol: string | null;
    name: string | null;
    amount: number;
    usdValue: number | null;
    sharePct: number | null;
  }>;
  portfolioUsd: number | null;
  tokenCount?: number;
  unpricedTokenCount?: number;
  trading?: { windowHours: number | null; swapsPerDay: number | null; txsPerDay?: number | null; medianSecondsBetweenTxs: number | null };
  pnl: ReturnType<typeof estimatePnl>;
  labels: string[];
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
  } | null;
  transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } };
};

type TokenBalance = {
  owner?: string;
  mint?: string;
  uiTokenAmount?: { uiAmountString?: string; uiAmount?: number | null };
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
  tokenTransfers?: HeliusTransfer[];
  nativeTransfers?: HeliusTransfer[];
};

type AssetItem = {
  id?: string;
  content?: { metadata?: { name?: string; symbol?: string } };
  token_info?: {
    balance?: number;
    decimals?: number;
    symbol?: string;
    price_info?: { price_per_token?: number };
  };
  interface?: string;
};

function accountKey(key: string | { pubkey: string }): string {
  return typeof key === "string" ? key : key.pubkey;
}

function uiAmount(balance: TokenBalance | undefined): number {
  if (!balance?.uiTokenAmount) return 0;
  const raw = balance.uiTokenAmount.uiAmountString ?? balance.uiTokenAmount.uiAmount;
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function legsFromParsedTransaction(tx: ParsedTx, owner: string): TradeLeg[] {
  if (!tx.meta || tx.meta.err) return [];
  const legs: TradeLeg[] = [];
  const pre = new Map<string, number>();
  const post = new Map<string, number>();
  for (const balance of tx.meta.preTokenBalances ?? []) {
    if (balance.owner === owner && balance.mint) pre.set(balance.mint, uiAmount(balance));
  }
  for (const balance of tx.meta.postTokenBalances ?? []) {
    if (balance.owner === owner && balance.mint) post.set(balance.mint, uiAmount(balance));
  }
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const delta = (post.get(mint) ?? 0) - (pre.get(mint) ?? 0);
    if (Math.abs(delta) > 0) legs.push({ mint, delta });
  }

  const keys = tx.transaction?.message?.accountKeys ?? [];
  const index = keys.findIndex((key) => accountKey(key) === owner);
  if (index >= 0) {
    const preLamports = tx.meta.preBalances?.[index] ?? 0;
    const postLamports = tx.meta.postBalances?.[index] ?? 0;
    let deltaLamports = postLamports - preLamports;
    if (index === 0) deltaLamports += tx.meta.fee ?? 0;
    const sol = deltaLamports / 1_000_000_000;
    if (Math.abs(sol) >= 0.00001) legs.push({ mint: SOL_MINT, delta: sol });
  }
  return legs;
}

export function legsFromHelius(tx: HeliusTx, owner: string): TradeLeg[] {
  const legs: TradeLeg[] = [];
  for (const transfer of tx.tokenTransfers ?? []) {
    if (!transfer.mint || transfer.tokenAmount === undefined) continue;
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
  return legs;
}

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

async function loadRpcActivity(env: AppEnv, address: string, txLimit: number) {
  const signatures = await rpc<Array<{ signature: string; blockTime: number | null }>>(
    env.solanaRpcUrl,
    "getSignaturesForAddress",
    [address, { limit: txLimit }],
  );
  const transactions = await Promise.all(
    (signatures ?? []).slice(0, txLimit).map(async (item) => {
      try {
        const tx = await rpc<ParsedTx | null>(env.solanaRpcUrl, "getTransaction", [
          item.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);
        return { tx, blockTime: item.blockTime };
      } catch {
        return { tx: null, blockTime: item.blockTime };
      }
    }),
  );
  const trades = transactions
    .map((item) => (item.tx ? legsFromParsedTransaction(item.tx, address) : []))
    .filter((legs) => legs.length > 0);
  const times = (signatures ?? []).map((item) => item.blockTime).filter((time): time is number => Boolean(time));
  return { trades, signatureCount: signatures?.length ?? 0, times, source: "solana-rpc" };
}

async function loadHeliusActivity(env: AppEnv, address: string, txLimit: number) {
  const txs: HeliusTx[] = [];
  let before: string | undefined;
  while (txs.length < txLimit) {
    const n = Math.min(100, txLimit - txs.length);
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.heliusApiKey}&limit=${n}${before ? `&before=${before}` : ""}`;
    let page: HeliusTx[];
    try { page = (await fetchJson<HeliusTx[]>(url, { source: "helius" })) ?? []; }
    catch (e) { if (txs.length === 0) throw e; break; }
    txs.push(...page);
    before = page[page.length - 1]?.signature;
    if (page.length < n || !before) break;
  }
  const trades = (txs ?? [])
    .map((tx) => legsFromHelius(tx, address))
    .filter((legs) => legs.length > 0);
  const times = (txs ?? []).map((tx) => tx.timestamp).filter((time): time is number => Boolean(time));
  return { trades, signatureCount: txs?.length ?? 0, times, source: "helius" };
}

async function loadHoldings(env: AppEnv, address: string) {
  const holdings = new Map<string, { amount: number; symbol: string | null; name: string | null; priceHint: number | null }>();
  const warnings: string[] = [];
  const sources: string[] = [];

  if (env.heliusApiKey) {
    try {
      const body = await fetchJson<RpcResponse<{ items?: AssetItem[]; nativeBalance?: { lamports?: number } }>>(
        env.solanaRpcUrl,
        {
          source: "helius",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "assets",
            method: "searchAssets",
            params: {
              ownerAddress: address,
              tokenType: "fungible",
              page: 1,
              limit: 1000,
              displayOptions: { showNativeBalance: true },
            },
          }),
        },
      );
      sources.push("helius");
      const lamports = body.result?.nativeBalance?.lamports ?? 0;
      if (lamports > 0) {
        holdings.set(SOL_MINT, { amount: lamports / 1_000_000_000, symbol: "SOL", name: "Solana", priceHint: null });
      }
      for (const item of body.result?.items ?? []) {
        const info = item.token_info;
        if (!item.id || !info || info.balance === undefined || info.decimals === undefined) continue;
        const amount = info.balance / 10 ** info.decimals;
        if (amount <= 0) continue;
        // Skip NFT-like and spam-airdrop units (decimals 0, single unit) so they don't crowd out real tokens.
        if (info.decimals === 0 && amount <= 1) continue;
        holdings.set(item.id, {
          amount,
          symbol: info.symbol ?? item.content?.metadata?.symbol ?? null,
          name: item.content?.metadata?.name ?? null,
          priceHint: info.price_info?.price_per_token ?? null,
        });
      }
      return { holdings, sources, warnings };
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Helius asset lookup failed");
    }
  }

  const [lamports, tokenAccounts, token2022] = await Promise.all([
    rpc<number>(env.solanaRpcUrl, "getBalance", [address]),
    rpc<{ value: Array<{ account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number } } } } } }> }>(
      env.solanaRpcUrl,
      "getTokenAccountsByOwner",
      [address, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }],
    ),
    rpc<{ value: Array<{ account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number } } } } } }> }>(
      env.solanaRpcUrl,
      "getTokenAccountsByOwner",
      [address, { programId: TOKEN_2022_PROGRAM }, { encoding: "jsonParsed" }],
    ).catch(() => ({ value: [] })),
  ]);
  sources.push("solana-rpc");
  if (!env.heliusApiKey) {
    warnings.push("HELIUS_API_KEY is unset. Holdings and recent swaps come from the public Solana RPC.");
  }
  if (lamports > 0) {
    holdings.set(SOL_MINT, { amount: lamports / 1_000_000_000, symbol: "SOL", name: "Solana", priceHint: null });
  }
  for (const account of [...(tokenAccounts.value ?? []), ...(token2022.value ?? [])]) {
    const info = account.account.data.parsed?.info;
    const amount = info?.tokenAmount?.uiAmount ?? 0;
    if (!info?.mint || amount <= 0) continue;
    holdings.set(info.mint, { amount, symbol: null, name: null, priceHint: null });
  }
  return { holdings, sources, warnings };
}

export async function buildWalletProfile(env: AppEnv, address: string, txLimit: number): Promise<Omit<WalletProfile, "cached" | "stale">> {
  const warnings: string[] = [];
  const sources: string[] = [];
  let activity: { trades: TradeLeg[][]; signatureCount: number; times: number[]; source: string };
  const holdingsPromise = loadHoldings(env, address);
  holdingsPromise.catch(() => undefined);
  try {
    activity = env.heliusApiKey
      ? await loadHeliusActivity(env, address, txLimit)
      : await loadRpcActivity(env, address, txLimit);
    sources.push(activity.source);
  } catch (error) {
    if (!env.heliusApiKey) throw error;
    warnings.push(error instanceof Error ? error.message : "Helius history failed");
    activity = await loadRpcActivity(env, address, txLimit);
    sources.push(activity.source);
  }

  const holdingResult = await holdingsPromise;
  sources.push(...holdingResult.sources);
  warnings.push(...holdingResult.warnings);

  // Priority: SOL, traded mints, then holdings that Helius already prices, then the long tail.
  const held = [...holdingResult.holdings.entries()];
  const mints = [
    SOL_MINT,
    ...activity.trades.flatMap((legs) => legs.map((leg) => leg.mint)),
    ...held.filter(([, h]) => h.priceHint != null).map(([m]) => m),
    ...held.filter(([, h]) => h.priceHint == null).map(([m]) => m),
  ];
  const traded = [SOL_MINT, ...activity.trades.flatMap((legs) => legs.map((leg) => leg.mint))];
  // Deterministic set: SOL + traded + Helius-hinted holdings + unhinted holdings sorted by mint, capped at 250.
  const ordered = [...new Set(mints)];
  const head = ordered.filter((m) => traded.includes(m) || holdingResult.holdings.get(m)?.priceHint != null);
  const tail = ordered.filter((m) => !head.includes(m)).sort();
  const meta = await loadTokenMeta(env, [...head, ...tail].slice(0, Math.max(250, head.length)), traded);
  sources.push("jupiter");
  const prices = new Map<string, number>();
  for (const [mint, token] of meta) {
    const hint = holdingResult.holdings.get(mint)?.priceHint;
    // Spam filter: a non-hinted price only counts if the pool has at least $5k liquidity.
    const liquid = token.liquidityUsd == null ? traded.includes(mint) : token.liquidityUsd >= 5_000;
    const price = (liquid ? token.priceUsd : null) ?? hint;
    if (price !== null && price !== undefined) prices.set(mint, price);
  }

  const allHoldings = [...holdingResult.holdings.entries()]
    .map(([mint, holding]) => {
      const token = meta.get(mint);
      const price = prices.get(mint) ?? null;
      return {
        mint,
        symbol: holding.symbol ?? token?.symbol ?? null,
        name: holding.name ?? token?.name ?? null,
        amount: holding.amount,
        usdValue: price === null ? null : Math.round(holding.amount * price * 100) / 100,
        sharePct: null as number | null,
      };
    })
    .sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));
  const holdings = allHoldings.slice(0, 15);
  const tokenCount = allHoldings.length;
  const unpricedCount = allHoldings.filter((h) => h.usdValue === null).length;

  const portfolio = allHoldings.reduce((sum, holding) => sum + (holding.usdValue ?? 0), 0);
  const priced = allHoldings.some((holding) => holding.usdValue !== null);
  for (const holding of holdings) {
    holding.sharePct = priced && portfolio > 0 && holding.usdValue !== null
      ? Math.round((holding.usdValue / portfolio) * 1000) / 10
      : null;
  }

  // Upstreams return newest-first; replay oldest-first so buys open lots before sells close them.
  const pnl = estimatePnl([...activity.trades].reverse(), prices);
  const memecoinSwaps = activity.trades.filter((legs) =>
    legs.some((leg) => !QUOTE_MINTS.has(leg.mint) && Math.abs(leg.delta) > 0),
  ).length;
  const times = [...activity.times].sort((a, b) => a - b);
  const lastActiveAt = times.length ? new Date(times[times.length - 1] * 1000).toISOString() : null;

  return {
    address,
    asOf: new Date().toISOString(),
    dataCluster: env.walletCluster,
    window: {
      transactions: activity.signatureCount,
      from: times.length ? new Date(times[0] * 1000).toISOString() : null,
      to: lastActiveAt,
    },
    activity: {
      signatureCount: activity.signatureCount,
      swapCount: activity.trades.filter((legs) => legs.some((leg) => leg.delta > 0) && legs.some((leg) => leg.delta < 0)).length,
      uniqueTokensTraded: new Set(
        activity.trades.flatMap((legs) => legs.map((leg) => leg.mint)).filter((mint) => !QUOTE_MINTS.has(mint)),
      ).size,
      lastActiveAt,
    },
    holdings,
    tokenCount,
    unpricedTokenCount: unpricedCount,
    trading: tradingStats(activity.times, activity.trades.filter((legs) => legs.some((leg) => leg.delta > 0) && legs.some((leg) => leg.delta < 0)).length),
    portfolioUsd: priced ? Math.round(portfolio * 100) / 100 : null,
    pnl,
    labels: labelWallet({
      swapCount: activity.trades.filter((legs) => legs.some((leg) => leg.delta > 0) && legs.some((leg) => leg.delta < 0)).length,
      lastActiveAt,
      holdings,
      memecoinSwaps,
      pnl,
      times: activity.times,
    }),
    sources: [...new Set(sources)],
    warnings,
  };
}

function tradingStats(times: number[], swaps: number) {
  const sorted = [...times].sort((a, b) => a - b);
  const spanHours = sorted.length > 1 ? (sorted[sorted.length - 1] - sorted[0]) / 3600 : null;
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]).sort((a, b) => a - b);
  const medianGapSec = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  return {
    windowHours: spanHours === null ? null : Math.round(spanHours * 10) / 10,
    swapsPerDay: spanHours && spanHours > 0 ? Math.round((swaps / spanHours) * 24 * 10) / 10 : null,
    txsPerDay: spanHours && spanHours > 0 ? Math.round((sorted.length / spanHours) * 24 * 10) / 10 : null,
    medianSecondsBetweenTxs: medianGapSec,
  };
}

export async function buildWalletPreview(env: AppEnv, address: string) {
  const [lamports, sigs] = await Promise.all([
    rpc<{ value: number } | number>(env.solanaRpcUrl, "getBalance", [address]),
    rpc<Array<{ blockTime: number | null }>>(env.solanaRpcUrl, "getSignaturesForAddress", [address, { limit: 25 }]),
  ]);
  const raw = typeof lamports === "number" ? lamports : lamports?.value ?? 0;
  const last = sigs?.[0]?.blockTime ?? null;
  const recent24 = (sigs ?? []).filter((x) => x.blockTime && Date.now() / 1000 - x.blockTime < 86_400).length;
  return {
    address,
    asOf: new Date().toISOString(),
    solBalance: raw / 1_000_000_000,
    lastActiveAt: last ? new Date(last * 1000).toISOString() : null,
    recentTxs24h: recent24,
    recentTxs24hCapped: recent24 >= 25,
    preview: true,
    upgrade: "$0.002 at /wallet/quick for realized PnL, win rate, bot and smart-money flags; $0.01 at /wallet/profile for priced holdings and the full report.",
  };
}
