const EXIR_BASE = "https://api.exir.io/v2";
const WALLEX_BASE = "https://api.wallex.ir/v1";
const TABDEAL_BASE = "https://api1.tabdeal.org/r/api/v1";

export const REFERENCE_BTC_QUANTITY = "0.000033";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};
const finite = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function exirBook(payload) {
  const book = payload?.["btc-usdt"];
  if (!isRecord(book)) return null;
  return {bids: book.bids, asks: book.asks, timestamp: book.timestamp ?? null};
}

function wallexBook(payload) {
  const result = payload?.result;
  if (!isRecord(result)) return null;
  return {bids: result.bid, asks: result.ask, timestamp: result.timestamp ?? null};
}

function tabdealBook(payload) {
  if (!isRecord(payload)) return null;
  return {bids: payload.bids, asks: payload.asks, timestamp: payload.timestamp ?? null};
}

function normalizeLevels(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(level => {
    const price = Array.isArray(level) ? positive(level[0]) : positive(level?.price);
    const quantity = Array.isArray(level) ? positive(level[1]) : positive(level?.quantity);
    return price && quantity ? [{price, quantity}] : [];
  }).sort((a, b) => b.price - a.price);
}

export function estimateSellBook(book, baseQuantity = REFERENCE_BTC_QUANTITY) {
  const quantity = positive(baseQuantity);
  const bids = normalizeLevels(book?.bids);
  const asks = normalizeLevels(book?.asks);
  if (!quantity || !bids.length || !asks.length) {
    return {
      status: "unavailable",
      bestBid: bids[0]?.price ?? null,
      bestAsk: asks.length ? Math.min(...asks.map(level => level.price)) : null,
      spreadBps: null,
      referenceQuantityBtc: String(baseQuantity),
      visibleBidQuantityBtc: bids.reduce((sum, level) => sum + level.quantity, 0),
      canFillReferenceQuantity: false,
      estimatedGrossUsdt: null,
      estimatedVwap: null
    };
  }

  const bestBid = bids[0].price;
  const bestAsk = Math.min(...asks.map(level => level.price));
  const spreadBps = bestAsk >= bestBid
    ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000
    : null;
  let remaining = quantity;
  let gross = 0;
  let visibleBidQuantity = 0;
  for (const level of bids) {
    visibleBidQuantity += level.quantity;
    if (remaining <= 1e-14) break;
    const used = Math.min(remaining, level.quantity);
    gross += used * level.price;
    remaining -= used;
  }
  const canFill = remaining <= Math.max(1e-14, quantity * 1e-10);
  return {
    status: canFill ? "visible_depth_covers_reference_quantity" : "visible_depth_insufficient",
    bestBid,
    bestAsk,
    spreadBps,
    referenceQuantityBtc: String(baseQuantity),
    visibleBidQuantityBtc: visibleBidQuantity,
    canFillReferenceQuantity: canFill,
    estimatedGrossUsdt: canFill ? gross : null,
    estimatedVwap: canFill ? gross / quantity : null
  };
}

function getFilter(market, name) {
  return Array.isArray(market?.filters)
    ? market.filters.find(item => isRecord(item) && item.filterType === name) ?? null
    : null;
}

function assessExir(payloads, book, trades, referenceQuantityBtc = REFERENCE_BTC_QUANTITY) {
  const pair = payloads.constants?.pairs?.["btc-usdt"] ?? null;
  const ticker = payloads.ticker;
  const tradeRows = trades?.["btc-usdt"];
  const execution = estimateSellBook(exirBook(book), referenceQuantityBtc);
  const minBaseQty = positive(pair?.min_size);
  const step = positive(pair?.increment_size);
  const bestBid = execution.bestBid;
  const estimatedReferenceNotional = bestBid ? bestBid * Number(referenceQuantityBtc) : null;
  const minBaseNotional = minBaseQty && bestBid ? minBaseQty * bestBid : null;
  return {
    provider: "Exir",
    market: "btc-usdt",
    marketListed: Boolean(pair),
    marketActive: typeof pair?.active === "boolean" ? pair.active : null,
    minimumBaseQuantityBtc: minBaseQty,
    baseQuantityIncrementBtc: step,
    minimumBaseQuantityApproxUsdt: minBaseNotional,
    minimumQuoteNotionalUsdt: null,
    minimumRuleSource: pair ? "GET /v2/constants pairs.btc-usdt" : "not returned",
    referenceQuantityEstimatedNotionalUsdt: estimatedReferenceNotional,
    referenceQuantityMeetsKnownMinimum: minBaseQty === null
      ? null
      : Number(referenceQuantityBtc) >= minBaseQty,
    tickSize: positive(pair?.increment_price),
    tickerLast: positive(ticker?.last ?? ticker?.close),
    tickerTimestamp: ticker?.timestamp ?? null,
    recentTradeCount: Array.isArray(tradeRows) ? tradeRows.length : 0,
    book: execution,
    api: {
      health: payloads.health ? "reachable" : "unavailable",
      constants: pair ? "btc-usdt pair metadata present" : "pair metadata missing",
      ticker: positive(ticker?.last ?? ticker?.close) ? "usable" : "missing_or_invalid",
      orderbook: execution.status === "unavailable" ? "missing_or_invalid" : "usable",
      trades: Array.isArray(tradeRows) ? "usable" : "missing_or_invalid"
    },
    documentationCaveat: "The public API docs show a sample min_size/increment_size that appears dated; this live response must be authoritative and should be rechecked before any account migration."
  };
}

