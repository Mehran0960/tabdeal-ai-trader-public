export const TABDEAL_LOCAL_PAPER_STRATEGY = "ema9-21-50-rsi14-macd-5m-v1";
export const TABDEAL_LOCAL_PAPER_NOTIONAL_USDT = 50;
export const TABDEAL_LOCAL_PAPER_FEE_SCENARIOS_BPS = Object.freeze([10, 20, 40]);
export const TABDEAL_LOCAL_PAPER_LATENCY_BUFFER_BPS = 5;

const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const nonNegative = value => Number.isFinite(Number(value)) && Number(value) >= 0;

export function emaSeries(values, period) {
  if (!Array.isArray(values) || !Number.isSafeInteger(period) || period < 2) {
    throw new Error("tabdeal_local_ema_input_invalid");
  }
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;
  const alpha = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = current;
  for (let i = period; i < values.length; i++) {
    current = values[i] * alpha + current * (1 - alpha);
    output[i] = current;
  }
  return output;
}

export function rsiWilder(values, period = 14) {
  if (!Array.isArray(values) || !Number.isSafeInteger(period) || period < 2) {
    throw new Error("tabdeal_local_rsi_input_invalid");
  }
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function atrWilder(candles, period = 14) {
  if (!Array.isArray(candles) || !Number.isSafeInteger(period) || period < 2) {
    throw new Error("tabdeal_local_atr_input_invalid");
  }
  if (candles.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i].high_price);
    const low = Number(candles[i].low_price);
    const previousClose = Number(candles[i - 1].close_price);
    ranges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  if (ranges.length < period) return null;
  let average = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < ranges.length; i++) {
    average = (average * (period - 1) + ranges[i]) / period;
  }
  return average;
}

function parseCandle(row) {
  if (!row || typeof row !== "object") return null;
  const candle = {
    minuteOpenMs: Number(row.minute_open_ms),
    open: Number(row.open_price),
    high: Number(row.high_price),
    low: Number(row.low_price),
    close: Number(row.close_price),
    quoteVolume: Number(row.quote_volume),
    tradeCount: Number(row.trade_count),
    continuityEpoch: Number(row.continuity_epoch),
    coverageStatus: String(row.coverage_status || ""),
    isClosed: Number(row.is_closed)
  };
  if (!Number.isSafeInteger(candle.minuteOpenMs) ||
      candle.minuteOpenMs <= 0 || candle.minuteOpenMs % MINUTE_MS !== 0 ||
      ![candle.open, candle.high, candle.low, candle.close].every(positive) ||
      !nonNegative(candle.quoteVolume) ||
      !Number.isSafeInteger(candle.tradeCount) || candle.tradeCount < 0 ||
      !Number.isSafeInteger(candle.continuityEpoch) || candle.continuityEpoch < 0 ||
      candle.isClosed !== 1 ||
      !["complete", "no_trade"].includes(candle.coverageStatus) ||
      candle.high < Math.max(candle.open, candle.close, candle.low) ||
      candle.low > Math.min(candle.open, candle.close, candle.high)) return null;
  if (candle.coverageStatus === "no_trade" &&
      (candle.tradeCount !== 0 || candle.quoteVolume !== 0)) return null;
  if (candle.coverageStatus === "complete" && candle.tradeCount < 1) return null;
  return candle;
}

function aggregateFiveMinuteCandles(candles) {
  const buckets = new Map();
  for (const candle of candles) {
    const bucketOpen = Math.floor(candle.minuteOpenMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const bucket = buckets.get(bucketOpen) || [];
    bucket.push(candle);
    buckets.set(bucketOpen, bucket);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, rows]) => rows.length === 5 &&
      rows.every((row, index) => index === 0 || row.minuteOpenMs - rows[index - 1].minuteOpenMs === MINUTE_MS))
    .map(([openTime, rows]) => ({
      openTime,
      open: rows[0].open,
      high: Math.max(...rows.map(row => row.high)),
      low: Math.min(...rows.map(row => row.low)),
      close: rows.at(-1).close,
      quoteVolume: rows.reduce((sum, row) => sum + row.quoteVolume, 0),
      tradeCount: rows.reduce((sum, row) => sum + row.tradeCount, 0),
      noTrade: rows.every(row => row.coverageStatus === "no_trade")
    }));
}

function macdSnapshot(closes) {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const line = [];
  for (let i = 0; i < closes.length; i++) {
    if (fast[i] !== null && slow[i] !== null) line.push(fast[i] - slow[i]);
  }
  if (line.length < 9) return {line: null, signal: null, histogram: null};
  const signalSeries = emaSeries(line, 9);
  const signal = signalSeries.at(-1);
  const value = line.at(-1);
  return {line: value, signal, histogram: value - signal};
}

