import test from "node:test";
import assert from "node:assert/strict";
import {
  TABDEAL_ROTATION_UNIVERSE_POLICY,
  buildTabdealRotationUniverse
} from "../src/tabdeal-rotation-universe.js";

function market(symbol, baseAsset, overrides = {}) {
  return {
    symbol, baseAsset, quoteAsset: "USDT", status: "TRADING",
    isSpotTradingAllowed: true, permissions: ["SPOT"],
    filters: [
      { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100000", stepSize: "0.001" },
      { filterType: "MIN_NOTIONAL", minNotional: "5" },
      { filterType: "PRICE_FILTER", tickSize: "0.0001" }
    ],
    ...overrides
  };
}
function fixture() {
  const tabdealExchangeInfo = [
    market("BTCUSDT", "BTC"),
    market("ETHUSDT", "ETH"),
    market("SOLUSDT", "SOL"),
    market("XRPUSDT", "XRP"),
    market("DOGEUSDT", "DOGE"),
    market("FOOUPUSDT", "FOOUP"),
    market("USDCUSDT", "USDC"),
    market("LOCALUSDT", "LOCAL")
  ];
  const binanceExchangeInfo = { symbols: [
    market("BTCUSDT", "BTC"), market("ETHUSDT", "ETH"),
    market("SOLUSDT", "SOL"), market("XRPUSDT", "XRP"),
    market("DOGEUSDT", "DOGE"), market("FOOUPUSDT", "FOOUP"),
    market("USDCUSDT", "USDC"),
  ] };
  const binanceTickers24h = [
    { symbol: "BTCUSDT", quoteVolume: "1000000000", count: 100000, lastPrice: "90000" },
    { symbol: "ETHUSDT", quoteVolume: "500000000", count: 80000, lastPrice: "3000" },
    { symbol: "SOLUSDT", quoteVolume: "100000000", count: 40000, lastPrice: "150" },
    { symbol: "XRPUSDT", quoteVolume: "50000000", count: 20000, lastPrice: "2" },
    { symbol: "DOGEUSDT", quoteVolume: "10000000", count: 10000, lastPrice: "0.2" },
    { symbol: "FOOUPUSDT", quoteVolume: "90000000", count: 30000, lastPrice: "1" },
    { symbol: "USDCUSDT", quoteVolume: "100000000", count: 50000, lastPrice: "1" }
  ];
  return { tabdealExchangeInfo, binanceExchangeInfo, binanceTickers24h };
}

test("discovers all liquid cross-listed Tabdeal and Binance USDT Spot assets without hardcoded coin names", () => {
  const result = buildTabdealRotationUniverse(fixture());
  assert.equal(result.status, "complete");
  assert.equal(result.coverageComplete, true);
  assert.deepEqual(result.markets.map(row => row.symbol), [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"
  ]);
  assert.equal(result.tradeAuthorized, false);
  assert.equal(result.safety.ordersPlaced, 0);
});

test("sorts by external quote turnover but does not confuse it with local executable liquidity", () => {
  const result = buildTabdealRotationUniverse(fixture());
  assert.equal(result.markets[0].quoteVolumeUsdt, 1_000_000_000);
  assert.ok(result.limitations.some(line => line.includes("not Tabdeal-local turnover")));
});

test("excludes missing cross-listings, stablecoin bases, leveraged tokens, and invalid market rules", () => {
  const input = fixture();
  input.tabdealExchangeInfo.push(market("BADUSDT", "BAD", {
    filters: [{ filterType: "LOT_SIZE", minQty: "0", stepSize: "0" }]
  }));
  input.binanceExchangeInfo.symbols.push(market("BADUSDT", "BAD", {
    filters: [{ filterType: "LOT_SIZE", minQty: "0", stepSize: "0" }]
  }));
  input.binanceTickers24h.push({ symbol: "BADUSDT", quoteVolume: "9000000", count: 9000 });
  const result = buildTabdealRotationUniverse(input);
  assert.ok(!result.markets.some(row => ["USDCUSDT", "FOOUPUSDT", "BADUSDT", "LOCALUSDT"].includes(row.symbol)));
  assert.equal(result.excluded.invalidMarketRules, 1);
  assert.equal(result.excluded.tabdealInactiveOrNonSpot, 1);
  assert.equal(result.excluded.binanceInactiveOrNonSpot, 0);
  assert.equal(result.excluded.missingOnBinance, 1);
});

test("enforces quote-volume and trade-count minimums", () => {
  const input = fixture();
  input.binanceTickers24h.find(row => row.symbol === "DOGEUSDT").quoteVolume = "1000";
  input.binanceTickers24h.find(row => row.symbol === "XRPUSDT").count = 1;
  const result = buildTabdealRotationUniverse(input);
  assert.ok(!result.markets.some(row => ["DOGEUSDT", "XRPUSDT"].includes(row.symbol)));
  assert.equal(result.excluded.belowLiquidityThreshold, 1);
  assert.equal(result.excluded.insufficientTradeCount, 1);
});

test("fails closed and explicitly marks incomplete coverage when the safety cap is exceeded", () => {
  const input = fixture();
  const result = buildTabdealRotationUniverse({ ...input, maximumMarkets: 2 });
  assert.equal(result.status, "capacity_exceeded");
  assert.equal(result.coverageComplete, false);
  assert.equal(result.omittedBySafetyCap, 3);
  assert.equal(result.markets.length, 2);
  assert.equal(result.tradeAuthorized, false);
});

test("rejects malformed inputs and unsafe policies", () => {
  assert.throws(() => buildTabdealRotationUniverse({ ...fixture(), maximumMarkets: 1201 }), /policy_invalid/);
  assert.throws(() => buildTabdealRotationUniverse({ ...fixture(), minimumQuoteVolumeUsdt: 0 }), /policy_invalid/);
  assert.throws(() => buildTabdealRotationUniverse({ ...fixture(), binanceTickers24h: null }), /tickers_invalid/);
});

test("uses a liquidity floor rather than assuming a fixed five-asset universe", () => {
  assert.equal(TABDEAL_ROTATION_UNIVERSE_POLICY.minimumBinanceQuoteVolumeUsdt, 250_000);
  assert.equal(TABDEAL_ROTATION_UNIVERSE_POLICY.maximumResearchMarkets, 200);
});

test("supports Binance permissionSets after the legacy permissions field is retired", () => {
  const input = fixture();
  const row = input.binanceExchangeInfo.symbols.find(item => item.symbol === "ETHUSDT");
  row.permissions = [];
  row.permissionSets = [["SPOT", "MARGIN"]];
  const result = buildTabdealRotationUniverse(input);
  assert.ok(result.markets.some(row => row.symbol === "ETHUSDT"));
  assert.equal(result.excluded.binanceInactiveOrNonSpot, 0);
});

test("keeps Spot-enabled public market data when an additional Binance account group is required", () => {
  const input = fixture();
  const row = input.binanceExchangeInfo.symbols.find(item => item.symbol === "ETHUSDT");
  row.permissions = [];
  row.permissionSets = [["SPOT"], ["TRD_GRP_999"]];
  const result = buildTabdealRotationUniverse(input);
  assert.ok(result.markets.some(row => row.symbol === "ETHUSDT"));
  assert.equal(result.excluded.binanceInactiveOrNonSpot, 0);
});

test("rejects Binance metadata with no Spot permission set", () => {
  const input = fixture();
  const row = input.binanceExchangeInfo.symbols.find(item => item.symbol === "ETHUSDT");
  row.permissions = [];
  row.permissionSets = [["MARGIN"], ["TRD_GRP_999"]];
  const result = buildTabdealRotationUniverse(input);
  assert.ok(!result.markets.some(row => row.symbol === "ETHUSDT"));
  assert.equal(result.excluded.binanceInactiveOrNonSpot, 1);
});