function assessWallex(payloads, spotBook, otcBook, referenceQuantityBtc = REFERENCE_BTC_QUANTITY) {
  const spotMarket = payloads.markets?.result?.symbols?.BTCUSDT ?? null;
  const otcMarket = payloads.otcMarkets?.result?.symbols?.BTCUSDT ?? null;
  const spotBookAssessment = estimateSellBook(wallexBook(spotBook), referenceQuantityBtc);
  const otcBookAssessment = estimateSellBook(wallexBook(otcBook ?? spotBook), referenceQuantityBtc);
  const minSpotNotional = positive(spotMarket?.minNotional);
  const minOtcNotional = positive(otcMarket?.minNotional);
  const bestBid = spotBookAssessment.bestBid;
  const referenceNotional = bestBid ? bestBid * Number(referenceQuantityBtc) : null;
  const minQty = positive(spotMarket?.minQty);
  return {
    provider: "Wallex",
    market: "BTCUSDT",
    spot: {
      marketListed: Boolean(spotMarket),
      minimumBaseQuantityBtc: minQty,
      baseQuantityPrecision: finite(spotMarket?.stepSize),
      baseAssetPrecision: finite(spotMarket?.baseAssetPrecision),
      quoteAssetPrecision: finite(spotMarket?.quotePrecision),
      minimumQuoteNotionalUsdt: minSpotNotional,
      referenceQuantityEstimatedNotionalUsdt: referenceNotional,
      referenceQuantityMeetsKnownMinimum: minQty === null || referenceNotional === null
        ? null
        : Number(referenceQuantityBtc) >= minQty && referenceNotional >= minSpotNotional,
      book: spotBookAssessment
    },
    otc: {
      marketListed: Boolean(otcMarket),
      minimumBaseQuantityBtc: positive(otcMarket?.minQty),
      minimumQuoteNotionalUsdt: minOtcNotional,
      sellStatus: otcMarket?.sellStatus ?? null,
      referenceQuantityEstimatedNotionalUsdt: referenceNotional,
      referenceQuantityMeetsKnownMinimum: !otcMarket || minOtcNotional === null || referenceNotional === null
        ? null
        : referenceNotional >= minOtcNotional,
      book: otcBookAssessment
    },
    recentTradeCount: Array.isArray(payloads.trades?.result?.trades)
      ? payloads.trades.result.trades.length
      : Array.isArray(payloads.trades?.result?.latestTrades)
        ? payloads.trades.result.latestTrades.length
        : Array.isArray(payloads.trades?.result?.data)
          ? payloads.trades.result.data.length
          : null,
    api: {
      markets: spotMarket ? "usable" : "missing_or_invalid",
      depth: spotBookAssessment.status === "unavailable" ? "missing_or_invalid" : "usable",
      otcMarkets: otcMarket ? "usable" : "missing_or_invalid",
      trades: payloads.trades ? "reachable" : "unavailable"
    },
    documentationCaveat: "Wallex stepSize and tickSize are decimal precision counts in the documented market schema, not literal increments. Current minNotional values are read from the live public market response."
  };
}

function assessTabdeal(payloads, depth, referenceQuantityBtc = REFERENCE_BTC_QUANTITY) {
  const markets = Array.isArray(payloads.exchangeInfo) ? payloads.exchangeInfo : [];
  const market = markets.find(item =>
    isRecord(item) &&
    String(item.symbol ?? "").toUpperCase() === "BTCUSDT" &&
    item.status === "TRADING" &&
    item.isSpotTradingAllowed === true
  ) ?? null;
  const lot = getFilter(market, "MARKET_LOT_SIZE") ?? getFilter(market, "LOT_SIZE");
  const notional = getFilter(market, "NOTIONAL") ?? getFilter(market, "MIN_NOTIONAL");
  const book = estimateSellBook(tabdealBook(depth), referenceQuantityBtc);
  const minBase = positive(lot?.minQty);
  const minQuote = positive(notional?.minNotional);
  const referenceNotional = book.bestBid ? book.bestBid * Number(referenceQuantityBtc) : null;
  return {
    provider: "Tabdeal",
    market: "BTCUSDT",
    reference: true,
    marketListed: Boolean(market),
    marketActive: market ? true : null,
    minimumBaseQuantityBtc: minBase,
    baseQuantityStepBtc: positive(lot?.stepSize),
    minimumQuoteNotionalUsdt: minQuote,
    referenceQuantityEstimatedNotionalUsdt: referenceNotional,
    referenceQuantityMeetsKnownMinimum: minBase === null || referenceNotional === null
      ? null
      : Number(referenceQuantityBtc) >= minBase &&
        (minQuote === null || referenceNotional >= minQuote),
    book,
    api: {
      exchangeInfo: market ? "usable" : "market_missing_or_not_active",
      depth: book.status === "unavailable" ? "missing_or_invalid" : "usable"
    }
  };
}

