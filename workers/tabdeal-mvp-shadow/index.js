const KRAKEN_OHLC = "https://api.kraken.com/0/public/OHLC";
const TABDEAL_API = "https://api1.tabdeal.org/r/api/v1";
const SYMBOL = "BTCUSDT";
const INTERVAL = "4h";
const INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAX_CANDLE_AGE_MS = INTERVAL_MS + 15 * 60 * 1000;
const MAX_SPREAD_BPS = 30;
const MIN_DEPTH_25_QUOTE = 1_000;
const MAX_BOOK_FETCH_MS = 8_000;
const RETENTION_DAYS = 30;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}
function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
async function getJson(url, timeoutMs = MAX_BOOK_FETCH_MS) {
  const response = await fetch(url, {
    method: "GET",
    headers: {accept: "application/json"},
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error("public_get_http_" + response.status);
  return response.json();
}
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < values.length; i++) {
    result = alpha * values[i] + (1 - alpha) * result;
  }
  return result;
}
function normalizeKrakenOhlc(payload, nowMs) {
  if (!isRecord(payload) || !Array.isArray(payload.error) || payload.error.length) {
    throw new Error("kraken_ohlc_payload_error");
  }
  if (!isRecord(payload.result)) throw new Error("kraken_ohlc_result_invalid");
  const rows = Object.entries(payload.result)
    .find(([key, value]) => key !== "last" && Array.isArray(value))?.[1];
  if (!Array.isArray(rows)) throw new Error("kraken_xbtusd_ohlc_rows_missing");

  const candles = [];
  let priorOpen = null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) throw new Error("kraken_ohlc_row_invalid");
    const openTimeSeconds = Number(row[0]);
    const candle = {
      openTimeMs: openTimeSeconds * 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[6]),
      tradeCount: Number(row[7])
    };
    if (!Number.isSafeInteger(openTimeSeconds) ||
        !Number.isSafeInteger(candle.openTimeMs) ||
        candle.openTimeMs <= 0 || candle.openTimeMs % INTERVAL_MS !== 0 ||
        ![candle.open, candle.high, candle.low, candle.close].every(positive) ||
        !nonNegative(candle.volume) ||
        !Number.isSafeInteger(candle.tradeCount) || candle.tradeCount < 0 ||
        candle.high < Math.max(candle.open, candle.close, candle.low) ||
        candle.low > Math.min(candle.open, candle.close, candle.high)) {
      throw new Error("kraken_ohlc_candle_invalid");
    }
    if (priorOpen !== null && candle.openTimeMs - priorOpen !== INTERVAL_MS) {
      throw new Error("kraken_4h_history_gap");
    }
    priorOpen = candle.openTimeMs;
    // Kraken always includes the current, uncommitted interval; never use it.
    if (candle.openTimeMs + INTERVAL_MS <= nowMs) candles.push(candle);
  }
  if (candles.length < 60) throw new Error("kraken_4h_history_insufficient");
  const latest = candles.at(-1);
  const latestClosedAtMs = latest.openTimeMs + INTERVAL_MS;
  const age = nowMs - latestClosedAtMs;
  if (age < 0 || age > MAX_CANDLE_AGE_MS) throw new Error("kraken_4h_latest_candle_stale");
  return {candles, age};
}
function marketRules(market) {
  const find = type => Array.isArray(market.filters)
    ? market.filters.find(item => isRecord(item) && item.filterType === type) || null
    : null;
  const lot = find("LOT_SIZE");
  const notional = find("MIN_NOTIONAL") || find("NOTIONAL");
  const price = find("PRICE_FILTER");
  return {
    minQty: lot?.minQty ?? null,
    stepSize: lot?.stepSize ?? null,
    minNotional: notional?.minNotional ?? null,
    tickSize: price?.tickSize ?? null,
    baseAssetPrecision: Number.isInteger(market.baseAssetPrecision) ? market.baseAssetPrecision : null,
    quoteAssetPrecision: Number.isInteger(market.quoteAssetPrecision) ? market.quoteAssetPrecision : null
  };
}
function normalizeTabdealMarket(payload) {
  if (!Array.isArray(payload)) throw new Error("tabdeal_exchange_info_invalid");
  const matches = payload.filter(item => isRecord(item) && String(item.symbol || "").toUpperCase() === SYMBOL);
  if (matches.length !== 1) throw new Error("tabdeal_btcusdt_market_missing_or_duplicated");
  const market = matches[0];
  if (String(market.status || "").toUpperCase() !== "TRADING" ||
      String(market.baseAsset || "").toUpperCase() !== "BTC" ||
      String(market.quoteAsset || "").toUpperCase() !== "USDT" ||
      market.isSpotTradingAllowed !== true ||
      !Array.isArray(market.permissions) || !market.permissions.includes("SPOT")) {
    throw new Error("tabdeal_btcusdt_not_active_spot");
  }
  return {symbol: SYMBOL, status: "TRADING", quoteAsset: "USDT", rules: marketRules(market)};
}
function normalizeTabdealBook(depth, nowMs, requestDurationMs) {
  if (!isRecord(depth) || !Array.isArray(depth.bids) || !Array.isArray(depth.asks)) {
    throw new Error("tabdeal_depth_payload_invalid");
  }
  const levels = rows => rows.map(row => {
    if (!Array.isArray(row) || row.length < 2) return null;
    const price = Number(row[0]), quantity = Number(row[1]);
    return positive(price) && positive(quantity) ? [price, quantity] : null;
  }).filter(Boolean);
  const bids = levels(depth.bids).sort((a,b) => b[0] - a[0]);
  const asks = levels(depth.asks).sort((a,b) => a[0] - b[0]);
  if (!bids.length || !asks.length || asks[0][0] <= bids[0][0]) {
    throw new Error("tabdeal_depth_empty_or_crossed");
  }
  const bestBid = bids[0][0], bestAsk = asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = (bestAsk - bestBid) / mid * 10_000;
  const bound = 0.0025;
  const bidDepth25Quote = bids.filter(([price]) => price >= mid * (1-bound))
    .reduce((sum, [price, qty]) => sum + price * qty, 0);
  const askDepth25Quote = asks.filter(([price]) => price <= mid * (1+bound))
    .reduce((sum, [price, qty]) => sum + price * qty, 0);
  const depth25Quote = bidDepth25Quote + askDepth25Quote;
  return {
    symbol: SYMBOL,
    quoteUnit: "USDT",
    observedAt: new Date(nowMs).toISOString(),
    requestDurationMs,
    bestBid,
    bestAsk,
    spreadBps,
    bidDepth25Quote,
    askDepth25Quote,
    depth25Quote,
    spreadPass: spreadBps <= MAX_SPREAD_BPS,
    depthPass: depth25Quote >= MIN_DEPTH_25_QUOTE
  };
}
function errorCode(error, fallback) {
  const message = String(error?.message || "");
  return /^[a-z0-9_]+$/.test(message) ? message : fallback;
}

