import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateSellBook,
  runDomesticExchangeProbe
} from "../src/domestic-exchange-probe.js";

test("sell-book walk estimates quote proceeds across bid levels", () => {
  const result = estimateSellBook({
    bids: [[100, 0.00001], [99, 0.00003]],
    asks: [[101, 0.01]]
  }, "0.000033");
  assert.equal(result.canFillReferenceQuantity, true);
  assert.equal(result.bestBid, 100);
  assert.equal(result.bestAsk, 101);
  assert.equal(result.estimatedGrossUsdt, 0.00329);
  assert.equal(result.estimatedVwap, 0.00329 / 0.000033);
});

test("missing book fails closed", () => {
  const result = estimateSellBook(null, "0.000033");
  assert.equal(result.status, "unavailable");
  assert.equal(result.canFillReferenceQuantity, false);
  assert.equal(result.estimatedGrossUsdt, null);
});

test("probe uses only unauthenticated GET requests and summarizes current pair rules", async () => {
  const payloads = new Map([
    ["https://api.exir.io/v2/health", {name: "Exir"}],
    ["https://api.exir.io/v2/constants", {
      pairs: {"btc-usdt": {active: true, min_size: 0.00001, increment_size: 0.000001, increment_price: 0.01}}
    }],
    ["https://api.exir.io/v2/ticker?symbol=btc-usdt", {last: 60000, timestamp: "2026-11-28T00:00:00Z"}],
    ["https://api.exir.io/v2/orderbook?symbol=btc-usdt", {
      "btc-usdt": {bids: [[59990, 0.1]], asks: [[60010, 0.1]], timestamp: "2026-11-28T00:00:00Z"}
    }],
    ["https://api.exir.io/v2/trades?symbol=btc-usdt", {"btc-usdt": [{price: 60000}]}],
    ["https://api.wallex.ir/v1/markets", {
      result: {symbols: {BTCUSDT: {minQty: 0.000001, minNotional: 10, stepSize: 6, tickSize: 2}}}
    }],
    ["https://api.wallex.ir/v1/depth?symbol=BTCUSDT", {
      result: {bid: [{price: "59990", quantity: 0.1}], ask: [{price: "60010", quantity: 0.1}]}
    }],
    ["https://api.wallex.ir/v1/otc/markets", {
      result: {symbols: {BTCUSDT: {minQty: 0.000001, minNotional: 5, sellStatus: "ENABLE"}}}
    }],
    ["https://api.wallex.ir/v1/trades?symbol=BTCUSDT", {result: {trades: [{price: 60000}]}}],
    ["https://api1.tabdeal.org/r/api/v1/exchangeInfo", [{
      symbol: "BTCUSDT", status: "TRADING", isSpotTradingAllowed: true,
      filters: [
        {filterType: "MARKET_LOT_SIZE", minQty: "0.000001", stepSize: "0.000001"},
        {filterType: "MIN_NOTIONAL", minNotional: "1", applyToMarket: true}
      ]
    }]],
    ["https://api1.tabdeal.org/r/api/v1/depth?symbol=BTCUSDT&limit=5", {
      bids: [[59990, 0.1]], asks: [[60010, 0.1]]
    }]
  ]);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({url, init});
    assert.equal(init.method, "GET");
    assert.equal(Object.keys(init.headers ?? {}).some(key => /authorization|api-key|signature/i.test(key)), false);
    assert.equal(url.includes("/order/") || url.includes("/orders"), false);
    const payload = payloads.get(url);
    assert.ok(payload, "unexpected URL " + url);
    return {ok: true, status: 200, json: async () => payload};
  };
  const report = await runDomesticExchangeProbe({
    fetchImpl,
    now: () => new Date("2026-11-28T00:00:00Z")
  });
  assert.equal(requests.length, 11);
  assert.equal(report.safety.privateEndpointsCalled, false);
  assert.equal(report.safety.apiKeysUsed, false);
  assert.equal(report.safety.ordersSubmitted, false);
  assert.equal(report.providers[0].marketActive, true);
  assert.equal(report.providers[0].referenceQuantityMeetsKnownMinimum, true);
  assert.equal(report.providers[1].spot.referenceQuantityMeetsKnownMinimum, false);
  assert.equal(report.providers[1].otc.referenceQuantityMeetsKnownMinimum, false);
  assert.equal(report.providers[2].referenceQuantityMeetsKnownMinimum, true);
});

test("provider outages are represented as unknown rather than as tradable", async () => {
  const report = await runDomesticExchangeProbe({
    fetchImpl: async () => { throw new Error("offline"); },
    now: () => new Date("2026-11-28T00:00:00Z")
  });
  assert.equal(report.providers[0].marketListed, false);
  assert.equal(report.providers[0].referenceQuantityMeetsKnownMinimum, null);
  assert.equal(report.providers[0].book.canFillReferenceQuantity, false);
  assert.equal(report.safety.ordersSubmitted, false);
});
