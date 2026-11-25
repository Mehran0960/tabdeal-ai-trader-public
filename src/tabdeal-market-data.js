const DEFAULT_API_BASE = "https://api1.tabdeal.org/r/api/v1";

export const TABDEAL_PUBLIC_RESEARCH_SYMBOLS = Object.freeze([
  "BTCIRT", "BTCUSDT",
  "ETHIRT", "ETHUSDT",
  "SOLIRT", "SOLUSDT",
  "XRPIRT", "XRPUSDT",
  "DOGEIRT", "DOGEUSDT"
]);

export const TABDEAL_PUBLIC_TRADE_LIMIT = 1000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decimalString(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? text : null;
}

function nonNegativeDecimalString(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  return Number.isFinite(Number(text)) ? text : null;
}

function safePositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function safeTradeId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^\d{1,30}$/.test(text)) return null;
  try {
    if (BigInt(text) <= 0n) return null;
  } catch {
    return null;
  }
  return text;
}

function scaledUnits(value, scale = 12) {
  const text = String(value);
  const [whole, fraction = ""] = text.split(".");
  const digits = fraction.padEnd(scale, "0").slice(0, scale);
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt(digits || "0");
}

function formatScaled(value, scale = 12) {
  const base = 10n ** BigInt(scale);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(scale, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction ? sign + whole.toString() + "." + fraction : sign + whole.toString();
}

function sumDecimals(values) {
  const valid = values.filter(value => typeof value === "string");
  if (!valid.length) return "0";
  const total = valid.reduce((sum, value) => sum + scaledUnits(value), 0n);
  return formatScaled(total);
}

function subtractDecimals(left, right) {
  return formatScaled(scaledUnits(left) - scaledUnits(right));
}

function multiplyPriceQuantity(price, quantity) {
  const a = String(price).split(".");
  const b = String(quantity).split(".");
  const aScale = (a[1] || "").length;
  const bScale = (b[1] || "").length;
  const aUnits = BigInt(a[0] + (a[1] || ""));
  const bUnits = BigInt(b[0] + (b[1] || ""));
  const product = aUnits * bUnits;
  const scale = aScale + bScale;
  const text = product.toString().padStart(scale + 1, "0");
  if (!scale) return text;
  const result = text.slice(0, -scale) + "." + text.slice(-scale);
  return result.replace(/\.?0+$/, "");
}

function activeSpotMarket(market) {
  return isRecord(market) &&
    market.status === "TRADING" &&
    market.isSpotTradingAllowed === true &&
    Array.isArray(market.permissions) &&
    market.permissions.includes("SPOT") &&
    typeof market.symbol === "string" &&
    typeof market.baseAsset === "string" &&
    typeof market.quoteAsset === "string";
}

function summarizeOrderbook(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.bids) || !Array.isArray(payload.asks)) {
    return {status: "invalid_payload"};
  }
  const normalize = rows => rows
    .filter(row => Array.isArray(row) && row.length >= 2)
    .map(row => ({
      price: decimalString(row[0]),
      quantity: nonNegativeDecimalString(row[1])
    }))
    .filter(row => row.price !== null && row.quantity !== null && Number(row.quantity) > 0);

  const bids = normalize(payload.bids).sort((a, b) => Number(b.price) - Number(a.price));
  const asks = normalize(payload.asks).sort((a, b) => Number(a.price) - Number(b.price));
  if (!bids.length || !asks.length) {
    return {
      status: "one_sided_or_empty",
      bidLevelCount: bids.length,
      askLevelCount: asks.length,
      bookUpdateId: payload.lastUpdateId === undefined ? null : String(payload.lastUpdateId)
    };
  }

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const bidNumber = Number(bestBid);
  const askNumber = Number(bestAsk);
  if (!(bidNumber > 0) || !(askNumber > bidNumber)) {
    return {
      status: "crossed_or_invalid",
      bestBid,
      bestAsk,
      bidLevelCount: bids.length,
      askLevelCount: asks.length,
      bookUpdateId: payload.lastUpdateId === undefined ? null : String(payload.lastUpdateId)
    };
  }

  const spreadBps = ((askNumber - bidNumber) / ((askNumber + bidNumber) / 2)) * 10_000;
  const bidDepth = bids.slice(0, 5).reduce(
    (sum, row) => sum + Number(row.price) * Number(row.quantity), 0
  );
  const askDepth = asks.slice(0, 5).reduce(
    (sum, row) => sum + Number(row.price) * Number(row.quantity), 0
  );

  return {
    status: "ok",
    bestBid,
    bestAsk,
    spreadBps,
    bidDepthTop5Quote: Number.isFinite(bidDepth) ? String(bidDepth) : "0",
    askDepthTop5Quote: Number.isFinite(askDepth) ? String(askDepth) : "0",
    bidLevelCount: bids.length,
    askLevelCount: asks.length,
    bookUpdateId: payload.lastUpdateId === undefined ? null : String(payload.lastUpdateId)
  };
}

