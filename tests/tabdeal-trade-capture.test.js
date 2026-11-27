import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTabdealSpotTrades,
  assessTabdealTradePageCoverage,
  aggregateTabdealTradeCandles,
  mergeTabdealTradeCandle,
  buildTabdealTradeCaptureHealth
} from "../workers/tabdeal-mvp-shadow/index.js";

const minute = 60_000;
const now = Date.parse("2026-11-27T12:00:00.000Z");

function trade(id, timeMs, price, qty = "0.001", quoteQty = "60") {
  return {id: String(id), time: timeMs, price: String(price), qty, quoteQty, isBuyerMaker: false};
}
function normalized(rows) {
  return normalizeTabdealSpotTrades(rows, now);
}

test("normalizes, sorts and validates Spot trades by ID and timestamp", () => {
  const rows = normalized([
    trade(102, now - 1_000, "60020"),
    trade(101, now - 2_000, "60010")
  ]);
  assert.deepEqual(rows.map(row => row.id), ["101", "102"]);
  assert.equal(rows[0].price, "60010");
});

test("rejects duplicate IDs, invalid decimal values and future timestamps", () => {
  assert.throws(() => normalized([trade(1, now - 1_000, "10"), trade(1, now - 500, "11")]), /duplicate/);
  assert.throws(() => normalized([trade(2, now - 1_000, "0")]), /fields_invalid/);
  assert.throws(() => normalized([trade(3, now + 31_000, "10")]), /fields_invalid/);
});

test("detects a capped recent-trades page that cannot cover the previous poll interval", () => {
  const state = {
    last_trade_id: "100",
    last_trade_time_ms: now - 40_000,
    last_successful_poll_at_ms: now - 30_000
  };
  const rows = normalized(Array.from({length: 1000}, (_, i) =>
    trade(i + 200, now - 10_000 + i, "60000")
  ));
  const result = assessTabdealTradePageCoverage(rows, state);
  assert.equal(result.status, "possible_truncation");
  assert.equal(result.newTrades.length, 0);
});

test("rejects a capped page without cursor overlap even when its oldest timestamp predates the poll", () => {
  const state = {
    last_trade_id: "100",
    last_trade_time_ms: now - 120_000,
    last_successful_poll_at_ms: now - 30_000
  };
  const rows = normalized(Array.from({length: 1000}, (_, i) =>
    trade(i + 200, now - 100_000 + i, "60000")
  ));
  const result = assessTabdealTradePageCoverage(rows, state);
  assert.equal(result.status, "possible_truncation");
  assert.equal(result.newTrades.length, 0);
});

test("accepts an overlapping capped page and returns only unseen trades", () => {
  const state = {
    last_trade_id: "1000",
    last_trade_time_ms: now - 30_000,
    last_successful_poll_at_ms: now - 30_000
  };
  const rows = normalized([
    ...Array.from({length: 999}, (_, i) =>
      trade(i + 1, now - 60_000 + i * 20, "60000")
    ),
    trade(1001, now - 1_000, "60010")
  ]);
  const result = assessTabdealTradePageCoverage(rows, state);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.newTrades.map(row => row.id), ["1001"]);
});

test("aggregates minute OHLCV exactly from actual trades", () => {
  const rows = normalized([
    trade(1, now - 120_000, "60000", "0.001", "60"),
    trade(2, now - 119_000, "60100", "0.002", "120"),
    trade(3, now - 50_000, "59900", "0.0015", "89.85")
  ]);
  const candles = aggregateTabdealTradeCandles(rows, 4);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].open_price, "60000");
  assert.equal(candles[0].high_price, "60100");
  assert.equal(candles[0].low_price, "60000");
  assert.equal(candles[0].close_price, "60100");
  assert.equal(candles[0].base_volume, "0.003");
  assert.equal(candles[0].quote_volume, "180");
  assert.equal(candles[0].trade_count, 2);
  assert.equal(candles[1].open_price, "59900");
});

test("merges later trades into the same minute without losing OHLC order or volume precision", () => {
  const [first] = aggregateTabdealTradeCandles(normalized([
    trade(1, now - 120_000, "60000", "0.001", "60")
  ]), 2);
  const [later] = aggregateTabdealTradeCandles(normalized([
    trade(2, now - 119_000, "60100", "0.0005", "30")
  ]), 2);
  const merged = mergeTabdealTradeCandle(first, later);
  assert.equal(merged.open_price, "60000");
  assert.equal(merged.close_price, "60100");
  assert.equal(merged.high_price, "60100");
  assert.equal(merged.base_volume, "0.0015");
  assert.equal(merged.quote_volume, "90");
  assert.equal(merged.trade_count, 2);
});

test("does not merge across continuity epochs after a detected data gap", () => {
  const [first] = aggregateTabdealTradeCandles(normalized([
    trade(1, now - 120_000, "60000")
  ]), 1);
  const [second] = aggregateTabdealTradeCandles(normalized([
    trade(2, now - 119_000, "60100")
  ]), 2);
  const merged = mergeTabdealTradeCandle(first, second);
  assert.equal(merged.coverage_status, "partial_after_gap");
  assert.equal(merged.trade_count, 1);
});

test("requires 60 consecutive closed and fresh local candles before capture readiness", () => {
  const state = {
    last_successful_poll_at_ms: now - 10_000,
    last_trade_time_ms: now - 5_000,
    last_poll_status: "captured",
    continuity_epoch: 3,
    gap_count: 1
  };
  const rows = Array.from({length: 60}, (_, i) => ({
    minute_open_ms: now - minute * (i + 1),
    continuity_epoch: 3,
    coverage_status: "complete",
    trade_count: 10
  }));
  const health = buildTabdealTradeCaptureHealth(state, rows, now);
  assert.equal(health.captureReady, true);
  assert.equal(health.fourHourHistoryReady, false);
  assert.equal(health.consecutiveClosedMinutes, 60);
  assert.equal(health.status, "ready_for_extended_paper_validation");
});

test("a gap, partial candle, stale trade or missing minute fails capture readiness", () => {
  const state = {
    last_successful_poll_at_ms: now - 10_000,
    last_trade_time_ms: now - 5_000,
    last_poll_status: "captured",
    continuity_epoch: 3,
    gap_count: 1
  };
  const rows = Array.from({length: 60}, (_, i) => ({
    minute_open_ms: now - minute * (i + 1),
    continuity_epoch: 3,
    coverage_status: i === 7 ? "partial_after_gap" : "complete",
    trade_count: 10
  }));
  assert.equal(buildTabdealTradeCaptureHealth(state, rows, now).captureReady, false);
  assert.equal(buildTabdealTradeCaptureHealth({...state, last_trade_time_ms: now - 300_000}, rows, now).captureReady, false);
  const missing = rows.filter((_, i) => i !== 12);
  assert.equal(buildTabdealTradeCaptureHealth(state, missing, now).captureReady, false);
});

test("requires 240 consecutive minutes before a local four-hour history window is ready", () => {
  const state = {
    last_successful_poll_at_ms: now - 10_000,
    last_trade_time_ms: now - 5_000,
    last_poll_status: "captured",
    continuity_epoch: 0,
    gap_count: 0
  };
  const rows = Array.from({length: 240}, (_, i) => ({
    minute_open_ms: now - minute * (i + 1),
    continuity_epoch: 0,
    coverage_status: "complete",
    trade_count: 1
  }));
  const health = buildTabdealTradeCaptureHealth(state, rows, now);
  assert.equal(health.captureReady, true);
  assert.equal(health.fourHourHistoryReady, true);
});
