import test from "node:test";
import assert from "node:assert/strict";
import {evaluateTabdealMvpShadow, buildShadowHealth} from "../workers/tabdeal-mvp-shadow/index.js";

const interval = 4 * 60 * 60 * 1000;
const nowMs = Date.parse("2026-11-27T08:00:00.000Z");

function krakenCandles(count = 100, trend = "up") {
  const rows = [];
  const latestClosedOpen = Math.floor(nowMs / interval) * interval - interval;
  for (let i = 0; i < count; i++) {
    const price = trend === "up" ? 60_000 + i * 25
      : trend === "down" ? 65_000 - i * 20 : 62_000;
    const open = latestClosedOpen - (count - 1 - i) * interval;
    rows.push([
      Math.floor(open / 1000),
      String(price - 5), String(price + 10), String(price - 10),
      String(price), String(price), "10", 50
    ]);
  }
  return {error: [], result: {XXBTZUSD: rows, last: rows.at(-1)[0]}};
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
function evaluate(krakenOhlc = krakenCandles(), exchangeInfo = markets(), book = depth()) {
  return evaluateTabdealMvpShadow({
    krakenOhlc, tabdealExchangeInfo: exchangeInfo, tabdealDepth: book, nowMs
  });
}

test("produces a trend watch but never an order when local sources pass", () => {
  const report = evaluate();
  assert.equal(report.data.status, "usable", JSON.stringify(report.data));
  assert.equal(report.localMarket.status, "usable_snapshot");
  assert.equal(report.trend.state, "UP_TREND_WATCH");
  assert.equal(report.decision, "WAIT");
  assert.equal(report.executionGate, "BLOCKED_NO_RESEARCH_QUALIFIED_STRATEGY");
  assert.equal(report.ordersCreated, 0);
  assert.equal(report.safety.exchangeOrdersPlaced, 0);
  assert.equal(report.liveTradingEnabled, false);
});

test("blocks when Kraken history contains a 4h gap", () => {
  const payload = krakenCandles();
  payload.result.XXBTZUSD[50][0] += interval / 1000;
  const report = evaluate(payload);
  assert.equal(report.data.status, "invalid_or_stale");
  assert.equal(report.executionGate, "BLOCKED_KRAKEN_DATA");
  assert.equal(report.decision, "WAIT");
});

test("blocks stale 4h history and never forward fills", () => {
  const payload = krakenCandles();
  for (const row of payload.result.XXBTZUSD) row[0] -= (5 * interval) / 1000;
  const report = evaluate(payload);
  assert.equal(report.data.status, "invalid_or_stale");
  assert.equal(report.executionGate, "BLOCKED_KRAKEN_DATA");
});

test("rejects Kraken API error payloads instead of substituting another source", () => {
  const report = evaluate({error: ["EGeneral:Temporary lockout"], result: {}});
  assert.equal(report.data.status, "invalid_or_stale");
  assert.equal(report.executionGate, "BLOCKED_KRAKEN_DATA");
  assert.equal(report.decision, "WAIT");
});

test("excludes Kraken's current uncommitted 4h candle", () => {
  const payload = krakenCandles();
  const currentOpen = Math.floor(nowMs / interval) * interval;
  payload.result.XXBTZUSD.push([
    Math.floor(currentOpen / 1000), "62000", "62100", "61900",
    "62050", "62030", "20", 10
  ]);
  const report = evaluate(payload);
  assert.equal(report.data.status, "usable");
  assert.equal(report.data.candleCount, 100);
  assert.equal(report.decision, "WAIT");
});

test("blocks if the local market is inactive or not Spot", () => {
  const invalid = markets();
  invalid[0].isSpotTradingAllowed = false;
  const report = evaluate(krakenCandles(), invalid);
  assert.equal(report.localMarket.status, "invalid_or_unavailable");
  assert.equal(report.executionGate, "BLOCKED_TABDEAL_LOCAL_BOOK");
});

test("blocks a wide spread or inadequate local depth", () => {
  const report = evaluate(krakenCandles(), markets(), depth(45));
  assert.equal(report.localMarket.status, "liquidity_gate_failed");
  assert.equal(report.executionGate, "BLOCKED_TABDEAL_LOCAL_BOOK");
});

test("requires minimum depth independently on both sides of the local book", () => {
  const shallowAsk = depth();
  shallowAsk.asks = shallowAsk.asks.map(([price]) => [price, "0.001"]);
  const report = evaluate(krakenCandles(), markets(), shallowAsk);
  assert.equal(report.localMarket.bidDepthPass, true);
  assert.equal(report.localMarket.askDepthPass, false);
  assert.equal(report.localMarket.depthPass, false);
  assert.equal(report.localMarket.status, "liquidity_gate_failed");
  assert.equal(report.executionGate, "BLOCKED_TABDEAL_LOCAL_BOOK");
  assert.equal(report.decision, "WAIT");
  assert.equal(report.ordersCreated, 0);
});

test("does not generate a buy signal even when the trend is up and market is usable", () => {
  const report = evaluate();
  assert.equal(report.trend.state, "UP_TREND_WATCH");
  assert.equal(report.decision, "WAIT");
  assert.equal(report.researchGate.approvedStrategyExists, false);
  assert.equal(report.safety.orderSubmissionAttempted, false);
});

test("uses Kraken USD only as trend context and never as a Tabdeal USDT execution quote", () => {
  const report = evaluate();
  assert.equal(report.signalSource.provider, "KRAKEN_SPOT");
  assert.equal(report.signalSource.symbol, "XBTUSD");
  assert.equal(report.signalSource.quoteAsset, "USD");
  assert.equal(report.signalSource.contextOnly, true);
  assert.equal(report.signalSource.executableTabdealQuote, false);
  assert.equal(report.localMarket.quoteUnit, "USDT");
  assert.equal(report.decision, "WAIT");
});


test("health endpoint marks a recent scan as fresh", () => {
  const capturedAt = "2026-11-27T08:00:00.000Z";
  const health = buildShadowHealth({capturedAt}, {
    nowMs: Date.parse("2026-11-27T08:10:00.000Z")
  });
  assert.equal(health.status, "fresh");
  assert.equal(health.fresh, true);
  assert.equal(health.ageMs, 10 * 60 * 1000);
  assert.equal(health.expectedCadenceMinutes, 15);
});

test("health endpoint warns when the last scan is stale", () => {
  const health = buildShadowHealth({capturedAt: "2026-11-27T08:00:00.000Z"}, {
    nowMs: Date.parse("2026-11-27T08:45:00.000Z")
  });
  assert.equal(health.status, "stale");
  assert.equal(health.fresh, false);
});

test("health endpoint fails closed on invalid scan timestamp", () => {
  const health = buildShadowHealth({capturedAt: "not-a-date"}, {
    nowMs: Date.parse("2026-11-27T08:10:00.000Z")
  });
  assert.equal(health.status, "invalid_report_time");
  assert.equal(health.fresh, false);
});