function summarizeTrades(rows, capturedAtMs, requestedTradeLimit = TABDEAL_PUBLIC_TRADE_LIMIT) {
  if (!Array.isArray(rows)) return {status: "invalid_payload"};
  if (rows.length > requestedTradeLimit) return {status: "response_exceeded_documented_limit"};

  const parsed = [];
  for (const row of rows) {
    if (!isRecord(row)) return {status: "invalid_trade_record"};
    const id = safeTradeId(row.id);
    const price = decimalString(row.price);
    const quantity = decimalString(row.qty);
    const quoteQuantity = decimalString(row.quoteQty);
    const timeMs = safePositiveInteger(row.time);
    if (!id || !price || !quantity || !quoteQuantity || !timeMs ||
        typeof row.isBuyerMaker !== "boolean") {
      return {status: "invalid_trade_fields"};
    }
    parsed.push({id, price, quantity, quoteQuantity, timeMs, isBuyerMaker: row.isBuyerMaker});
  }

  if (!parsed.length) {
    return {
      status: "empty",
      tradeCount: 0,
      requestedTradeLimit,
      pageCapped: false,
      coverageStatus: "no_trades_in_returned_window"
    };
  }

  parsed.sort((a, b) => {
    const left = BigInt(a.id), right = BigInt(b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const seenIds = new Set();
  let previousTime = 0;
  for (const trade of parsed) {
    if (seenIds.has(trade.id)) return {status: "duplicate_trade_id"};
    seenIds.add(trade.id);
    if (trade.timeMs < previousTime) return {status: "trade_id_time_order_inconsistent"};
    if (trade.timeMs > capturedAtMs + 30_000) return {status: "future_trade_timestamp"};
    previousTime = trade.timeMs;
  }

  const takerBuy = parsed.filter(trade => !trade.isBuyerMaker).map(trade => trade.quoteQuantity);
  const takerSell = parsed.filter(trade => trade.isBuyerMaker).map(trade => trade.quoteQuantity);
  const quoteVolume = sumDecimals(parsed.map(trade => trade.quoteQuantity));
  const takerBuyQuoteVolume = sumDecimals(takerBuy);
  const takerSellQuoteVolume = sumDecimals(takerSell);
  const pageCapped = parsed.length === requestedTradeLimit;
  const newestTrade = parsed[parsed.length - 1];

  return {
    status: "ok",
    tradeCount: parsed.length,
    requestedTradeLimit,
    oldestTradeId: parsed[0].id,
    newestTradeId: newestTrade.id,
    oldestTradeTimeMs: parsed[0].timeMs,
    newestTradeTimeMs: newestTrade.timeMs,
    newestTradeAgeMs: capturedAtMs - newestTrade.timeMs,
    quoteVolume,
    takerBuyQuoteVolume,
    takerSellQuoteVolume,
    netTakerBuyQuoteVolume: subtractDecimals(takerBuyQuoteVolume, takerSellQuoteVolume),
    pageCapped,
    coverageStatus: pageCapped
      ? "possible_truncation_at_" + requestedTradeLimit + "_limit"
      : "recent_unpaginated_snapshot_not_proven_complete"
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getJson(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {accept: "application/json", "user-agent": "Nobitex-AI-Trader/0.6-tabdeal-public-research"},
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error("tabdeal_public_http_" + response.status);
  return response.json();
}

export async function runTabdealPublicMarketScout({
  apiBase = process.env.TABDEAL_API_BASE || DEFAULT_API_BASE,
  symbols = TABDEAL_PUBLIC_RESEARCH_SYMBOLS,
  fetchImpl = fetch,
  sleepImpl = sleep,
  clock = () => Date.now(),
  spacingMs = 250,
  timeoutMs = 12_000,
  tradeLimit = TABDEAL_PUBLIC_TRADE_LIMIT
} = {}) {
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 10) {
    throw new Error("tabdeal_research_symbols_invalid");
  }
  if (!Number.isSafeInteger(tradeLimit) || tradeLimit < 1 || tradeLimit > TABDEAL_PUBLIC_TRADE_LIMIT) {
    throw new Error("tabdeal_research_trade_limit_invalid");
  }
  const uniqueSymbols = [...new Set(symbols.map(value => String(value).toUpperCase()))];
  if (uniqueSymbols.some(symbol => !TABDEAL_PUBLIC_RESEARCH_SYMBOLS.includes(symbol))) {
    throw new Error("tabdeal_research_symbol_not_allowlisted");
  }

  const base = String(apiBase).replace(/\/+$/, "");
  const marketPayload = await getJson(base + "/exchangeInfo", fetchImpl, timeoutMs);
  if (!Array.isArray(marketPayload) || marketPayload.length > 5000) {
    throw new Error("tabdeal_exchange_info_invalid");
  }

  const activeBySymbol = new Map();
  const duplicateSymbols = new Set();
  for (const market of marketPayload) {
    if (!activeSpotMarket(market)) continue;
    const symbol = market.symbol.trim().toUpperCase();
    if (activeBySymbol.has(symbol)) duplicateSymbols.add(symbol);
    else activeBySymbol.set(symbol, market);
  }

  const snapshots = [];
  const rejected = [];
  const errors = [];
  for (const symbol of uniqueSymbols) {
    const market = activeBySymbol.get(symbol);
    if (!market || duplicateSymbols.has(symbol)) {
      rejected.push({
        symbol,
        reason: duplicateSymbols.has(symbol) ? "conflicting_or_duplicate_active_market_metadata" : "not_active_spot_market"
      });
      continue;
    }

    const quoteAsset = market.quoteAsset.trim().toUpperCase();
    const expectedQuote = symbol.endsWith("IRT") ? "IRT" : "USDT";
    const expectedBase = symbol.slice(0, -expectedQuote.length);
    if (quoteAsset !== expectedQuote || market.baseAsset.trim().toUpperCase() !== expectedBase) {
      rejected.push({symbol, reason: "exchange_metadata_symbol_asset_mismatch"});
      continue;
    }

    let orderbook = {status: "not_fetched"};
    let trades = {status: "not_fetched"};
    const depthUrl = new URL(base + "/depth");
    depthUrl.searchParams.set("symbol", symbol);
    depthUrl.searchParams.set("limit", "20");
    try {
      orderbook = summarizeOrderbook(await getJson(depthUrl, fetchImpl, timeoutMs));
    } catch (error) {
      orderbook = {status: "fetch_error", errorCode: String(error?.message || error).slice(0, 80)};
    }

    if (spacingMs > 0) await sleepImpl(spacingMs);
    const tradesUrl = new URL(base + "/trades");
    tradesUrl.searchParams.set("symbol", symbol);
    tradesUrl.searchParams.set("limit", String(tradeLimit));
    try {
      const tradePayload = await getJson(tradesUrl, fetchImpl, timeoutMs);
      trades = summarizeTrades(tradePayload, clock(), tradeLimit);
    } catch (error) {
      trades = {status: "fetch_error", errorCode: String(error?.message || error).slice(0, 80)};
    }

    const capturedAtMs = clock();
    if (trades.status === "ok" && Number.isSafeInteger(trades.newestTradeTimeMs)) {
      trades.newestTradeAgeMs = capturedAtMs - trades.newestTradeTimeMs;
    }
    snapshots.push({
      symbol,
      baseAsset: expectedBase,
      quoteAsset,
      quoteUnitCode: quoteAsset === "IRT" ? "IRT_UNVERIFIED" : "USDT",
      marketStatus: market.status,
      isSpotTradingAllowed: market.isSpotTradingAllowed === true,
      permissions: market.permissions.filter(value => typeof value === "string").slice(0, 10),
      isMarginTradingAllowed: market.isMarginTradingAllowed === true,
      marketBaseAssetPrecision: Number.isInteger(market.baseAssetPrecision) ? market.baseAssetPrecision : null,
      marketQuoteAssetPrecision: Number.isInteger(market.quoteAssetPrecision) ? market.quoteAssetPrecision : null,
      capturedAtMs,
      orderbook,
      trades
    });
  }

  const generatedAt = new Date(clock()).toISOString();
  const validBookCount = snapshots.filter(row => row.orderbook.status === "ok").length;
  const validTradeCount = snapshots.filter(row => row.trades.status === "ok").length;
  if (!snapshots.length && !rejected.length) errors.push("no_symbols_processed");

  return {
    schemaVersion: 1,
    provider: "TABDEAL",
    generatedAt,
    scope: "public_spot_orderbook_and_recent_trade_snapshots_only",
    symbolsRequested: uniqueSymbols,
    activeSpotMarketCount: activeBySymbol.size,
    snapshots,
    rejected,
    errors,
    summary: {
      symbolsProcessed: snapshots.length,
      validOrderbooks: validBookCount,
      validTradeSnapshots: validTradeCount,
      cappedTradePages: snapshots.filter(row => row.trades.pageCapped === true).length,
      symbolsWithBookErrors: snapshots.filter(row => row.orderbook.status !== "ok").map(row => row.symbol),
      symbolsWithTradeErrors: snapshots.filter(row => !["ok", "empty"].includes(row.trades.status)).map(row => row.symbol)
    },
    methodology: {
      marketDiscovery: "official spot exchangeInfo metadata; only actively trading spot permissions",
      orderbook: "single public depth snapshot; best levels sorted from all returned levels",
      trades: "single public recent-trades response with documented maximum 1000 records; no fromId pagination or historical cursor used",
      cappedTrades: "a 1000-record response is marked as possible truncation and is not complete trade history",
      uncappedTrades: "an uncapped recent response is a snapshot only; pagination completeness is not assumed",
      priceUnits: "IRT remains IRT_UNVERIFIED; USDT remains USDT; no conversion or cross-quote joins",
      candleGeneration: "disabled; no OHLC candles are fabricated from a recent-trades page",
      freshness: "capture time is client-side; depth update ID is not an exchange timestamp"
    },
    safety: {
      publicEndpointsOnly: true,
      apiKeyUsed: false,
      apiSecretUsed: false,
      privateEndpointsUsed: false,
      writesDatabase: false,
      enablesResearchCandles: false,
      addsSymbolsToExecutionAllowlist: false,
      placesOrders: false,
      cancelsOrders: false,
      movesFunds: false,
      liveTradingEnabled: false,
      exchangeOrdersPlaced: 0
    }
  };
}
