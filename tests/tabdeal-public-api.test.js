import test from "node:test";
import assert from "node:assert/strict";
import {
  assessTabdealPublicMarkets,
  assessTabdealDepth,
  probeTabdealPublicApi
} from "../src/tabdeal-public-api.js";

const market = (symbol, quoteAsset, overrides = {}) => ({
  symbol,
  status: "TRADING",
  baseAsset: symbol.replace(quoteAsset, ""),
  quoteAsset,
  baseAssetPrecision: "8",
  quoteAssetPrecision: "8",
  isSpotTradingAllowed: true,
  isMarginTradingAllowed: false,
  permissions: ["SPOT"],
  filters: [
    {filterType: "LOT_SIZE", minQty: "0.0001", stepSize: "0.0001"},
    {filterType: "MIN_NOTIONAL", minNotional: quoteAsset === "USDT" ? "1" : "50000"},
    {filterType: "PRICE_FILTER", tickSize: "0.01"}
  ],
  ...overrides
});

const sample = [
  market("BTCUSDT", "USDT"),
  market("ETHUSDT", "USDT"),
  market("BTCIRT", "IRT"),
  market("USDTIRT", "IRT"),
  market("OLDUSDT", "USDT", {status: "BREAK"}),
  market("FUTUSDT", "USDT", {permissions: ["FUTURES"]}),
  market("MARGINUSDT", "USDT", {isSpotTradingAllowed: false})
];

test("groups active Tabdeal spot markets by quote currency and extracts minimum filters", () => {
  const result = assessTabdealPublicMarkets(sample);
  assert.equal(result.rawActiveSpotMarketRecordCount, 4);
  assert.equal(result.activeSpotMarketCount, 4);
  assert.equal(result.duplicateMarketRecordCount, 0);
  assert.equal(result.usdt.count, 2);
  assert.equal(result.irt.count, 2);
  assert.deepEqual(result.usdt.minNotionalValues, [1]);
  assert.deepEqual(result.irt.minNotionalValues, [50000]);
  assert.equal(result.irtUnit, "UNVERIFIED");
  assert.equal(result.sampleMarkets.find(x => x.symbol === "BTCUSDT").minNotional, "1");
  assert.equal(result.executionAllowed, false);
  assert.equal(result.apiKeyCreated, false);
});

test("deduplicates repeated market metadata and reports conflicting duplicates", () => {
  const duplicate = market("BTCUSDT", "USDT", {
    filters: [{filterType: "MIN_NOTIONAL", minNotional: "2"}]
  });
  const result = assessTabdealPublicMarkets([...sample.slice(0, 4), duplicate]);
  assert.equal(result.rawActiveSpotMarketRecordCount, 5);
  assert.equal(result.activeSpotMarketCount, 4);
  assert.equal(result.duplicateMarketRecordCount, 1);
  assert.deepEqual(result.conflictingDuplicateSymbols, []);
  assert.equal(result.usdt.count, 2);
});

test("rejects empty or malformed exchange metadata", () => {
  assert.throws(() => assessTabdealPublicMarkets([]), /tabdeal_exchange_info_invalid_or_empty/);
  assert.throws(() => assessTabdealPublicMarkets([{symbol: "x"}]), /tabdeal_no_active_spot_markets/);
});

test("computes best prices, spread and top-five quote depth", () => {
  const result = assessTabdealDepth({
    bids: [["99", "2"], ["98", "3"]],
    asks: [["101", "1"], ["102", "4"]]
  }, "BTCUSDT");
  assert.equal(result.bestBid, 99);
  assert.equal(result.bestAsk, 101);
  assert.equal(result.spreadBps, 200);
  assert.equal(result.topFiveBidQuoteDepth, 492);
  assert.equal(result.topFiveAskQuoteDepth, 509);
  assert.equal(result.quoteUnit, "UNVERIFIED");
});

test("rejects malformed depth payload", () => {
  assert.throws(() => assessTabdealDepth({}, "BTCUSDT"), /tabdeal_depth_payload_invalid/);
});

test("live probe uses only public GET endpoints and never authenticates or submits orders", async () => {
  const calls = [];
  const bodies = [
    sample.slice(0, 4),
    {bids: [["99", "2"]], asks: [["101", "1"]]},
    {bids: [["99", "2"]], asks: [["101", "1"]]},
    {bids: [["99", "2"]], asks: [["101", "1"]]}
  ];
  const result = await probeTabdealPublicApi({
    apiBase: "https://api1.tabdeal.org/r/api/v1",
    fetchImpl: async (url, options) => {
      calls.push({url: String(url), options});
      return new Response(JSON.stringify(bodies[calls.length - 1]), {
        status: 200,
        headers: {"content-type": "application/json"}
      });
    },
    sleepImpl: async () => {}
  });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.options.method === "GET"));
  assert.ok(calls.every(call => !("authorization" in Object.fromEntries(Object.entries(call.options.headers).map(([k,v])=>[k.toLowerCase(),v])))));
  assert.equal(result.depthSnapshots.length, 3);
  assert.equal(result.depthSnapshots.every(x => x.listedInExchangeInfo), true);
  assert.equal(result.apiKeyCreated, false);
  assert.equal(result.privateEndpointCalled, false);
  assert.equal(result.orderSubmissionAttempted, false);
  assert.equal(result.exchangeOrdersPlaced, 0);
  assert.equal(result.fundsMoved, false);
  assert.equal(result.executionAllowed, false);
});