export function evaluateTabdealMvpShadow({
  krakenOhlc,
  tabdealExchangeInfo,
  tabdealDepth,
  nowMs = Date.now(),
  bookRequestDurationMs = 0
} = {}) {
  const report = {
    schemaVersion: 1,
    reportType: "TABDEAL_BTCUSDT_LEAN_SPOT_SHADOW",
    capturedAt: new Date(nowMs).toISOString(),
    instrument: {symbol: SYMBOL, venue: "TABDEAL", market: "SPOT", quoteAsset: "USDT"},
    signalSource: {provider: "KRAKEN_SPOT", symbol: "XBTUSD", quoteAsset: "USD", interval: INTERVAL,
      contextOnly: true, executableTabdealQuote: false},
    data: {status: "not_ready", candleCount: 0, latestClosedAt: null, latestClosedAgeMs: null},
    trend: {state: "UNKNOWN", ema20: null, ema50: null, latestClose: null},
    localMarket: {status: "not_ready", spreadBps: null, depth25Quote: null, rules: null},
    researchGate: {approvedStrategyExists: false, status: "BLOCKED_NO_RESEARCH_QUALIFIED_STRATEGY"},
    decision: "WAIT",
    executionGate: "BLOCKED_NO_RESEARCH_QUALIFIED_STRATEGY",
    ordersCreated: 0,
    liveTradingEnabled: false,
    safety: {publicGetOnly: true, privateCredentialsUsed: false, accountDataRead: false,
      orderSubmissionAttempted: false, exchangeOrdersPlaced: 0, fundsMoved: false}
  };
  let candles;
  try {
    const normalized = normalizeKrakenOhlc(krakenOhlc, nowMs);
    candles = normalized.candles;
    const closes = candles.map(row => row.close);
    report.data = {
      status: "usable",
      candleCount: candles.length,
      latestClosedAt: new Date(candles.at(-1).closeTimeMs + 1).toISOString(),
      latestClosedAgeMs: normalized.age,
      gaps: 0
    };
    report.trend = {
      state: "SIDEWAYS",
      ema20: ema(closes, 20),
      ema50: ema(closes, 50),
      latestClose: closes.at(-1)
    };
    if (report.trend.ema20 > report.trend.ema50 && closes.at(-1) > report.trend.ema20) {
      report.trend.state = "UP_TREND_WATCH";
    } else if (report.trend.ema20 < report.trend.ema50 && closes.at(-1) < report.trend.ema20) {
      report.trend.state = "DOWN_TREND";
    }
  } catch (error) {
    const safeMessage = String(error?.message || "").slice(0, 120);
    report.data = {
      status: "invalid_or_stale",
      errorCode: errorCode(error, "kraken_history_invalid"),
      errorType: String(error?.name || "Error").slice(0, 40),
      errorDetail: /^[A-Za-z0-9 _:-]+$/.test(safeMessage) ? safeMessage : "normalization_failed"
    };
  }
  try {
    const market = normalizeTabdealMarket(tabdealExchangeInfo);
    const book = normalizeTabdealBook(tabdealDepth, nowMs, bookRequestDurationMs);
    report.localMarket = {
      status: book.spreadPass && book.depthPass ? "usable_snapshot" : "liquidity_gate_failed",
      ...book,
      rules: market.rules
    };
  } catch (error) {
    report.localMarket = {status: "invalid_or_unavailable", errorCode: errorCode(error, "tabdeal_market_invalid")};
  }
  if (report.data.status !== "usable") {
    report.executionGate = "BLOCKED_KRAKEN_DATA";
  } else if (!["usable_snapshot"].includes(report.localMarket.status)) {
    report.executionGate = "BLOCKED_TABDEAL_LOCAL_BOOK";
  }
  // A research failure always vetoes execution, even when the current trend looks bullish.
  report.decision = "WAIT";
  report.researchGate.status = "BLOCKED_NO_RESEARCH_QUALIFIED_STRATEGY";
  report.executionGate = report.executionGate.startsWith("BLOCKED_") && report.executionGate !== "BLOCKED_NO_RESEARCH_QUALIFIED_STRATEGY"
    ? report.executionGate : "BLOCKED_NO_RESEARCH_QUALIFIED_STRATEGY";
  return report;
}

