const DEFAULT_TABDEAL_API_BASE = "https://api1.tabdeal.org/r/api/v1";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function findFilter(market, filterType) {
  return Array.isArray(market?.filters)
    ? market.filters.find(item => isRecord(item) && item.filterType === filterType) ?? null
    : null;
}

function isActiveSpotMarket(market) {
  return isRecord(market) &&
    market.status === "TRADING" &&
    market.isSpotTradingAllowed === true &&
    Array.isArray(market.permissions) &&
    market.permissions.includes("SPOT") &&
    typeof market.symbol === "string" &&
    typeof market.baseAsset === "string" &&
    typeof market.quoteAsset === "string";
}

export function assessTabdealPublicMarkets(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("tabdeal_exchange_info_invalid_or_empty");
  }

  const rawActiveSpotMarkets = payload.filter(isActiveSpotMarket);
  if (rawActiveSpotMarkets.length === 0) {
    throw new Error("tabdeal_no_active_spot_markets");
  }

  const uniqueBySymbol = new Map();
  const conflictingDuplicateSymbols = new Set();
  let duplicateMarketRecordCount = 0;
  for (const market of rawActiveSpotMarkets) {
    const symbol = market.symbol.trim().toUpperCase();
    const prior = uniqueBySymbol.get(symbol);
    if (!prior) {
      uniqueBySymbol.set(symbol, market);
      continue;
    }
    duplicateMarketRecordCount++;
    if (prior.baseAsset.toUpperCase() !== market.baseAsset.toUpperCase() ||
        prior.quoteAsset.toUpperCase() !== market.quoteAsset.toUpperCase() ||
        prior.status !== market.status ||
        prior.isSpotTradingAllowed !== market.isSpotTradingAllowed) {
      conflictingDuplicateSymbols.add(symbol);
    }
  }
  const activeSpotMarkets = [...uniqueBySymbol.values()];
  if (activeSpotMarkets.length === 0) {
    throw new Error("tabdeal_no_unique_active_spot_markets");
  }

  const byQuote = new Map();
  for (const market of activeSpotMarkets) {
    const quote = market.quoteAsset.trim().toUpperCase();
    if (!byQuote.has(quote)) byQuote.set(quote, []);
    byQuote.get(quote).push(market);
  }

  const summarize = quote => {
    const markets = byQuote.get(quote) ?? [];
    const symbols = markets.map(item => item.symbol.toUpperCase()).sort();
    const minNotionals = [...new Set(markets
      .map(item => findFilter(item, "MIN_NOTIONAL"))
      .map(filter => filter ? finitePositive(filter.minNotional) : null)
      .filter(value => value !== null))].sort((a, b) => a - b);
    return {
      count: markets.length,
      symbols: symbols.slice(0, 60),
      minNotionalValues: minNotionals,
      minNotionalCoverageCount: markets.filter(item =>
        finitePositive(findFilter(item, "MIN_NOTIONAL")?.minNotional) !== null
      ).length
    };
  };

  const samples = ["BTCUSDT", "USDTIRT", "BTCIRT"].map(symbol => {
    const market = activeSpotMarkets.find(item =>
      item.symbol.toUpperCase() === symbol
    );
    if (!market) return {symbol, listed: false};
    const lot = findFilter(market, "LOT_SIZE");
    const minNotional = findFilter(market, "MIN_NOTIONAL");
    return {
      symbol,
      listed: true,
      baseAsset: market.baseAsset.toUpperCase(),
      quoteAsset: market.quoteAsset.toUpperCase(),
      isSpotTradingAllowed: market.isSpotTradingAllowed,
      isMarginTradingAllowed: market.isMarginTradingAllowed === true,
      baseAssetPrecision: market.baseAssetPrecision ?? null,
      quoteAssetPrecision: market.quoteAssetPrecision ?? null,
      minQty: lot?.minQty ?? null,
      stepSize: lot?.stepSize ?? null,
      minNotional: minNotional?.minNotional ?? null,
      minNotionalApplyToMarket: minNotional?.applyToMarket ?? null,
      priceTickSize: findFilter(market, "PRICE_FILTER")?.tickSize ?? null
    };
  });

  return {
    provider: "TABDEAL",
    status: "PUBLIC_SPOT_MARKET_METADATA_AVAILABLE_EXECUTION_BLOCKED",
    sourceEndpoint: "GET /exchangeInfo",
    rawActiveSpotMarketRecordCount: rawActiveSpotMarkets.length,
    activeSpotMarketCount: activeSpotMarkets.length,
    duplicateMarketRecordCount,
    conflictingDuplicateSymbols: [...conflictingDuplicateSymbols].sort().slice(0, 30),
    quoteAssets: [...byQuote.keys()].sort(),
    irt: summarize("IRT"),
    usdt: summarize("USDT"),
    sampleMarkets: samples,
    irtUnit: "UNVERIFIED",
    feeSchedule: "NOT_VERIFIED",
    accountKyc: "NOT_CHECKED",
    accountTradeEligibility: "NOT_CHECKED",
    unattendedBotPermission: "NOT_CHECKED",
    apiKeyCreated: false,
    privateEndpointCalled: false,
    orderSubmissionAttempted: false,
    exchangeOrdersPlaced: 0,
    fundsMoved: false,
    withdrawalPermissionRequested: false,
    executionAllowed: false,
    liveTradingEnabled: false
  };
}