export function computeTabdealLocalIndicators(rows, {
  nowMs = Date.now(),
  pollAgeMs = 0,
  lastTradeAgeMs = 0,
  expectedBars = 240
} = {}) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(expectedBars) ||
      expectedBars < 60 || rows.length < expectedBars) {
    return {status: "not_ready", reason: "insufficient_closed_minute_candles", signal: "WAIT"};
  }
  if (!Number.isFinite(nowMs) || !Number.isFinite(pollAgeMs) ||
      !Number.isFinite(lastTradeAgeMs)) {
    return {status: "not_ready", reason: "capture_clock_invalid", signal: "WAIT"};
  }

  const source = rows.slice(-expectedBars);
  const candles = source.map(parseCandle);
  if (candles.some(row => row === null)) {
    return {status: "blocked", reason: "invalid_candle_or_coverage_metadata", signal: "WAIT"};
  }
  const epoch = candles[0].continuityEpoch;
  for (let i = 0; i < candles.length; i++) {
    const row = candles[i];
    if (row.continuityEpoch !== epoch) {
      return {status: "blocked", reason: "continuity_epoch_mismatch", signal: "WAIT"};
    }
    if (i > 0 && row.minuteOpenMs - candles[i - 1].minuteOpenMs !== MINUTE_MS) {
      return {status: "blocked", reason: "minute_candle_gap_or_order_error", signal: "WAIT"};
    }
  }
  const last = candles.at(-1);
  const lastCloseMs = last.minuteOpenMs + MINUTE_MS;
  if (lastCloseMs > nowMs + 10_000 || nowMs - lastCloseMs > 120_000) {
    return {status: "blocked", reason: "latest_closed_candle_stale_or_future", signal: "WAIT"};
  }
  if (pollAgeMs < 0 || pollAgeMs > 120_000) {
    return {status: "blocked", reason: "public_trade_poll_stale", signal: "WAIT"};
  }
  if (lastTradeAgeMs < 0 || lastTradeAgeMs > 5 * MINUTE_MS) {
    return {status: "blocked", reason: "latest_actual_trade_stale", signal: "WAIT"};
  }

  const closes = candles.map(row => row.close);
  const ema9 = emaSeries(closes, 9).at(-1);
  const ema21 = emaSeries(closes, 21).at(-1);
  const ema50 = emaSeries(closes, 50).at(-1);
  const rsi14 = rsiWilder(closes, 14);
  const atr14 = atrWilder(source, 14);
  const macd = macdSnapshot(closes);
  const fiveMinute = aggregateFiveMinuteCandles(candles);
  const fiveMinuteCloses = fiveMinute.map(row => row.close);
  const ema5m12 = fiveMinute.length >= 12 ? emaSeries(fiveMinuteCloses, 12).at(-1) : null;
  const ema5m26 = fiveMinute.length >= 26 ? emaSeries(fiveMinuteCloses, 26).at(-1) : null;

  if (![ema9, ema21, ema50, rsi14, atr14, macd.histogram, ema5m12, ema5m26].every(Number.isFinite)) {
    return {status: "not_ready", reason: "indicator_warmup_insufficient", signal: "WAIT"};
  }

  const last60 = candles.slice(-60);
  const last15 = candles.slice(-15);
  const trades60 = last60.reduce((sum, row) => sum + row.tradeCount, 0);
  const trades15 = last15.reduce((sum, row) => sum + row.tradeCount, 0);
  const noTrade60 = last60.filter(row => row.coverageStatus === "no_trade").length;
  const noTrade240 = candles.filter(row => row.coverageStatus === "no_trade").length;
  const noTradeRatio60 = noTrade60 / last60.length;
  const noTradeRatio240 = noTrade240 / candles.length;
  const atrPct = atr14 / last.close * 100;
  const dataUsable = trades60 >= 10 && trades15 >= 3 &&
    noTradeRatio60 <= 0.75 && noTradeRatio240 <= 0.75 &&
    last.coverageStatus === "complete" && fiveMinute.length >= 26;

  const indicators = {
    candleInterval: "1m",
    latestCandleOpenAt: new Date(last.minuteOpenMs).toISOString(),
    latestCandleCloseAt: new Date(lastCloseMs).toISOString(),
    latestClose: last.close,
    ema9, ema21, ema50, rsi14, atr14, atrPct,
    macdLine: macd.line, macdSignal: macd.signal, macdHistogram: macd.histogram,
    fiveMinuteBars: fiveMinute.length, ema5m12, ema5m26,
    fiveMinuteTrend: ema5m12 > ema5m26 ? "bullish" : "bearish",
    return60mPct: (last.close / candles.at(-60).open - 1) * 100,
    return240mPct: (last.close / candles[0].open - 1) * 100
  };
  const dataQuality = {
    status: dataUsable ? "usable" : "degraded",
    expectedBars, actualBars: candles.length, continuityEpoch: epoch,
    tradeCount60m: trades60, tradeCount15m: trades15,
    noTradeMinutes60m: noTrade60, noTradeMinutes240m: noTrade240,
    noTradeRatio60m: noTradeRatio60, noTradeRatio240m: noTradeRatio240,
    pollAgeMs, latestActualTradeAgeMs: lastTradeAgeMs,
    materialGapCount: 0
  };
  if (!dataUsable) {
    return {status: "degraded", reason: "local_trade_activity_or_coverage_below_gate",
      signal: "WAIT", indicators, dataQuality, candles};
  }

  const trendAligned = ema9 > ema21 && ema21 > ema50 && ema5m12 > ema5m26;
  const momentumConfirmed = rsi14 >= 50 && rsi14 <= 68 && macd.histogram > 0;
  const volatilityUsable = atrPct >= 0.02 && atrPct <= 0.6;
  const signal = trendAligned && momentumConfirmed && volatilityUsable
    ? "BUY_CANDIDATE" : "WAIT";
  const reason = signal === "BUY_CANDIDATE" ? "registered_ema_mtf_momentum_conditions_met"
    : !trendAligned ? "trend_alignment_not_confirmed"
    : !momentumConfirmed ? "momentum_confirmation_not_met"
    : "volatility_outside_registered_band";
  return {status: "ready", signal, reason, indicators, dataQuality, candles};
}

