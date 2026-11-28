import test from "node:test";
import assert from "node:assert/strict";
import {
  PULLMOL_API_BASE,
  runPullmolReadOnlyProbe,
  summarizePullmolResponse
} from "../src/pullmol-readonly-probe.js";

const NOW = Date.parse("2026-11-28T10:00:00.000Z");

test("signal summary records only schema metadata, not signal values or free text", () => {
  const payload = {
    exchange: "tabdeal",
    symbol: "BTC-USDT",
    data: [{
      type: "EMA Cross",
      direction: "SELL",
      confidence: 80,
      timestamp: NOW,
      reason: "secret provider analysis text",
      entry: 60000,
      stop_loss: 59000,
      targets: [61000, 62000]
    }],
    freshness: {
      source_timestamp_ms: NOW - 140000,
      source_age_ms: 140000,
      stale_after_ms: 604800000,
      status: "fresh",
      stale: false
    }
  };
  const result = summarizePullmolResponse({
    url: PULLMOL_API_BASE + "/signals/BTC-USDT?exchange=tabdeal",
    status: 200,
    contentType: "application/json",
    payload,
    elapsedMs: 21,
    nowMs: NOW
  });
  assert.equal(result.signalEventCount, 1);
  assert.deepEqual(result.directions, ["SELL"]);
  assert.equal(result.containsEntryLevels, true);
  assert.equal(result.containsStopLoss, true);
  assert.equal(result.containsTakeProfitLevels, true);
  assert.equal(result.freshness.within60Seconds, false);
  assert.ok(result.eventFieldNames.includes("stop_loss"));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret provider analysis text"), false);
  assert.equal(serialized.includes('"entry":60000'), false);
  assert.equal(serialized.includes('"stop_loss":59000'), false);
  assert.equal(serialized.includes("61000"), false);
});

test("signals without entry, stop and targets are correctly identified as event-only output", () => {
  const result = summarizePullmolResponse({
    url: PULLMOL_API_BASE + "/signals/BTC-USDT?exchange=tabdeal",
    status: 200,
    contentType: "application/json",
    payload: {data: [{type: "EMA Cross", direction: "SELL", confidence: 80}]},
    elapsedMs: 10,
    nowMs: NOW
  });
  assert.equal(result.signalEventCount, 1);
  assert.equal(result.containsEntryLevels, false);
  assert.equal(result.containsStopLoss, false);
  assert.equal(result.containsTakeProfitLevels, false);
});

test("candle summary detects a short page and computes bar age", () => {
  const payload = {
    timeframe: "1hour",
    data: [
      [NOW - 3 * 3600000, 1, 2, 0.5, 1.5, 100],
      [NOW - 2 * 3600000, 1.5, 2, 1, 1.7, 120],
      [NOW - 3600000, 1.7, 2, 1.6, 1.8, 130]
    ],
    freshness: {
      source_timestamp_ms: NOW - 3600000,
      source_age_ms: 3600000,
      stale_after_ms: 604800000,
      status: "fresh",
      stale: false
    }
  };
  const result = summarizePullmolResponse({
    url: PULLMOL_API_BASE + "/candles?exchange=tabdeal&symbol=BTC-USDT&timeframe=1hour&limit=5",
    status: 200,
    contentType: "application/json",
    payload,
    elapsedMs: 20,
    nowMs: NOW
  });
  assert.equal(result.requestedBars, 5);
  assert.equal(result.returnedBars, 3);
  assert.equal(result.returnedFewerThanRequested, true);
  assert.equal(result.latestBarAgeMs, 3600000);
});

test("ticker summary applies an independent 60-second threshold, not the provider's cache threshold", () => {
  const result = summarizePullmolResponse({
    url: PULLMOL_API_BASE + "/ticker?exchange=tabdeal&symbol=BTC-USDT",
    status: 200,
    contentType: "application/json",
    payload: {
      data: {symbol: "BTC/USDT", bid: 99, ask: 101, last: 100},
      freshness: {
        source_timestamp_ms: NOW - 140000,
        source_age_ms: 140000,
        stale_after_ms: 604800000,
        status: "fresh",
        stale: false
      }
    },
    elapsedMs: 15,
    nowMs: NOW
  });
  assert.equal(result.bidAskPresent, true);
  assert.equal(result.freshness.reportedStatus, "fresh");
  assert.equal(result.freshness.within60Seconds, false);
});

test("read-only probe sends only unauthenticated GETs and discards event values", async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(String(url));
    assert.equal(init.method, "GET");
    assert.equal(Object.keys(init.headers ?? {}).some(key => /authorization|api-key|signature/i.test(key)), false);
    const parsed = new URL(url);
    if (parsed.pathname === "/services") {
      return {ok: true, status: 200, headers: {get: () => "application/json"}, json: async () => ({data: [{id: "market-data"}, {id: "signals"}]})};
    }
    if (parsed.pathname === "/markets") {
      return {ok: true, status: 200, headers: {get: () => "application/json"}, json: async () => ({data: ["BTCUSDT", "ETHUSDT", "PAXGUSDT"]})};
    }
    if (parsed.pathname === "/ticker") {
      return {ok: true, status: 200, headers: {get: () => "application/json"}, json: async () => ({data: {symbol: "BTC/USDT", bid: 99, ask: 101}, freshness: {source_timestamp_ms: NOW, source_age_ms: 0, stale_after_ms: 604800000, status: "fresh", stale: false}})};
    }
    if (parsed.pathname === "/candles") {
      return {ok: true, status: 200, headers: {get: () => "application/json"}, json: async () => ({timeframe: "1hour", data: [[NOW, 1, 2, 1, 2, 3]], freshness: {source_timestamp_ms: NOW, source_age_ms: 0, stale_after_ms: 604800000, status: "fresh", stale: false}})};
    }
    if (parsed.pathname.startsWith("/signals/")) {
      return {ok: true, status: 200, headers: {get: () => "application/json"}, json: async () => ({data: [{type: "EMA Cross", direction: "BUY", confidence: 90, reason: "do not persist this text"}]})};
    }
    if (parsed.pathname.startsWith("/analysis/")) {
      return {ok: false, status: 500, headers: {get: () => "text/plain"}, json: async () => ({})};
    }
    throw new Error("unexpected_url");
  };

  const report = await runPullmolReadOnlyProbe({
    fetchImpl,
    now: () => NOW
  });
  assert.equal(urls.length, 8);
  assert.equal(report.requests.length, 8);
  assert.equal(report.safety.getRequestsOnly, true);
  assert.equal(report.safety.credentialsUsed, false);
  assert.equal(report.safety.orderSubmissionAttempted, false);
  assert.equal(report.safety.fundsMoved, false);
  assert.equal(report.requests.filter(item => item.path.startsWith("/signals/")).length, 3);
  assert.ok(report.requests.filter(item => item.path.startsWith("/signals/")).every(item => item.containsEntryLevels === false));
  assert.equal(JSON.stringify(report).includes("do not persist this text"), false);
});

test("probe rejects a changed base URL instead of becoming a generic fetch proxy", async () => {
  await assert.rejects(
    runPullmolReadOnlyProbe({baseUrl: "https://attacker.example", fetchImpl: async () => { throw new Error("must_not_call"); }}),
    /base_url_not_allowlisted/
  );
});
