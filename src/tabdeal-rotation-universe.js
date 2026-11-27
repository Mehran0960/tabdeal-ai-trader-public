export const TABDEAL_ROTATION_UNIVERSE_POLICY = Object.freeze({
  quoteAsset: "USDT",
  minimumBinanceQuoteVolumeUsdt: 250_000,
  minimumBinanceTradeCount24h: 500,
  maximumResearchMarkets: 200,
  excludedBaseAssets: Object.freeze([
    "USDT", "USDC", "BUSD", "FDUSD", "TUSD", "USDP", "DAI", "USDE",
    "USDD", "UST", "USTC", "EUR", "TRY", "BRL", "GBP", "AUD"
  ]),
  leveragedSuffixes: Object.freeze([
    "UP", "DOWN", "BULL", "BEAR", "2L", "2S", "3L", "3S", "5L", "5S"
  ])
});

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const nonNegative = value => Number.isFinite(Number(value)) && Number(value) >= 0;

function indexMarkets(rows, provider) {
  if (!Array.isArray(rows)) throw new Error("rotation_universe_" + provider + "_markets_invalid");
  const bySymbol = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    if (!record(row) || typeof row.symbol !== "string") continue;
    const symbol = row.symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,30}$/.test(symbol)) continue;
    if (bySymbol.has(symbol)) duplicates.add(symbol);
    else bySymbol.set(symbol, row);
  }
  return { bySymbol, duplicates };
}

function filterByType(market, type) {
  return Array.isArray(market.filters)
    ? market.filters.find(row => record(row) && row.filterType === type) || null
    : null;
}

function marketRules(market) {
  const lot = filterByType(market, "LOT_SIZE");
  const notional = filterByType(market, "MIN_NOTIONAL") || filterByType(market, "NOTIONAL");
  const price = filterByType(market, "PRICE_FILTER");
  const rules = {
    minQty: lot?.minQty ?? null,
    maxQty: lot?.maxQty ?? null,
    stepSize: lot?.stepSize ?? null,
    minNotional: notional?.minNotional ?? null,
    tickSize: price?.tickSize ?? null
  };
  return {
    ...rules,
    ready: positive(rules.minQty) && positive(rules.stepSize) &&
      positive(rules.minNotional) && positive(rules.tickSize)
  };
}

function isLeveragedOrExcludedBase(baseAsset) {
  const base = String(baseAsset || "").toUpperCase();
  if (TABDEAL_ROTATION_UNIVERSE_POLICY.excludedBaseAssets.includes(base)) return true;
  return TABDEAL_ROTATION_UNIVERSE_POLICY.leveragedSuffixes.some(suffix => base.endsWith(suffix));
}

/**
 * Build a conservative, auditable research universe from the intersection of
 * active Tabdeal Spot USDT markets and active Binance Spot USDT markets.
 * The volume threshold is a liquidity screen, not a return signal.
 *
 * If the eligible intersection exceeds the safety cap, the result explicitly
 * reports incomplete coverage. Callers must not treat a capped list as a
 * complete market scan or authorize a trade from it.
 */