async function getJson(fetchImpl, url, timeoutMs) {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {accept: "application/json"},
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
    const latencyMs = Math.max(0, Date.now() - started);
    if (!response.ok) {
      return {ok: false, status: response.status, latencyMs, payload: null};
    }
    const payload = await response.json();
    return {ok: true, status: response.status, latencyMs, payload};
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Math.max(0, Date.now() - started),
      payload: null,
      error: String(error?.name || "Error").slice(0, 40)
    };
  }
}

function callSummary(results) {
  return Object.fromEntries(Object.entries(results).map(([name, value]) => [
    name,
    {status: value.ok ? "ok" : value.status ?? value.error ?? "failed", latencyMs: value.latencyMs}
  ]));
}

export async function runDomesticExchangeProbe({
  fetchImpl = fetch,
  now = () => new Date(),
  timeoutMs = 10_000,
  referenceQuantityBtc = REFERENCE_BTC_QUANTITY
} = {}) {
  const exirUrls = {
    health: EXIR_BASE + "/health",
    constants: EXIR_BASE + "/constants",
    ticker: EXIR_BASE + "/ticker?symbol=btc-usdt",
    orderbook: EXIR_BASE + "/orderbook?symbol=btc-usdt",
    trades: EXIR_BASE + "/trades?symbol=btc-usdt"
  };
  const wallexUrls = {
    markets: WALLEX_BASE + "/markets",
    depth: WALLEX_BASE + "/depth?symbol=BTCUSDT",
    otcMarkets: WALLEX_BASE + "/otc/markets",
    trades: WALLEX_BASE + "/trades?symbol=BTCUSDT"
  };
  const tabdealUrls = {
    exchangeInfo: TABDEAL_BASE + "/exchangeInfo",
    depth: TABDEAL_BASE + "/depth?symbol=BTCUSDT&limit=5"
  };

  const [exirResults, wallexResults, tabdealResults] = await Promise.all([
    Promise.all(Object.entries(exirUrls).map(async ([name, url]) => [name, await getJson(fetchImpl, url, timeoutMs)]))
      .then(rows => Object.fromEntries(rows)),
    Promise.all(Object.entries(wallexUrls).map(async ([name, url]) => [name, await getJson(fetchImpl, url, timeoutMs)]))
      .then(rows => Object.fromEntries(rows)),
    Promise.all(Object.entries(tabdealUrls).map(async ([name, url]) => [name, await getJson(fetchImpl, url, timeoutMs)]))
      .then(rows => Object.fromEntries(rows))
  ]);

  const exir = assessExir({
    health: exirResults.health.ok ? exirResults.health.payload : null,
    constants: exirResults.constants.ok ? exirResults.constants.payload : null,
    ticker: exirResults.ticker.ok ? exirResults.ticker.payload : null
  }, exirResults.orderbook.ok ? exirResults.orderbook.payload : null,
  exirResults.trades.ok ? exirResults.trades.payload : null, referenceQuantityBtc);

  const wallex = assessWallex({
    markets: wallexResults.markets.ok ? wallexResults.markets.payload : null,
    otcMarkets: wallexResults.otcMarkets.ok ? wallexResults.otcMarkets.payload : null,
    trades: wallexResults.trades.ok ? wallexResults.trades.payload : null
  }, wallexResults.depth.ok ? wallexResults.depth.payload : null, null, referenceQuantityBtc);

  const tabdeal = assessTabdeal({
    exchangeInfo: tabdealResults.exchangeInfo.ok ? tabdealResults.exchangeInfo.payload : null
  }, tabdealResults.depth.ok ? tabdealResults.depth.payload : null, referenceQuantityBtc);

  const providers = [
    { ...exir, endpointChecks: callSummary(exirResults) },
    { ...wallex, endpointChecks: callSummary(wallexResults) },
    { ...tabdeal, endpointChecks: callSummary(tabdealResults) }
  ];

  return {
    capturedAt: now().toISOString(),
    mode: "unauthenticated_public_GET_only",
    comparisonQuantityBtc: String(referenceQuantityBtc),
    comparisonQuantitySource: "previous Tabdeal read-only sell preflight; illustrative only, not a current account read",
    providers,
    safety: {
      privateEndpointsCalled: false,
      apiKeysUsed: false,
      authenticatedRequestsMade: false,
      ordersSubmitted: false,
      exchangeOrdersPlaced: 0,
      cancellationsSent: false,
      fundsMoved: false,
      withdrawalsRequested: false
    },
    interpretation: "Public API reachability and market metadata are indicative only. This report does not verify account access, KYC eligibility, private API permissions, exact fees, reliability under load, or order execution. Recheck live limits immediately before any account migration."
  };
}
