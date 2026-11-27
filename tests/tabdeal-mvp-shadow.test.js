import test from "node:test";
import assert from "node:assert/strict";
import {evaluateTabdealMvpShadow} from "../workers/tabdeal-mvp-shadow/index.js";

const interval = 4 * 60 * 60 * 1000;
const nowMs = Date.parse("2026-11-27T08:00:00.000Z");
function candles(count = 100, trend = "up") {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const price = trend === "up" ? 60_000 + i * 25 : trend === "down" ? 65_000 - i * 20 : 62_000;
    const open = Date.UTC(2026, 0, 1) + i * interval;
    rows.push([
      open, String(price - 5), String(price + 10), String(price - 10), String(price),
      "10", open + interval - 1, String(price * 10), 50
    ]);
  }
  return rows;
}
function markets() {
  return [{
    symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT",
    isSpotTradingAllowed: true, permissions: ["SPOT"],
    filters: [
      {filterType: "LOT_SIZE", minQty: "0.00001", stepSize: "0.00001"},
      {filterType: "MIN_NOTIONAL", minNotional: "5"},
      {filterType: "PRICE_FILTER", tickSize: "0.01"}
    ],
    baseAssetPrecision: 8, quoteAssetPrecision: 8
  }];
}
function depth(spread = 1) {
  const bid = 62_000;
  const ask = bid * (1 + spread / 10_000);
  return {
    bids: [[String(bid), "0.1"], [String(bid - 10), "0.1"]],
    asks: [[String(ask), "0.1"], [String(ask + 10), "0.1"]]
  };
}

test("produces a trend watch but never an order when local sources pass", () => {
  const report = evaluateTabdealMvpShadow({
    binanceKlines: candles(), tabdealExchangeInfo: markets(), tabdealDepth: depth(),
    nowMs
  });
  assert.equal(report.data.status, "usable");
  assert.equal(report.localMarket.status, "usable_snapshot");
  assert.equal(report.trend.state, "UP_TREND_WATCH");
  assert.equal(report.decision, "WAIT");
  assert.equal(report.executionGate, "BLOCKED_NO_RESEARCH_QUALIFIED_STRATEGY");
  assert.equal(report.ordersCreated, 0);
  assert.equal(report.safety.exchangeOrdersPlaced, 0);
  assert.equal(report.liveTradingEnabled, false);
});

test("blocks when Binance history contains a 4h gap", () => {
  const rows = candles();
  rows[50][0] += interval;
  rows[50][6] += interval;
  const report = evaluateTabdealMvpShadow({
    binanceKlines: rows, tabdealExchangeInfo: markets(), tabdealDepth: depth(), nowMs
  });
  assert.equal(report.data.status, "invalid_or_stale");
  assert.equal(report.executionGate, "BLOCKED_BINANCE_DATA");
  assert.equal(report.decision, "WAIT");
});

test("blocks stale/incomplete 4h data and never forward fills", () => {
  const rows = candles();
  rows[rows.length - 1][6] = nowMs + interval;
  const report = evaluateTabdealMvpShadow({
    binanceKlines: rows, tabdealExchangeInfo: markets(), tabdealDepth: depth(), nowMs
  });
  assert.equal(report.data.status, "invalid_or_stale");
  assert.equal(report.executionGate, "BLOCKED_BINANCE_DATA");
});

test("blocks if the local market is inactive or not Spot", () => {
  const invalid = markets();
  invalid[0].isSpotTradingAllowed = false;
  const report = evaluateTabdealMvpShadow({
    binanceKlines: candles(), tabdealExchangeInfo: invalid, tabdealDepth: depth(), nowMs
  });
  assert.equal(report.localMarket.status, "invalid_or_unavailable");
  assert.equal(report.executionGate, "BLOCKED_TABDEAL_LOCAL_BOOK");
});

test("blocks a wide spread or inadequate local depth", () => {
  const wide = evaluateTabdealMvpShadow({
    binanceKlines: candles(), tabdealExchangeInfo: markets(), tabdealDepth: depth(45), nowMs
  });
  assert.equal(wide.localMarket.status, "liquidity_gate_failed");
  assert.equal(wide.executionGate, "BLOCKED_TABDEAL_LOCAL_BOOK");
});

test("does not generate a buy signal even when the trend is up and market is usable", () => {
  const report = evaluateTabdealMvpShadow({
    binanceKlines: candles(), tabdealExchangeInfo: markets(), tabdealDepth: depth(), nowMs
  });
  assert.equal(report.trend.state, "UP_TREND_WATCH");
  assert.equal(report.decision, "WAIT");
  assert.equal(report.researchGate.approvedStrategyExists, false);
  assert.equal(report.safety.orderSubmissionAttempted, false);
});
