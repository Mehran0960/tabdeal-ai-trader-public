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
      closeTimeMs: (openTimeSeconds * 1000) + INTERVAL_MS - 1,
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
  // Require liquidity independently on both sides; aggregate depth can hide an unusable ask or bid book.
  const bidDepthPass = bidDepth25Quote >= MIN_DEPTH_25_QUOTE;
  const askDepthPass = askDepth25Quote >= MIN_DEPTH_25_QUOTE;
  const depthPass = bidDepthPass && askDepthPass;
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
    bidDepthPass,
    askDepthPass,
    spreadPass: spreadBps <= MAX_SPREAD_BPS,
    depthPass
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


export function buildShadowHealth(report, {nowMs = Date.now(), maxAgeMs = 30 * 60 * 1000} = {}) {
  if (!isRecord(report) || typeof report.capturedAt !== "string" ||
      !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    return {status: "invalid_report", latestScan: null, ageMs: null, fresh: false};
  }
  const capturedAtMs = Date.parse(report.capturedAt);
  if (!Number.isFinite(capturedAtMs) || capturedAtMs <= 0) {
    return {status: "invalid_report_time", latestScan: null, ageMs: null, fresh: false};
  }
  const ageMs = Math.max(0, nowMs - capturedAtMs);
  const fresh = nowMs >= capturedAtMs && ageMs <= maxAgeMs;
  return {
    status: fresh ? "fresh" : "stale",
    latestScan: report.capturedAt,
    ageMs,
    fresh,
    expectedCadenceMinutes: 15,
    maxAgeMinutes: Math.floor(maxAgeMs / 60_000)
  };
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


const TRADE_STREAM_SYMBOL = "BTCUSDT";
const TRADE_STREAM_LIMIT = 1000;
const TRADE_STREAM_MAX_AGE_MS = 180_000;
const TRADE_STREAM_LEASE_MS = 45_000;
const TRADE_STREAM_RETENTION_DAYS = 90;
const TRADE_CANDLE_MS = 60_000;

function tradeId(value) {
  const text = String(value ?? "");
  if (!/^\d{1,30}$/.test(text)) return null;
  try { return BigInt(text) > 0n ? text : null; } catch { return null; }
}
function tradeDecimal(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? text : null;
}
function tradeDecimalUnits(value) {
  const text = String(value);
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * (10n ** 18n) + BigInt(fraction.padEnd(18, "0"));
}
function formatTradeDecimal(units) {
  const base = 10n ** 18n;
  const whole = units / base;
  const fraction = (units % base).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? whole.toString() + "." + fraction : whole.toString();
}
function addTradeDecimals(left, right) {
  return formatTradeDecimal(tradeDecimalUnits(left) + tradeDecimalUnits(right));
}
function multiplyTradeDecimals(left, right) {
  const scale = 10n ** 18n;
  return formatTradeDecimal((tradeDecimalUnits(left) * tradeDecimalUnits(right)) / scale);
}
function compareTradeDecimals(left, right) {
  const a = tradeDecimalUnits(left), b = tradeDecimalUnits(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeTabdealSpotTrades(payload, capturedAtMs = Date.now()) {
  if (!Array.isArray(payload) || payload.length > TRADE_STREAM_LIMIT) {
    throw new Error("tabdeal_trade_payload_invalid");
  }
  const rows = payload.map(row => {
    if (!isRecord(row)) throw new Error("tabdeal_trade_record_invalid");
    const id = tradeId(row.id);
    const price = tradeDecimal(row.price);
    const quantity = tradeDecimal(row.qty);
    const timeMs = Number(row.time);
    if (!id || !price || !quantity ||
        !Number.isSafeInteger(timeMs) || timeMs <= 0 ||
        typeof row.isBuyerMaker !== "boolean" ||
        timeMs > capturedAtMs + 30_000) {
      throw new Error("tabdeal_trade_fields_invalid");
    }
    // Tabdeal's recent-trades quoteQty is not consistent across the sampled rows.
    // Derive quote volume from execution price × base quantity instead.
    const quoteQuantity = multiplyTradeDecimals(price, quantity);
    return {id, price, quantity, quoteQuantity, timeMs, isBuyerMaker: row.isBuyerMaker};
  }).sort((a, b) => {
    const left = BigInt(a.id), right = BigInt(b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const seen = new Set();
  let previousTimeMs = 0;
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error("tabdeal_trade_duplicate_id");
    seen.add(row.id);
    if (row.timeMs < previousTimeMs) throw new Error("tabdeal_trade_id_time_order_invalid");
    previousTimeMs = row.timeMs;
  }
  return rows;
}

export function assessTabdealTradePageCoverage(rows, state, limit = TRADE_STREAM_LIMIT) {
  if (!Array.isArray(rows)) throw new Error("tabdeal_trade_rows_invalid");
  if (!state?.last_trade_id) return {status: "baseline_required", newTrades: rows};
  if (!rows.length) return {status: "no_new_trades", newTrades: []};
  const priorId = BigInt(state.last_trade_id);
  const latestId = BigInt(rows.at(-1).id);
  if (latestId < priorId) return {status: "trade_id_rewind", newTrades: []};
  const lastSuccessfulPollAtMs = Number(state.last_successful_poll_at_ms);
  if (rows.length === limit &&
      (BigInt(rows[0].id) > priorId ||
       (Number.isSafeInteger(lastSuccessfulPollAtMs) &&
        rows[0].timeMs >= lastSuccessfulPollAtMs))) {
    return {status: "possible_truncation", newTrades: []};
  }
  const newTrades = rows.filter(row => BigInt(row.id) > priorId);
  const priorTradeTimeMs = Number(state.last_trade_time_ms || 0);
  if (newTrades.some(row => row.timeMs < priorTradeTimeMs)) {
    return {status: "trade_time_reversal", newTrades: []};
  }
  return {status: "complete", newTrades};
}

export function aggregateTabdealTradeCandles(rows, continuityEpoch = 0) {
  if (!Array.isArray(rows)) throw new Error("tabdeal_trade_rows_invalid");
  const sorted = [...rows].sort((a, b) => a.timeMs - b.timeMs ||
    (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  const byMinute = new Map();
  for (const trade of sorted) {
    const minuteOpenMs = Math.floor(trade.timeMs / TRADE_CANDLE_MS) * TRADE_CANDLE_MS;
    let candle = byMinute.get(minuteOpenMs);
    if (!candle) {
      candle = {
        symbol: TRADE_STREAM_SYMBOL, minute_open_ms: minuteOpenMs,
        open_price: trade.price, high_price: trade.price, low_price: trade.price, close_price: trade.price,
        base_volume: "0", quote_volume: "0", trade_count: 0,
        first_trade_time_ms: trade.timeMs, last_trade_time_ms: trade.timeMs,
        first_trade_id: trade.id, last_trade_id: trade.id,
        continuity_epoch: continuityEpoch, coverage_status: "complete"
      };
      byMinute.set(minuteOpenMs, candle);
    }
    if (compareTradeDecimals(trade.price, candle.high_price) > 0) candle.high_price = trade.price;
    if (compareTradeDecimals(trade.price, candle.low_price) < 0) candle.low_price = trade.price;
    if (trade.timeMs < candle.first_trade_time_ms) {
      candle.open_price = trade.price;
      candle.first_trade_time_ms = trade.timeMs;
      candle.first_trade_id = trade.id;
    }
    if (trade.timeMs > candle.last_trade_time_ms ||
        (trade.timeMs === candle.last_trade_time_ms && BigInt(trade.id) > BigInt(candle.last_trade_id))) {
      candle.close_price = trade.price;
      candle.last_trade_time_ms = trade.timeMs;
      candle.last_trade_id = trade.id;
    }
    candle.base_volume = addTradeDecimals(candle.base_volume, trade.quantity);
    candle.quote_volume = addTradeDecimals(candle.quote_volume, trade.quoteQuantity);
    candle.trade_count++;
  }
  return [...byMinute.values()].sort((a, b) => a.minute_open_ms - b.minute_open_ms);
}


export function buildTabdealRecentTradeCandles(rows, nowMs = Date.now(), windowMinutes = 240, continuityEpoch = 0) {
  if (!Array.isArray(rows) || ![60, 240].includes(windowMinutes)) {
    throw new Error("tabdeal_recent_backfill_input_invalid");
  }
  if (rows.length < 2) return {status: "insufficient_recent_trades", candles: []};
  const sorted = [...rows].sort((a, b) => a.timeMs - b.timeMs ||
    (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  const endMinuteMs = Math.floor(nowMs / TRADE_CANDLE_MS) * TRADE_CANDLE_MS;
  const startMinuteMs = endMinuteMs - windowMinutes * TRADE_CANDLE_MS;
  const earliest = sorted[0];
  const latest = sorted.at(-1);

  // Require an actual pre-window trade to seed carry-forward candles without inventing a price.
  const priorTrade = [...sorted].reverse().find(row => row.timeMs < startMinuteMs);
  if (!priorTrade || earliest.timeMs > startMinuteMs) {
    return {status: "insufficient_window_coverage", candles: []};
  }
  // A stale endpoint response must not be mistaken for a current rolling window.
  if (latest.timeMs < nowMs - 10 * TRADE_CANDLE_MS) {
    return {status: "stale_recent_trades", candles: []};
  }

  const inWindow = sorted.filter(row => row.timeMs >= startMinuteMs && row.timeMs < endMinuteMs);
  const actual = aggregateTabdealTradeCandles(inWindow, continuityEpoch);
  const byMinute = new Map(actual.map(candle => [candle.minute_open_ms, candle]));
  const candles = [];
  let carryPrice = priorTrade.price;

  for (let minuteOpenMs = startMinuteMs; minuteOpenMs < endMinuteMs; minuteOpenMs += TRADE_CANDLE_MS) {
    const traded = byMinute.get(minuteOpenMs);
    if (traded) {
      const candle = {...traded, coverage_status: "complete"};
      candles.push(candle);
      carryPrice = candle.close_price;
    } else {
      candles.push({
        symbol: TRADE_STREAM_SYMBOL,
        minute_open_ms: minuteOpenMs,
        open_price: carryPrice,
        high_price: carryPrice,
        low_price: carryPrice,
        close_price: carryPrice,
        base_volume: "0",
        quote_volume: "0",
        trade_count: 0,
        first_trade_time_ms: 0,
        last_trade_time_ms: 0,
        first_trade_id: "",
        last_trade_id: "",
        continuity_epoch: continuityEpoch,
        coverage_status: "no_trade"
      });
    }
  }

  return {
    status: "complete",
    windowMinutes,
    windowStartMs: startMinuteMs,
    windowEndMs: endMinuteMs,
    pageTradeCount: rows.length,
    windowTradeCount: inWindow.length,
    noTradeMinuteCount: candles.filter(candle => candle.coverage_status === "no_trade").length,
    candles
  };
}

async function persistTabdealRecentTradeBackfill(env, rows, capturedAtMs, continuityEpoch, lockToken, state) {
  const fullWindow = buildTabdealRecentTradeCandles(rows, capturedAtMs, 240, continuityEpoch);
  const backfill = fullWindow.status === "complete"
    ? fullWindow
    : buildTabdealRecentTradeCandles(rows, capturedAtMs, 60, continuityEpoch);
  if (backfill.status !== "complete") return 0;

  const existingRows = await env.DB.prepare(
    "SELECT minute_open_ms,continuity_epoch,coverage_status FROM tabdeal_spot_candles_1m " +
    "WHERE symbol=? AND minute_open_ms>=? AND minute_open_ms<?"
  ).bind(TRADE_STREAM_SYMBOL, backfill.windowStartMs, backfill.windowEndMs).all();
  const existingByMinute = new Map((existingRows.results || [])
    .map(row => [Number(row.minute_open_ms), row]));
  const newEpoch = Number(state.recent_backfill_epoch) !== Number(continuityEpoch);
  const statements = [];

  for (const candle of backfill.candles) {
    const existing = existingByMinute.get(candle.minute_open_ms);
    const existingIsUsable = existing &&
      Number(existing.continuity_epoch) === Number(continuityEpoch) &&
      ["complete", "no_trade"].includes(existing.coverage_status);
    if (!newEpoch && existingIsUsable) continue;

    statements.push(env.DB.prepare(
      "INSERT OR REPLACE INTO tabdeal_spot_candles_1m " +
      "(symbol,minute_open_ms,open_price,high_price,low_price,close_price,base_volume,quote_volume," +
      "trade_count,first_trade_time_ms,last_trade_time_ms,first_trade_id,last_trade_id," +
      "continuity_epoch,coverage_status,is_closed,updated_at_ms) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      TRADE_STREAM_SYMBOL, candle.minute_open_ms, candle.open_price, candle.high_price,
      candle.low_price, candle.close_price, candle.base_volume, candle.quote_volume,
      candle.trade_count, candle.first_trade_time_ms, candle.last_trade_time_ms,
      candle.first_trade_id, candle.last_trade_id, candle.continuity_epoch,
      candle.coverage_status, 1, capturedAtMs
    ));
  }

  // Keep D1 batches small. The epoch marker is written only after all candle batches succeed,
  // so a partial write is safe to retry on the next one-minute poll.
  for (let i = 0; i < statements.length; i += 80) {
    await env.DB.batch(statements.slice(i, i + 80));
  }
  if (newEpoch) {
    await env.DB.prepare(
      "UPDATE tabdeal_spot_trade_state SET recent_backfill_epoch=?, updated_at_ms=? " +
      "WHERE symbol=? AND lease_token=?"
    ).bind(continuityEpoch, capturedAtMs, TRADE_STREAM_SYMBOL, lockToken).run();
    state.recent_backfill_epoch = continuityEpoch;
  }
  return statements.length;
}

export function mergeTabdealTradeCandle(existing, incoming) {
  if (!existing) return {...incoming};
  if (Number(existing.continuity_epoch) !== Number(incoming.continuity_epoch) ||
      existing.coverage_status !== "complete") {
    return {...incoming, coverage_status: "partial_after_gap"};
  }
  const merged = {...existing};
  if (Number(incoming.first_trade_time_ms) < Number(existing.first_trade_time_ms)) {
    merged.open_price = incoming.open_price;
    merged.first_trade_time_ms = incoming.first_trade_time_ms;
    merged.first_trade_id = incoming.first_trade_id;
  }
  if (compareTradeDecimals(incoming.high_price, existing.high_price) > 0) merged.high_price = incoming.high_price;
  if (compareTradeDecimals(incoming.low_price, existing.low_price) < 0) merged.low_price = incoming.low_price;
  if (Number(incoming.last_trade_time_ms) > Number(existing.last_trade_time_ms) ||
      (Number(incoming.last_trade_time_ms) === Number(existing.last_trade_time_ms) &&
       BigInt(incoming.last_trade_id) > BigInt(existing.last_trade_id))) {
    merged.close_price = incoming.close_price;
    merged.last_trade_time_ms = incoming.last_trade_time_ms;
    merged.last_trade_id = incoming.last_trade_id;
  }
  merged.base_volume = addTradeDecimals(existing.base_volume, incoming.base_volume);
  merged.quote_volume = addTradeDecimals(existing.quote_volume, incoming.quote_volume);
  merged.trade_count = Number(existing.trade_count) + Number(incoming.trade_count);
  return merged;
}

export function buildTabdealTradeCaptureHealth(state, candleRows, nowMs = Date.now()) {
  if (!state) {
    return {status: "not_started", captureReady: false, fourHourHistoryReady: false,
      consecutiveClosedMinutes: 0, requiredForCaptureReady: 60, requiredForFourHourHistory: 240};
  }
  const lastSuccessfulPollAtMs = Number(state.last_successful_poll_at_ms);
  const lastTradeTimeMs = Number(state.last_trade_time_ms);
  const pollAgeMs = Number.isFinite(lastSuccessfulPollAtMs) ? nowMs - lastSuccessfulPollAtMs : null;
  const latestTradeAgeMs = Number.isFinite(lastTradeTimeMs) ? nowMs - lastTradeTimeMs : null;
  const expectedMinute = Math.floor(nowMs / TRADE_CANDLE_MS) * TRADE_CANDLE_MS - TRADE_CANDLE_MS;
  const rows = [...(Array.isArray(candleRows) ? candleRows : [])]
    .sort((a, b) => Number(b.minute_open_ms) - Number(a.minute_open_ms));
  let consecutiveClosedMinutes = 0;
  let expected = expectedMinute;
  for (const row of rows) {
    if (Number(row.minute_open_ms) !== expected ||
        Number(row.continuity_epoch) !== Number(state.continuity_epoch) ||
        !["complete", "no_trade"].includes(row.coverage_status)) break;
    consecutiveClosedMinutes++;
    expected -= TRADE_CANDLE_MS;
  }
  const statusGood = ["captured", "no_new_trades", "stale_latest_trade"].includes(state.last_poll_status);
  // A quiet market can legitimately have no recent trade; freshness is determined by the successful API poll,
  // while latestTradeAgeMs remains a diagnostic field.
  const sourceFresh = pollAgeMs !== null && pollAgeMs >= 0 && pollAgeMs <= 120_000;
  const captureReady = statusGood && sourceFresh && consecutiveClosedMinutes >= 60;
  return {
    status: captureReady ? "ready_for_extended_paper_validation"
      : sourceFresh ? "collecting_or_history_incomplete" : "stale_or_gap_blocked",
    symbol: TRADE_STREAM_SYMBOL, lastPollStatus: state.last_poll_status,
    lastSuccessfulPollAt: Number.isFinite(lastSuccessfulPollAtMs) ? new Date(lastSuccessfulPollAtMs).toISOString() : null,
    lastPollAgeMs: pollAgeMs,
    latestTradeAt: Number.isFinite(lastTradeTimeMs) ? new Date(lastTradeTimeMs).toISOString() : null,
    latestTradeAgeMs, gapCount: Number(state.gap_count || 0),
    continuityEpoch: Number(state.continuity_epoch || 0), consecutiveClosedMinutes,
    requiredForCaptureReady: 60, requiredForFourHourHistory: 240,
    captureReady, fourHourHistoryReady: statusGood && sourceFresh && consecutiveClosedMinutes >= 240,
    candleInterval: "1m", recentWindowBackfillSupported: true,
    recentBackfillCompleted: Number(state.recent_backfill_epoch) === Number(state.continuity_epoch),
    historicalBackfillAvailable: false, liveTradingEnabled: false
  };
}

function nextCompleteTradeMinute(nowMs) {
  return Math.floor(nowMs / TRADE_CANDLE_MS) * TRADE_CANDLE_MS + TRADE_CANDLE_MS;
}

async function saveTradeCaptureState(env, values, lockToken) {
  await env.DB.prepare(
    "UPDATE tabdeal_spot_trade_state SET last_successful_poll_at_ms=?, last_attempt_at_ms=?, last_trade_id=?, last_trade_time_ms=?, " +
    "eligible_from_minute_ms=?, continuity_epoch=?, gap_count=?, last_gap_at_ms=?, " +
    "last_poll_status=?, last_error_code=?, updated_at_ms=? WHERE symbol=? AND lease_token=?"
  ).bind(
    values.last_successful_poll_at_ms, values.last_attempt_at_ms, values.last_trade_id,
    values.last_trade_time_ms, values.eligible_from_minute_ms, values.continuity_epoch,
    values.gap_count, values.last_gap_at_ms, values.last_poll_status, values.last_error_code,
    values.updated_at_ms, TRADE_STREAM_SYMBOL, lockToken
  ).run();
}

export async function pollTabdealSpotTrades(env, {
  fetchImpl = fetch, now = () => Date.now(), apiBase = TABDEAL_API
} = {}) {
  const startedAtMs = now();
  const lockToken = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tabdeal_spot_trade_state " +
    "(symbol,last_poll_status,continuity_epoch,gap_count,lease_until_ms,updated_at_ms) " +
    "VALUES (?,'uninitialized',0,0,0,?)"
  ).bind(TRADE_STREAM_SYMBOL, startedAtMs).run();
  const lock = await env.DB.prepare(
    "UPDATE tabdeal_spot_trade_state SET lease_token=?, lease_until_ms=?, last_attempt_at_ms=?, updated_at_ms=? " +
    "WHERE symbol=? AND lease_until_ms < ?"
  ).bind(lockToken, startedAtMs + TRADE_STREAM_LEASE_MS, startedAtMs, startedAtMs,
    TRADE_STREAM_SYMBOL, startedAtMs).run();
  if (Number(lock.meta?.changes || 0) !== 1) {
    return {status: "skipped_lock_held", symbol: TRADE_STREAM_SYMBOL, ordersPlaced: 0};
  }
  try {
    const url = new URL(apiBase.replace(/\/+$/, "") + "/trades");
    url.searchParams.set("symbol", TRADE_STREAM_SYMBOL);
    url.searchParams.set("limit", String(TRADE_STREAM_LIMIT));
    const response = await fetchImpl(url, {
      method: "GET", headers: {accept: "application/json"}, signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error("tabdeal_trade_http_" + response.status);
    const trades = normalizeTabdealSpotTrades(await response.json(), now());
    const capturedAtMs = now();
    const state = await env.DB.prepare(
      "SELECT * FROM tabdeal_spot_trade_state WHERE symbol=?"
    ).bind(TRADE_STREAM_SYMBOL).first();

    if (!trades.length) {
      const values = {
        last_successful_poll_at_ms: capturedAtMs, last_attempt_at_ms: capturedAtMs,
        last_trade_id: state.last_trade_id, last_trade_time_ms: state.last_trade_time_ms,
        eligible_from_minute_ms: state.eligible_from_minute_ms ?? nextCompleteTradeMinute(capturedAtMs),
        continuity_epoch: Number(state.continuity_epoch || 0), gap_count: Number(state.gap_count || 0),
        last_gap_at_ms: state.last_gap_at_ms, last_poll_status: "no_new_trades",
        last_error_code: null, updated_at_ms: capturedAtMs
      };
      await saveTradeCaptureState(env, values, lockToken);
      return {status: values.last_poll_status, newTradeCount: 0, barsUpdated: 0, ordersPlaced: 0};
    }

    const latest = trades.at(-1);
    if (!state.last_trade_id) {
      const values = {
        last_successful_poll_at_ms: capturedAtMs, last_attempt_at_ms: capturedAtMs,
        last_trade_id: latest.id, last_trade_time_ms: latest.timeMs,
        eligible_from_minute_ms: Math.floor(capturedAtMs / TRADE_CANDLE_MS) * TRADE_CANDLE_MS,
        continuity_epoch: Number(state.continuity_epoch || 0), gap_count: Number(state.gap_count || 0),
        last_gap_at_ms: state.last_gap_at_ms, last_poll_status: "baseline_started",
        last_error_code: null, updated_at_ms: capturedAtMs
      };
      await saveTradeCaptureState(env, values, lockToken);
      const backfilledBars = await persistTabdealRecentTradeBackfill(
        env, trades, capturedAtMs, values.continuity_epoch, lockToken, state
      );
      return {status: values.last_poll_status, newTradeCount: 0, barsUpdated: backfilledBars, recentBackfillBars: backfilledBars, ordersPlaced: 0};
    }

    const coverage = assessTabdealTradePageCoverage(trades, state);
    if (["possible_truncation", "trade_id_rewind", "trade_time_reversal"].includes(coverage.status)) {
      const values = {
        last_successful_poll_at_ms: capturedAtMs, last_attempt_at_ms: capturedAtMs,
        last_trade_id: latest.id, last_trade_time_ms: latest.timeMs,
        eligible_from_minute_ms: nextCompleteTradeMinute(capturedAtMs),
        continuity_epoch: Number(state.continuity_epoch || 0) + 1,
        gap_count: Number(state.gap_count || 0) + 1, last_gap_at_ms: capturedAtMs,
        last_poll_status: coverage.status, last_error_code: null, updated_at_ms: capturedAtMs
      };
      await saveTradeCaptureState(env, values, lockToken);
      const backfilledBars = await persistTabdealRecentTradeBackfill(
        env, trades, capturedAtMs, values.continuity_epoch, lockToken, state
      );
      return {status: values.last_poll_status, newTradeCount: 0, barsUpdated: backfilledBars, recentBackfillBars: backfilledBars, ordersPlaced: 0};
    }

    const newTrades = coverage.newTrades;
    if (!newTrades.length) {
      const age = capturedAtMs - latest.timeMs;
      const values = {
        last_successful_poll_at_ms: capturedAtMs, last_attempt_at_ms: capturedAtMs,
        last_trade_id: state.last_trade_id, last_trade_time_ms: state.last_trade_time_ms,
        eligible_from_minute_ms: state.eligible_from_minute_ms,
        continuity_epoch: Number(state.continuity_epoch || 0), gap_count: Number(state.gap_count || 0),
        last_gap_at_ms: state.last_gap_at_ms,
        last_poll_status: age > TRADE_STREAM_MAX_AGE_MS ? "stale_latest_trade" : "no_new_trades",
        last_error_code: null, updated_at_ms: capturedAtMs
      };
      await saveTradeCaptureState(env, values, lockToken);
      const backfilledBars = await persistTabdealRecentTradeBackfill(
        env, trades, capturedAtMs, values.continuity_epoch, lockToken, state
      );
      return {status: values.last_poll_status, newTradeCount: 0, barsUpdated: backfilledBars, recentBackfillBars: backfilledBars, ordersPlaced: 0};
    }

    const age = capturedAtMs - latest.timeMs;
    // The trade-ID cursor already removes duplicates. Retain every unseen trade, including
    // late-in-minute trades that arrive just after a poll boundary.
    const eligibleFrom = Number(state.eligible_from_minute_ms || 0);
    const eligibleTrades = newTrades;
    const buckets = aggregateTabdealTradeCandles(eligibleTrades, Number(state.continuity_epoch || 0));
    const statements = [];
    for (const bucket of buckets) {
      const existing = await env.DB.prepare(
        "SELECT * FROM tabdeal_spot_candles_1m WHERE symbol=? AND minute_open_ms=?"
      ).bind(TRADE_STREAM_SYMBOL, bucket.minute_open_ms).first();
      const merged = mergeTabdealTradeCandle(existing, bucket);
      const isClosed = bucket.minute_open_ms + TRADE_CANDLE_MS <= capturedAtMs;
      statements.push(env.DB.prepare(
        "INSERT OR REPLACE INTO tabdeal_spot_candles_1m " +
        "(symbol,minute_open_ms,open_price,high_price,low_price,close_price,base_volume,quote_volume," +
        "trade_count,first_trade_time_ms,last_trade_time_ms,first_trade_id,last_trade_id," +
        "continuity_epoch,coverage_status,is_closed,updated_at_ms) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        TRADE_STREAM_SYMBOL, merged.minute_open_ms, merged.open_price, merged.high_price,
        merged.low_price, merged.close_price, merged.base_volume, merged.quote_volume,
        merged.trade_count, merged.first_trade_time_ms, merged.last_trade_time_ms,
        merged.first_trade_id, merged.last_trade_id, merged.continuity_epoch,
        merged.coverage_status, isClosed ? 1 : 0, capturedAtMs
      ));
    }
    const latestAccepted = newTrades.at(-1);
    const values = {
      last_successful_poll_at_ms: capturedAtMs, last_attempt_at_ms: capturedAtMs,
      last_trade_id: latestAccepted.id, last_trade_time_ms: latestAccepted.timeMs,
      eligible_from_minute_ms: eligibleFrom, continuity_epoch: Number(state.continuity_epoch || 0),
      gap_count: Number(state.gap_count || 0), last_gap_at_ms: state.last_gap_at_ms,
      last_poll_status: age > TRADE_STREAM_MAX_AGE_MS ? "stale_latest_trade" : "captured",
      last_error_code: null, updated_at_ms: capturedAtMs
    };
    statements.push(env.DB.prepare(
      "UPDATE tabdeal_spot_trade_state SET last_successful_poll_at_ms=?, last_attempt_at_ms=?, " +
      "last_trade_id=?, last_trade_time_ms=?, eligible_from_minute_ms=?, continuity_epoch=?, " +
      "gap_count=?, last_gap_at_ms=?, last_poll_status=?, last_error_code=?, updated_at_ms=? " +
      "WHERE symbol=? AND lease_token=?"
    ).bind(
      values.last_successful_poll_at_ms, values.last_attempt_at_ms, values.last_trade_id,
      values.last_trade_time_ms, values.eligible_from_minute_ms, values.continuity_epoch,
      values.gap_count, values.last_gap_at_ms, values.last_poll_status, values.last_error_code,
      values.updated_at_ms, TRADE_STREAM_SYMBOL, lockToken
    ));
    await env.DB.batch(statements);
    const backfilledBars = await persistTabdealRecentTradeBackfill(
      env, trades, capturedAtMs, values.continuity_epoch, lockToken, state
    );

    if (new Date(capturedAtMs).getUTCHours() === 3 && new Date(capturedAtMs).getUTCMinutes() === 0) {
      await env.DB.prepare(
        "DELETE FROM tabdeal_spot_candles_1m WHERE symbol=? AND minute_open_ms < ?"
      ).bind(TRADE_STREAM_SYMBOL, capturedAtMs - TRADE_STREAM_RETENTION_DAYS * 86_400_000).run();
    }
    return {
      status: values.last_poll_status, newTradeCount: newTrades.length,
      eligibleTradeCount: eligibleTrades.length, barsUpdated: buckets.length + backfilledBars,
      recentBackfillBars: backfilledBars, ordersPlaced: 0
    };
  } catch (error) {
    const message = String(error?.message || "");
    const code = /^[a-z0-9_]+$/.test(message) ? message : "tabdeal_trade_capture_failed";
    await env.DB.prepare(
      "UPDATE tabdeal_spot_trade_state SET last_attempt_at_ms=?, last_poll_status='fetch_error', " +
      "last_error_code=?, updated_at_ms=? WHERE symbol=? AND lease_token=?"
    ).bind(now(), code, now(), TRADE_STREAM_SYMBOL, lockToken).run();
    return {status: "fetch_error", errorCode: code, ordersPlaced: 0};
  } finally {
    await env.DB.prepare(
      "UPDATE tabdeal_spot_trade_state SET lease_token=NULL, lease_until_ms=0 WHERE symbol=? AND lease_token=?"
    ).bind(TRADE_STREAM_SYMBOL, lockToken).run();
  }
}

async function readTabdealTradeCaptureHealth(env, nowMs = Date.now()) {
  const state = await env.DB.prepare(
    "SELECT * FROM tabdeal_spot_trade_state WHERE symbol=?"
  ).bind(TRADE_STREAM_SYMBOL).first();
  const rows = await env.DB.prepare(
    "SELECT minute_open_ms,continuity_epoch,coverage_status,trade_count FROM tabdeal_spot_candles_1m " +
    "WHERE symbol=? AND is_closed=1 ORDER BY minute_open_ms DESC LIMIT 240"
  ).bind(TRADE_STREAM_SYMBOL).all();
  return buildTabdealTradeCaptureHealth(state, rows.results || [], nowMs);
}


export function shouldRunTabdealQuarterHourScan(event, nowMs = Date.now()) {
  const rawScheduledTime = Number(event?.scheduledTime);
  let scheduledAtMs = nowMs;
  if (Number.isSafeInteger(rawScheduledTime) && rawScheduledTime > 0) {
    // Scheduled event telemetry/runtime values may be epoch seconds or milliseconds.
    scheduledAtMs = rawScheduledTime < 1_000_000_000_000
      ? rawScheduledTime * 1000
      : rawScheduledTime;
  }
  return new Date(scheduledAtMs).getUTCMinutes() % 15 === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({error: "method_not_allowed"}, 405);
    if (url.pathname === "/market-data/health") {
      try {
        return json({provider: "TABDEAL", market: "SPOT", ...await readTabdealTradeCaptureHealth(env)});
      } catch {
        return json({provider: "TABDEAL", market: "SPOT", status: "unavailable", captureReady: false}, 503);
      }
    }
    if (url.pathname === "/health") {
      const row = await env.DB.prepare(
        "SELECT report_json FROM shadow_scans ORDER BY captured_at DESC LIMIT 1"
      ).first();
      if (!row?.report_json) {
        return json({status: "no_shadow_scan_yet", fresh: false}, 503);
      }
      const report = JSON.parse(row.report_json);
      let tradeCapture;
      try {
        tradeCapture = await readTabdealTradeCaptureHealth(env);
      } catch {
        tradeCapture = {status: "unavailable", captureReady: false, fourHourHistoryReady: false};
      }
      return json({...report, tradeCapture, health: buildShadowHealth(report)});
    }
    // Scans run only on the scheduled trigger. Do not expose a public endpoint
    // that lets arbitrary callers fan out requests to upstream exchange APIs.
    return json({error: "not_found"}, 404);
  },
  async scheduled(event, env) {
    // One lightweight public trade poll per minute builds exchange-local 1m candles.
    // The existing 15m shadow scan reuses this same Worker and schedule.
    const tasks = [pollTabdealSpotTrades(env)];
    if (shouldRunTabdealQuarterHourScan(event)) {
      tasks.push(runScan(env));
    }
    const outcomes = await Promise.allSettled(tasks);
    if (outcomes.some(item => item.status === "rejected")) {
      throw new Error("tabdeal_shadow_scheduled_task_failed");
    }
  }
};