async function runScan(env, fetchImpl = fetch, now = () => Date.now()) {
  const startedAt = now();
  let krakenOhlc = null, tabdealExchangeInfo = null, tabdealDepth = null;
  let bookRequestDurationMs = null;
  const sourceErrors = {};
  const requests = [
    getJson(KRAKEN_OHLC + "?pair=XBTUSD&interval=240", 10_000)
      .then(value => { krakenOhlc = value; })
      .catch(error => { sourceErrors.kraken = errorCode(error, "kraken_ohlc_fetch_failed"); }),
    getJson(TABDEAL_API + "/exchangeInfo", 8_000)
      .then(value => { tabdealExchangeInfo = value; })
      .catch(error => { sourceErrors.tabdealExchangeInfo = errorCode(error, "tabdeal_exchange_info_fetch_failed"); })
  ];
  const bookStarted = now();
  requests.push(
    getJson(TABDEAL_API + "/depth?symbol=" + SYMBOL + "&limit=20", 8_000)
      .then(value => { tabdealDepth = value; bookRequestDurationMs = Math.max(0, now() - bookStarted); })
      .catch(error => {
        sourceErrors.tabdealDepth = errorCode(error, "tabdeal_depth_fetch_failed");
        bookRequestDurationMs = Math.max(0, now() - bookStarted);
      })
  );
  await Promise.all(requests);
  const report = evaluateTabdealMvpShadow({
    krakenOhlc, tabdealExchangeInfo, tabdealDepth, nowMs: now(),
    bookRequestDurationMs: bookRequestDurationMs ?? -1
  });
  report.scanDurationMs = Math.max(0, now() - startedAt);
  report.sourceErrors = sourceErrors;
  report.scanId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO shadow_scans (scan_id,captured_at,source_status,signal_state,execution_gate,report_json) VALUES (?,?,?,?,?,?)"
  ).bind(
    report.scanId, report.capturedAt, report.data.status + "|" + report.localMarket.status,
    report.trend.state, report.executionGate, JSON.stringify(report)
  ).run();
  await env.DB.prepare(
    "DELETE FROM shadow_scans WHERE captured_at < ?"
  ).bind(new Date(now() - RETENTION_DAYS * 86_400_000).toISOString()).run();
  return report;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({error: "method_not_allowed"}, 405);
    if (url.pathname === "/health") {
      const row = await env.DB.prepare(
        "SELECT report_json FROM shadow_scans ORDER BY captured_at DESC LIMIT 1"
      ).first();
      return row?.report_json ? json(JSON.parse(row.report_json)) : json({status: "no_shadow_scan_yet"}, 503);
    }
    // Scans run only on the scheduled trigger. Do not expose a public endpoint
    // that lets arbitrary callers fan out requests to upstream exchange APIs.
    return json({error: "not_found"}, 404);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScan(env).catch(() => {}));
  }
};