export function assessTabdealLocalPaperBook(book, {
  maxSpreadBps = 30,
  minSideDepthQuote = 1_000
} = {}) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks) ||
      !book.bids.length || !book.asks.length) {
    return {usable: false, reason: "orderbook_missing_or_empty"};
  }
  const normalize = rows => rows.map(row => ({
    price: Number(Array.isArray(row) ? row[0] : row?.price),
    quantity: Number(Array.isArray(row) ? row[1] : row?.quantity)
  })).filter(row => positive(row.price) && positive(row.quantity));
  const bids = normalize(book.bids).sort((a, b) => b.price - a.price);
  const asks = normalize(book.asks).sort((a, b) => a.price - b.price);
  if (!bids.length || !asks.length || asks[0].price <= bids[0].price) {
    return {usable: false, reason: "orderbook_crossed_or_invalid"};
  }
  const bid = bids[0].price;
  const ask = asks[0].price;
  const mid = (bid + ask) / 2;
  const spreadBps = (ask - bid) / mid * 10_000;
  const bidDepth25 = bids.filter(row => row.price >= mid * 0.9975)
    .reduce((sum, row) => sum + row.price * row.quantity, 0);
  const askDepth25 = asks.filter(row => row.price <= mid * 1.0025)
    .reduce((sum, row) => sum + row.price * row.quantity, 0);
  if (spreadBps > maxSpreadBps) {
    return {usable: false, reason: "spread_gate_failed", bid, ask, mid, spreadBps, bidDepth25, askDepth25};
  }
  if (bidDepth25 < minSideDepthQuote || askDepth25 < minSideDepthQuote) {
    return {usable: false, reason: "two_sided_depth_gate_failed", bid, ask, mid, spreadBps, bidDepth25, askDepth25};
  }
  return {usable: true, reason: "orderbook_gate_passed", bid, ask, mid, spreadBps, bidDepth25, askDepth25};
}

export function calculateLocalPaperMarkout({
  entryPrice, exitClose, entrySpreadBps, notionalUsdt = TABDEAL_LOCAL_PAPER_NOTIONAL_USDT,
  latencyBufferBps = TABDEAL_LOCAL_PAPER_LATENCY_BUFFER_BPS,
  feeBpsPerSide = 10
} = {}) {
  if (![entryPrice, exitClose, notionalUsdt, latencyBufferBps, feeBpsPerSide].every(Number.isFinite) ||
      entryPrice <= 0 || exitClose <= 0 || notionalUsdt <= 0 ||
      !Number.isFinite(entrySpreadBps) || entrySpreadBps < 0) {
    throw new Error("tabdeal_local_paper_markout_input_invalid");
  }
  const quantity = notionalUsdt / entryPrice;
  const assumedExitCostBps = entrySpreadBps / 2 + latencyBufferBps;
  const modeledExitPrice = exitClose * (1 - assumedExitCostBps / 10_000);
  const grossReturnBps = (modeledExitPrice / entryPrice - 1) * 10_000;
  const netReturnBps = grossReturnBps - 2 * feeBpsPerSide;
  return {
    notionalUsdt, quantity, modeledExitPrice,
    grossReturnBps, feeBpsPerSide, netReturnBps,
    netReturnPct: netReturnBps / 100
  };
}