export function buildTabdealRotationUniverse({
  tabdealExchangeInfo,
  binanceExchangeInfo,
  binanceTickers24h,
  minimumQuoteVolumeUsdt = TABDEAL_ROTATION_UNIVERSE_POLICY.minimumBinanceQuoteVolumeUsdt,
  minimumTradeCount24h = TABDEAL_ROTATION_UNIVERSE_POLICY.minimumBinanceTradeCount24h,
  maximumMarkets = TABDEAL_ROTATION_UNIVERSE_POLICY.maximumResearchMarkets
} = {}) {
  if (!positive(minimumQuoteVolumeUsdt) || !Number.isSafeInteger(minimumTradeCount24h) ||
      minimumTradeCount24h < 0 || !Number.isSafeInteger(maximumMarkets) ||
      maximumMarkets < 1 || maximumMarkets > 1200) {
    throw new Error("rotation_universe_policy_invalid");
  }
  if (!record(binanceExchangeInfo) || !Array.isArray(binanceExchangeInfo.symbols)) {
    throw new Error("rotation_universe_binance_exchange_info_invalid");
  }
  if (!Array.isArray(binanceTickers24h)) {
    throw new Error("rotation_universe_binance_tickers_invalid");
  }

  const tabdeal = indexMarkets(tabdealExchangeInfo, "tabdeal");
  const binance = indexMarkets(binanceExchangeInfo.symbols, "binance");
  const tickers = new Map();
  const duplicateTickers = new Set();
  for (const ticker of binanceTickers24h) {
    if (!record(ticker) || typeof ticker.symbol !== "string") continue;
    const symbol = ticker.symbol.trim().toUpperCase();
    if (tickers.has(symbol)) duplicateTickers.add(symbol);
    else tickers.set(symbol, ticker);
  }

  const excluded = {
    tabdealInactiveOrNonSpot: 0,
    binanceInactiveOrNonSpot: 0,
    missingOnBinance: 0,
    missingTicker: 0,
    belowLiquidityThreshold: 0,
    insufficientTradeCount: 0,
    excludedBaseAsset: 0,
    invalidMarketRules: 0,
    duplicateMetadata: 0
  };
  const eligible = [];
  const commonTabdeal = [...tabdeal.bySymbol.keys()].sort();
  for (const symbol of commonTabdeal) {
    const local = tabdeal.bySymbol.get(symbol);
    if (local.status !== "TRADING" || local.isSpotTradingAllowed !== true ||
        !Array.isArray(local.permissions) || !local.permissions.includes("SPOT") ||
        String(local.quoteAsset || "").toUpperCase() !== "USDT") {
      excluded.tabdealInactiveOrNonSpot++;
      continue;
    }
    const remote = binance.bySymbol.get(symbol);
    if (!remote) {
      excluded.missingOnBinance++;
      continue;
    }
    if (remote.status !== "TRADING" || remote.isSpotTradingAllowed !== true ||
        !Array.isArray(remote.permissions) || !remote.permissions.includes("SPOT") ||
        String(remote.quoteAsset || "").toUpperCase() !== "USDT" ||
        String(remote.baseAsset || "").toUpperCase() !== String(local.baseAsset || "").toUpperCase()) {
      excluded.binanceInactiveOrNonSpot++;
      continue;
    }
    if (tabdeal.duplicates.has(symbol) || binance.duplicates.has(symbol) ||
        duplicateTickers.has(symbol)) {
      excluded.duplicateMetadata++;
      continue;
    }
    const baseAsset = String(local.baseAsset || "").toUpperCase();
    if (!/^[A-Z0-9]{2,20}$/.test(baseAsset) || isLeveragedOrExcludedBase(baseAsset)) {
      excluded.excludedBaseAsset++;
      continue;
    }
    const ticker = tickers.get(symbol);
    if (!ticker) {
      excluded.missingTicker++;
      continue;
    }
    const quoteVolumeUsdt = Number(ticker.quoteVolume);
    const tradeCount24h = Number(ticker.count);
    if (!positive(quoteVolumeUsdt)) {
      excluded.missingTicker++;
      continue;
    }
    if (quoteVolumeUsdt < Number(minimumQuoteVolumeUsdt)) {
      excluded.belowLiquidityThreshold++;
      continue;
    }
    if (!Number.isSafeInteger(tradeCount24h) || tradeCount24h < minimumTradeCount24h) {
      excluded.insufficientTradeCount++;
      continue;
    }
    const rules = marketRules(local);
    if (!rules.ready) {
      excluded.invalidMarketRules++;
      continue;
    }
    eligible.push({
      symbol,
      baseAsset,
      quoteAsset: "USDT",
      quoteUnit: "USDT",
      binanceQuoteVolumeUsdt: quoteVolumeUsdt,
      quoteVolumeUsdt,
      tradeCount24h,
      lastPrice: positive(ticker.lastPrice) ? Number(ticker.lastPrice) : null,
      marketRules: rules,
      tabdealMarketStatus: local.status,
      binanceMarketStatus: remote.status
    });
  }

  eligible.sort((a, b) =>
    b.quoteVolumeUsdt - a.quoteVolumeUsdt || a.symbol.localeCompare(b.symbol)
  );
  const coverageComplete = eligible.length <= maximumMarkets;
  const selected = eligible.slice(0, maximumMarkets);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: coverageComplete ? "complete" : "capacity_exceeded",
    quoteAsset: "USDT",
    minimumQuoteVolumeUsdt: Number(minimumQuoteVolumeUsdt),
    minimumTradeCount24h: Number(minimumTradeCount24h),
    maximumMarkets,
    eligibleBeforeCap: eligible.length,
    selectedMarketCount: selected.length,
    omittedBySafetyCap: Math.max(0, eligible.length - selected.length),
    coverageComplete,
    tradeAuthorized: false,
    markets: selected,
    excluded,
    limitations: [
      "Universe membership requires active USDT Spot listing on both Tabdeal and Binance.",
      "Binance 24-hour quote volume is a discovery liquidity proxy, not Tabdeal-local turnover or executable liquidity.",
      "Every candidate still requires a fresh Tabdeal local order book, spread/depth checks, verified fees, and complete local execution rules.",
      "Markets outside the Binance intersection are not covered by this research universe.",
      "If the safety cap is exceeded, coverageComplete is false and this result must not be used as a complete scan or trade authorization."
    ],
    safety: {
      publicMarketMetadataOnly: true,
      privateCredentialsUsed: false,
      accountDataRead: false,
      ordersPlaced: 0,
      fundsMoved: false,
      liveTradingEnabled: false
    }
  };
}
