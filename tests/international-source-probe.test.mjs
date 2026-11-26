import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectInternationalProbePayload,
  runInternationalSourceProbe,
  summarizeProviderReachability
} from "../src/international-source-probe.js";

test("accepts chronological Binance OHLCV rows without exposing price values", () => {
  const payload = [
    [1000, "100", "110", "90", "105", "1", 1999, "105", 10, "0", "0", "0"],
    [2000, "105", "115", "100", "110", "2", 2999, "220", 12, "0", "0", "0"]
  ];
  const result = inspectInternationalProbePayload("binance_klines", payload);
  assert.deepEqual(result, {schemaStatus: "ok", recordCount: 2});
  assert.equal(Object.hasOwn(result, "close"), false);
});

test("rejects unordered or malformed Binance candles", () => {
  const payload = [
    [2000, "100", "110", "90", "105", "1", 2999, "105"],
    [1000, "105", "115", "100", "110", "2", 1999, "220"]
  ];
  assert.equal(
    inspectInternationalProbePayload("binance_klines", payload).schemaStatus,
    "invalid_payload"
  );
});

test("validates Kraken OHLC payloads and surfaces provider errors", () => {
  const good = {
    error: [],
    result: {
      XXBTZUSD: [[1688671200, "1", "2", "1", "2", "1", "3", 4]],
      last: 1688672160
    }
  };
  assert.deepEqual(
    inspectInternationalProbePayload("kraken_ohlc", good),
    {schemaStatus: "ok", recordCount: 1}
  );
  const bad = {error: ["EAPI:Rate limit exceeded"], result: {}};
  assert.equal(
    inspectInternationalProbePayload("kraken_ohlc", bad).schemaStatus,
    "provider_error"
  );
});

test("runs bounded public probes and returns only response metadata", async () => {
  const fixtures = new Map([
    ["/api/v3/ping", {}],
    ["/api/v3/exchangeInfo", {symbol: "BTCUSDT", status: "TRADING"}],
    ["/api/v3/klines", [
      [1000, "1", "2", "1", "2", "1", 1999, "2", 1, "0", "0", "0"],
      [2000, "2", "3", "2", "3", "1", 2999, "3", 1, "0", "0", "0"]
    ]],
    ["/0/public/Time", {error: [], result: {unixtime: 1688671200}}],
    ["/0/public/OHLC", {error: [], result: {XXBTZUSD: [[1000, "1", "2", "1", "2", "1", "3", 4]], last: 2000}}],
    ["/0/public/Trades", {error: [], result: {XXBTZUSD: [["1", "2", 1688671200, "b", "m", "", 1]], last: "2"}}],
    ["/api/v3/ping-coingecko", {gecko_says: "(V3) To the Moon!"}]
  ]);
  const fetchImpl = async input => {
    const url = new URL(input);
    const key = url.hostname === "api.coingecko.com"
      ? "/api/v3/ping-coingecko"
      : url.pathname;
    const body = fixtures.get(key);
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      json: async () => body
    };
  };
  const report = await runInternationalSourceProbe({
    fetchImpl,
    now: () => new Date("2026-11-26T00:00:00.000Z")
  });
  assert.equal(report.requiredProviderStatus, "reachable");
  assert.equal(report.probes.length, 7);
  assert.equal(report.safety.ordersSubmitted, 0);
  assert.equal(report.safety.credentialsUsed, false);
  assert.equal(report.probes.find(item => item.id === "coingecko_ping").status, "reachable");
  assert.equal(Object.hasOwn(report.probes[0], "price"), false);
});

test("marks optional keyless source errors without blocking required providers", () => {
  const results = [
    {provider: "binance", status: "reachable"},
    {provider: "binance", status: "reachable"},
    {provider: "kraken", status: "reachable"},
    {provider: "kraken", status: "reachable"},
    {provider: "coingecko", status: "auth_required_or_access_restricted", optional: true}
  ];
  const summary = summarizeProviderReachability(results);
  assert.equal(summary.binance.status, "all_checked_endpoints_reachable");
  assert.equal(summary.kraken.status, "partially_reachable");
  assert.equal(summary.coingecko.optional, true);
});
