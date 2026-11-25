import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketResearch, backtestLongOnly, backtestShortOnly, rollingOutOfSampleBacktest, researchInternals } from "../src/research.js";

function makeCandles(count = 260, options = {}) {
  const rows = [];
  let close = options.startPrice ?? 100;
  const start = 1_700_000_000;
  for (let index = 0; index < count; index++) {
    const drift = options.flat ? 0 : options.downtrend
      ? (index % 70 < 45 ? -0.0018 : 0.0008)
      : (index % 70 < 45 ? 0.0018 : -0.0008);
    const cycle = Math.sin(index / 5) * 0.006;
    const open = close * (1 + Math.sin(index / 3) * 0.001);
    close = close * (1 + drift + cycle);
    const high = Math.max(open, close) * 1.004;
    const low = Math.min(open, close) * 0.996;
    rows.push({ time: start + index * (options.resolutionSeconds ?? 3600), open, high, low, close, volume: 10 + (index % 13) });
  }
  return rows;
}

test("normalizer sorts candles and discards duplicate/malformed data", () => {
  const input = [
    { time: 3, open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { time: 2, open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { time: 2, open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { time: 4, open: 10, high: 8, low: 9, close: 11, volume: 1 }
  ];
  const rows = researchInternals.normalizeCandles(input);
  assert.deepEqual(rows.map(row => row.time), [2, 3]);
});

test("research refuses short histories", () => {
  const result = buildMarketResearch(makeCandles(30), { resolutionSeconds: 3600 });
  assert.equal(result.available, false);
  assert.equal(result.status, "insufficient_history");
});

test("research fails closed on stale and future candle data", () => {
  const candles = makeCandles(300);
  const resolutionSeconds = 3600;
  const latestClose = candles.at(-1).time + resolutionSeconds;
  const stale = buildMarketResearch(candles, {
    resolutionSeconds,
    nowEpochSeconds: latestClose + (4 * resolutionSeconds)
  });
  assert.equal(stale.dataQuality.status, "stale_candle_data");
  assert.equal(stale.decision, "NO_TRADE_DATA_QUALITY");
  const future = buildMarketResearch(candles, {
    resolutionSeconds,
    nowEpochSeconds: latestClose - 120
  });
  assert.equal(future.dataQuality.status, "future_candle_timestamp");
  assert.equal(future.decision, "NO_TRADE_DATA_QUALITY");
});

test("research freshness gate rejects a candle older than one full interval", () => {
  const candles = makeCandles(300);
  const resolutionSeconds = 4 * 3600;
  const latestClose = candles.at(-1).time + resolutionSeconds;
  const justFresh = buildMarketResearch(candles, {
    resolutionSeconds,
    nowEpochSeconds: latestClose + resolutionSeconds - 1
  });
  assert.notEqual(justFresh.dataQuality.status, "stale_candle_data");
  assert.notEqual(justFresh.decision, "NO_TRADE_DATA_QUALITY");

  const oneSecondTooOld = buildMarketResearch(candles, {
    resolutionSeconds,
    nowEpochSeconds: latestClose + resolutionSeconds + 1
  });
  assert.equal(oneSecondTooOld.dataQuality.status, "stale_candle_data");
  assert.equal(oneSecondTooOld.dataQuality.maxAllowedCandleAgeSeconds, resolutionSeconds);
  assert.equal(oneSecondTooOld.decision, "NO_TRADE_DATA_QUALITY");
  assert.equal(oneSecondTooOld.execution.liveTradingEnabled, false);
});

test("research refuses to overstate forecasts from overlapping or too few historical windows", () => {
  const candles = makeCandles(500);
  const result = buildMarketResearch(candles, {
    resolutionSeconds: 3600,
    horizonBars: 24,
    nowEpochSeconds: candles.at(-1).time + 3600
  });
  const forecast = result.forecasts.find(item => item.horizonBars === 24);
  assert.equal(forecast.available, false);
  assert.equal(forecast.status, "insufficient_non_overlapping_holdout_samples");
  assert.equal(result.decision, "WAIT_INSUFFICIENT_FORECAST_SAMPLE");
  assert.equal(result.execution.liveTradingEnabled, false);
});

test("research reports non-overlapping holdout analogs with uncertainty interval", () => {
  const candles = makeCandles(3_600);
  const result = buildMarketResearch(candles, {
    resolutionSeconds: 3600,
    horizonBars: 24,
    nowEpochSeconds: candles.at(-1).time + 3600
  });
  const forecast = result.forecasts.find(item => item.horizonBars === 24);
  assert.equal(forecast.available, true);
  assert.equal(forecast.method, "chronological_calibration_holdout_non_overlapping_horizon_analogs");
  assert.equal(forecast.independentWindowSpacingBars, 24);
  assert.ok(forecast.sampleCount >= 30);
  assert.equal(typeof forecast.probabilityPositive, "number");
  assert.ok(forecast.probabilityPositiveWilson95.lower <= forecast.probabilityPositive);
  assert.ok(forecast.probabilityPositiveWilson95.upper >= forecast.probabilityPositive);
  assert.equal(result.execution.liveTradingEnabled, false);
});

test("backtest requires explicit fees and slippage assumptions", () => {
  const rows = makeCandles(240);
  assert.throws(() => backtestLongOnly(rows, { initialCapital: 1_000_000, resolutionSeconds: 3600 }), /explicit_fee_bps_required/);
  assert.throws(() => backtestLongOnly(rows, { initialCapital: 1_000_000, resolutionSeconds: 3600, feeBps: 10 }), /explicit_slippage_bps_required/);
});

test("short margin shadow backtest requires a daily position fee and stays at 1x", () => {
  const downtrend = makeCandles(900, { downtrend: true });
  assert.throws(() => backtestShortOnly(downtrend, {
    initialCapital: 1_000_000, feeBps: 13, slippageBps: 15, resolutionSeconds: 3600
  }), /explicit_margin_position_fee_bps_per_day_required/);
  const result = backtestShortOnly(downtrend, {
    strategy: "ema-trend", initialCapital: 1_000_000, feeBps: 13,
    slippageBps: 15, positionFeeBpsPerDay: 10, resolutionSeconds: 3600
  });
  assert.equal(result.direction, "short");
  assert.equal(result.assumptions.shortOnly, true);
  assert.equal(result.assumptions.leverage, 1);
  assert.equal(result.assumptions.liveTradingEnabled, false);
  assert.equal(result.assumptions.exchangeOrdersPlaced, 0);
  assert.equal(result.benchmark.name, "cash_no_trade");
  assert.ok(result.metrics.finalEquity > 0);
  assert.ok(result.trades.every(trade => trade.entryPrice > 0 && trade.exitPrice > 0));
});

test("short walk-forward uses the no-trade benchmark and requires 30 disjoint windows", () => {
  const result = rollingOutOfSampleBacktest(makeCandles(3_600, { downtrend: true }), {
    direction: "short", strategy: "ema-trend", initialCapital: 1_000_000,
    feeBps: 13, slippageBps: 15, positionFeeBpsPerDay: 10,
    resolutionSeconds: 3600, trainBars: 500, testBars: 100, stepBars: 100
  });
  assert.equal(result.direction, "short");
  assert.equal(result.minimumWindowsRequired, 30);
  assert.ok(result.windowCount >= 30);
  assert.equal(result.exchangeOrdersPlaced, 0);
  assert.match(result.caveat, /cash\/no-trade/);
  for (const window of result.windows) assert.equal(window.benchmarkReturnPct, 0);
});

test("backtest is long-only, no-leverage, next-bar and risk-bounded", () => {
  const result = backtestLongOnly(makeCandles(400), {
    strategy: "ema-trend",
    initialCapital: 1_000_000,
    feeBps: 25,
    slippageBps: 15,
    resolutionSeconds: 3600
  });
  assert.equal(result.assumptions.longOnly, true);
  assert.equal(result.assumptions.leverage, false);
  assert.equal(result.assumptions.nextBarOpenExecution, true);
  assert.equal(result.assumptions.liveTradingEnabled, false);
  assert.ok(result.assumptions.riskFractionPerTrade <= 0.01);
  assert.ok(result.assumptions.maxExposureFraction <= 0.5);
  assert.ok(Number.isFinite(result.metrics.finalEquity));
  assert.equal(result.benchmark.name, "buy_and_hold");
});

test("fixed-strategy rolling out-of-sample report separates windows and compares buy-and-hold", () => {
  const result = rollingOutOfSampleBacktest(makeCandles(3_600), {
    strategy: "ema-trend",
    initialCapital: 1_000_000,
    feeBps: 25,
    slippageBps: 15,
    resolutionSeconds: 3600,
    trainBars: 500,
    testBars: 100,
    stepBars: 100
  });
  assert.equal(result.available, true);
  assert.ok(result.windowCount >= 12);
  assert.equal(result.minimumWindowsRequired, 30);
  assert.equal(typeof result.benchmarkCompoundedReturnPct, "number");
  assert.equal(typeof result.compoundedExcessReturnPct, "number");
  for (let i = 1; i < result.windows.length; i++) {
    assert.ok(result.windows[i].startIndex > result.windows[i - 1].endIndex);
  }
  for (const window of result.windows) {
    assert.equal(typeof window.benchmarkReturnPct, "number");
    assert.equal(window.excessReturnPct, window.totalReturnPct - window.benchmarkReturnPct);
  }
});

test("walk-forward windows are forced not to overlap and still require 30 OOS windows", () => {
  const result = rollingOutOfSampleBacktest(makeCandles(3_600), {
    strategy: "ema-trend",
    initialCapital: 1_000_000,
    feeBps: 25,
    slippageBps: 15,
    resolutionSeconds: 3600,
    trainBars: 500,
    testBars: 100,
    stepBars: 30
  });
  assert.equal(result.available, true);
  assert.ok(result.windowCount >= 30);
  assert.equal(result.minimumWindowsRequired, 30);
  for (let index = 1; index < result.windows.length; index++) {
    assert.ok(result.windows[index].startIndex > result.windows[index - 1].endIndex);
  }
});

test("backtest result for a closed test window is unchanged by later candles", () => {
  const full = makeCandles(500);
  const changedFuture = full.map((row, index) => index <= 250 ? row : {
    ...row, open: row.open * 3, high: row.high * 3, low: row.low * 3, close: row.close * 3
  });
  const options = {
    strategy: "ema-trend", initialCapital: 1_000_000,
    feeBps: 25, slippageBps: 15, resolutionSeconds: 3600,
    startIndex: 100, endIndex: 250
  };
  const first = backtestLongOnly(full, options);
  const second = backtestLongOnly(changedFuture, options);
  assert.equal(first.metrics.finalEquity, second.metrics.finalEquity);
  assert.equal(first.metrics.tradeCount, second.metrics.tradeCount);
});

test("latest contiguous segment discards older candles separated by a multi-bar discontinuity", () => {
  const older = makeCandles(420);
  const latest = makeCandles(380).map(row => ({ ...row, time: row.time + older.at(-1).time + 7 * 3600 }));
  const input = [...older, ...latest];
  const segment = researchInternals.latestContiguousSegment(input, 3600);
  assert.equal(segment.candles.length, 380);
  assert.equal(segment.quality.discardedBeforeLatestContiguousSegment, 420);
  assert.equal(segment.quality.severeDiscontinuityCount, 1);
  assert.equal(segment.quality.status, "usable_latest_contiguous_segment");
});

test("research never computes across a severe historical gap", () => {
  const older = makeCandles(420);
  const latest = makeCandles(380).map(row => ({ ...row, time: row.time + older.at(-1).time + 7 * 3600 }));
  const input = [...older, ...latest];
  const result = buildMarketResearch(input, {
    resolutionSeconds: 3600,
    horizonBars: 24,
    nowEpochSeconds: latest.at(-1).time + 3600
  });
  assert.equal(result.candleCount, 380);
  assert.equal(result.dataQuality.discardedBeforeLatestContiguousSegment, 420);
  assert.equal(result.decision, "WAIT_INSUFFICIENT_FORECAST_SAMPLE");
});

test("too many material gaps in the latest segment veto research", () => {
  const candles = makeCandles(500);
  const gapStarts = new Set([20, 55, 90, 125, 160, 195, 230, 265, 300, 335, 370, 405, 440, 475, 510, 545]);
  let accumulatedShift = 0;
  for (let index = 0; index < candles.length; index++) {
    if (gapStarts.has(index)) accumulatedShift += 3600;
    candles[index].time += accumulatedShift;
  }
  const result = buildMarketResearch(candles, {
    resolutionSeconds: 3600,
    horizonBars: 24,
    nowEpochSeconds: candles.at(-1).time + 3600
  });
  assert.equal(result.dataQuality.status, "degraded_gaps_detected");
  assert.equal(result.decision, "NO_TRADE_DATA_QUALITY");
});

test("forecast edge requires the Wilson 95% lower bound to clear neutral", () => {
  assert.equal(researchInternals.forecastHasStatisticalEdge({
    available: true,
    probabilityPositive: 0.65,
    probabilityPositiveWilson95: { lower: 0.52, upper: 0.76 },
    medianReturnPct: 0.4
  }), true);
  assert.equal(researchInternals.forecastHasStatisticalEdge({
    available: true,
    probabilityPositive: 0.65,
    probabilityPositiveWilson95: { lower: 0.48, upper: 0.79 },
    medianReturnPct: 0.4
  }), false);
});

test("walk-forward backtest evaluates independent contiguous segments without bridging gaps", () => {
  const older = makeCandles(420);
  const latest = makeCandles(420).map(row => ({ ...row, time: row.time + older.at(-1).time + 7 * 3600 }));
  const result = rollingOutOfSampleBacktest([...older, ...latest], {
    strategy: "ema-trend",
    initialCapital: 1_000_000,
    feeBps: 25,
    slippageBps: 15,
    resolutionSeconds: 3600,
    trainBars: 300,
    testBars: 60,
    stepBars: 60
  });
  assert.equal(result.candleCount, 840);
  assert.equal(result.segmentCount, 2);
  assert.equal(result.evaluatedSegmentCount, 2);
  assert.equal(result.dataQuality.status, "usable_multiple_contiguous_segments");
  assert.equal(result.available, false);
  assert.equal(result.reason, "insufficient_out_of_sample_windows");
  assert.equal(result.windowCount, 4);
  assert.ok(result.windows.every(window => window.segmentIndex === 1 || window.segmentIndex === 2));
  assert.ok(result.windows.filter(window => window.segmentIndex === 1).every(window =>
    window.endTime < result.windows.find(next => next.segmentIndex === 2).startTime
  ));
});

test("daily OOS uses both valid contiguous segments to meet 30 disjoint windows without crossing a gap", () => {
  const older = makeCandles(978, { resolutionSeconds: 86_400 });
  const latest = makeCandles(500, { resolutionSeconds: 86_400 }).map(row => ({
    ...row, time: row.time + older.at(-1).time + (14 * 86_400)
  }));
  const result = rollingOutOfSampleBacktest([...older, ...latest], {
    strategy: "ema-trend",
    initialCapital: 1_000_000,
    feeBps: 25,
    slippageBps: 15,
    resolutionSeconds: 86_400,
    trainBars: 120,
    testBars: 30,
    stepBars: 30
  });
  assert.equal(result.available, true);
  assert.equal(result.minimumWindowsRequired, 30);
  assert.equal(result.segmentCount, 2);
  assert.equal(result.candleCount, 1_478);
  assert.equal(result.windowCount, 40);
  assert.equal(result.evaluatedSegmentCount, 2);
  assert.equal(result.requiredCandlesForWindows, 1_140);
  assert.deepEqual(result.dataQuality.segments.map(segment => segment.windowCount), [28, 12]);
  const gapStart = latest[0].time;
  assert.ok(result.windows.every(window =>
    (window.segmentIndex === 1 && window.endTime < gapStart) ||
    (window.segmentIndex === 2 && window.startTime >= gapStart)
  ));
  for (const segmentIndex of [1, 2]) {
    const windows = result.windows.filter(window => window.segmentIndex === segmentIndex);
    for (let index = 1; index < windows.length; index++) {
      assert.ok(windows[index].startIndex > windows[index - 1].endIndex);
    }
  }

  const shortResult = rollingOutOfSampleBacktest([...older, ...latest], {
    direction: "short",
    strategy: "ema-trend",
    initialCapital: 1_000_000,
    feeBps: 13,
    slippageBps: 15,
    positionFeeBpsPerDay: 10,
    resolutionSeconds: 86_400,
    trainBars: 120,
    testBars: 30,
    stepBars: 30
  });
  assert.equal(shortResult.available, true);
  assert.equal(shortResult.windowCount, 40);
  assert.equal(shortResult.benchmarkCompoundedReturnPct, 0);
  assert.equal(shortResult.exchangeOrdersPlaced, 0);
});

test("six disjoint OOS windows remain unavailable for strategy selection", () => {
  const result = rollingOutOfSampleBacktest(makeCandles(1_100), {
    strategy: "ema-trend",
    initialCapital: 1_000_000,
    feeBps: 25,
    slippageBps: 15,
    resolutionSeconds: 3600,
    trainBars: 500,
    testBars: 90,
    stepBars: 90
  });
  assert.equal(result.windowCount, 7);
  assert.equal(result.minimumWindowsRequired, 30);
  assert.equal(result.available, false);
  assert.equal(result.reason, "insufficient_out_of_sample_windows");
  assert.equal(result.exchangeOrdersPlaced, 0);
});

test("walk-forward backtest vetoes a degraded latest segment even when older history is valid", () => {
  const older = makeCandles(600);
  const latest = makeCandles(600).map(row => ({ ...row, time: row.time + older.at(-1).time + 7 * 3600 }));
  const gapStarts = new Set([20, 55, 90, 125, 160, 195, 230, 265, 300, 335, 370, 405, 440, 475, 510, 545]);
  let accumulatedShift = 0;
  for (let index = 0; index < latest.length; index++) {
    if (gapStarts.has(index)) accumulatedShift += 3600;
    latest[index].time += accumulatedShift;
  }
  const result = rollingOutOfSampleBacktest([...older, ...latest], {
    strategy: "ema-trend",
    initialCapital: 1_000_000,
    feeBps: 25,
    slippageBps: 15,
    resolutionSeconds: 3600,
    trainBars: 300,
    testBars: 60
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "degraded_candle_gaps");
  assert.equal(result.excludedDegradedSegmentCount, 1);
  assert.equal(result.windowCount, 0);
});