export function assessTabdealDepth(payload, symbol) {
  if (!isRecord(payload) || !Array.isArray(payload.bids) || !Array.isArray(payload.asks)) {
    throw new Error("tabdeal_depth_payload_invalid");
  }
  const bestBid = payload.bids.length ? finitePositive(payload.bids[0]?.[0]) : null;
  const bestAsk = payload.asks.length ? finitePositive(payload.asks[0]?.[0]) : null;
  const spreadBps = bestBid !== null && bestAsk !== null && bestAsk >= bestBid
    ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000
    : null;
  const bidQuoteDepth = payload.bids.slice(0, 5).reduce((sum, row) => {
    const price = finitePositive(row?.[0]);
    const qty = finitePositive(row?.[1]);
    return price !== null && qty !== null ? sum + price * qty : sum;
  }, 0);
  const askQuoteDepth = payload.asks.slice(0, 5).reduce((sum, row) => {
    const price = finitePositive(row?.[0]);
    const qty = finitePositive(row?.[1]);
    return price !== null && qty !== null ? sum + price * qty : sum;
  }, 0);
  return {
    symbol: String(symbol).toUpperCase(),
    hasBids: payload.bids.length > 0,
    hasAsks: payload.asks.length > 0,
    bestBid,
    bestAsk,
    spreadBps,
    topFiveBidQuoteDepth: bidQuoteDepth,
    topFiveAskQuoteDepth: askQuoteDepth,
    quoteUnit: "UNVERIFIED"
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Public GET-only probe. No authentication or write method is used. */
export async function probeTabdealPublicApi({
  apiBase = DEFAULT_TABDEAL_API_BASE,
  fetchImpl = fetch,
  sleepImpl = sleep,
  timeoutMs = 12_000,
  spacingMs = 400
} = {}) {
  const base = String(apiBase).replace(/\/+$/, "");
  const getJson = async url => {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {accept: "application/json"},
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response?.ok) throw new Error("tabdeal_public_http_" + (response?.status ?? 0));
    return response.json();
  };

  const markets = await getJson(base + "/exchangeInfo");
  const assessment = assessTabdealPublicMarkets(markets);
  const symbols = ["BTCUSDT", "USDTIRT", "BTCIRT"];
  const depth = [];
  for (let i = 0; i < symbols.length; i++) {
    if (i > 0) await sleepImpl(spacingMs);
    const symbol = symbols[i];
    const listedInExchangeInfo = markets.some(item =>
      isActiveSpotMarket(item) && item.symbol.toUpperCase() === symbol
    );
    const url = new URL(base + "/depth");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("limit", "5");
    depth.push({
      listedInExchangeInfo,
      metadataDepthMismatch: !listedInExchangeInfo,
      ...assessTabdealDepth(await getJson(url), symbol)
    });
  }

  return {
    ...assessment,
    depthSnapshots: depth,
    publicRequestsOnly: true,
    apiKeyCreated: false,
    privateEndpointCalled: false,
    orderSubmissionAttempted: false,
    exchangeOrdersPlaced: 0,
    fundsMoved: false,
    executionAllowed: false,
    liveTradingEnabled: false
  };
}
