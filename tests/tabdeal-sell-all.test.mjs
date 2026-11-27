import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {
  prepareTabdealSellAllBtc,
  buildTabdealLimitIocSellRequest,
  runTabdealSellAllBtc
} from "../src/tabdeal-sell-all.js";

const symbolInfo = {
  symbol: "BTCUSDT",
  status: "TRADING",
  isSpotTradingAllowed: true,
  orderTypes: ["LIMIT", "MARKET"],
  filters: [
    {filterType: "LOT_SIZE", minQty: "0.00000100", maxQty: "100000.00000000", stepSize: "0.00000100"},
    {filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "10000000.00", tickSize: "0.01"},
    {filterType: "MIN_NOTIONAL", minNotional: "1.00000000", applyToMarket: true, avgPriceMins: 5}
  ]
};
const depth = {
  bids: [["60000.00", "0.00001000"], ["59900.00", "0.00010000"]],
  asks: [["60010.00", "0.00010000"]]
};
const account = {
  canTrade: true,
  takerCommission: 40,
  balances: [
    {asset: "BTC", free: "0.00001799", locked: "0.00000000"},
    {asset: "USDT", free: "0.12", locked: "0.00"}
  ]
};
const readyArgs = {symbolInfo, depth, account, openOrders: []};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"content-type": "application/json"}
  });
}
function readOnlyFetchMock({postResponse} = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = options.method || "GET";
    calls.push({url: String(url), method});
    if (parsed.hostname === "api1.tabdeal.org" && parsed.pathname.endsWith("/exchangeInfo")) {
      return jsonResponse({symbols: [symbolInfo]});
    }
    if (parsed.hostname === "api1.tabdeal.org" && parsed.pathname.endsWith("/depth")) {
      return jsonResponse(depth);
    }
    if (parsed.hostname === "api1.tabdeal.org" && parsed.pathname.endsWith("/account")) {
      return jsonResponse(account);
    }
    if (parsed.hostname === "api1.tabdeal.org" && parsed.pathname.endsWith("/openOrders")) {
      return jsonResponse([]);
    }
    if (parsed.hostname === "api1.tabdeal.org" && parsed.pathname.endsWith("/order") && method === "GET") {
      return jsonResponse({code: 1204, msg: "Order not found"}, 404);
    }
    if (parsed.hostname === "api1.tabdeal.org" && parsed.pathname.endsWith("/order") && method === "POST") {
      if (typeof postResponse === "function") return postResponse(url, options);
      return jsonResponse({
        orderId: 456, clientOrderId: "sellbtc-123", symbol: "BTCUSDT",
        side: "SELL", type: "LIMIT", status: "FILLED",
        origQty: "0.00001700", executedQty: "0.00001700",
        cummulativeQuoteQty: "1.01900000"
      });
    }
    throw new Error("unexpected_test_request " + method + " " + parsed.pathname);
  };
  return {fetchImpl, calls};
}

test("preflight rounds free BTC down to LOT_SIZE and estimates IOC sale proceeds", () => {
  const result = prepareTabdealSellAllBtc(readyArgs);
  assert.equal(result.status, "READY");
  assert.equal(result.sellQuantity, "0.00001700");
  assert.equal(result.unsellableStepRemainderBtc, "0.00000099");
  assert.equal(result.side, "SELL");
  assert.equal(result.orderType, "LIMIT");
  assert.equal(result.timeInForce, "IOC");
  assert.equal(result.limitPrice, "59700.00");
  assert.ok(result.estimatedGrossQuote > 1);
  assert.ok(result.estimatedSlippageBps >= 0);
  assert.ok(result.estimatedSlippageBps <= 50);
  assert.equal(result.ordersSubmitted, false);
});

test("never rounds sell quantity upward above the free BTC balance", () => {
  const result = prepareTabdealSellAllBtc(readyArgs);
  assert.ok(Number(result.sellQuantity) <= Number(account.balances[0].free));
  assert.equal(Number(result.sellQuantity) % 0.000001 < 1e-10, true);
});

test("blocks if the exchange account cannot trade", () => {
  assert.throws(() => prepareTabdealSellAllBtc({
    ...readyArgs, account: {...account, canTrade: false}
  }), /account_trading_disabled/);
});

test("blocks if any BTC is locked instead of canceling existing orders", () => {
  assert.throws(() => prepareTabdealSellAllBtc({
    ...readyArgs,
    account: {...account, balances: [{asset: "BTC", free: "0.00001799", locked: "0.00000100"}]}
  }), /btc_balance_locked_by_open_orders/);
});

test("blocks when BTCUSDT has open orders", () => {
  assert.throws(() => prepareTabdealSellAllBtc({
    ...readyArgs, openOrders: [{orderId: 1, side: "SELL", status: "NEW"}]
  }), /existing_btcusdt_open_orders_present/);
});

test("blocks a sell below exchange minimum quantity or minimum notional", () => {
  assert.throws(() => prepareTabdealSellAllBtc({
    ...readyArgs,
    account: {...account, balances: [{asset: "BTC", free: "0.00000099", locked: "0"}]}
  }), /below_minimum_quantity/);
  assert.throws(() => prepareTabdealSellAllBtc({
    ...readyArgs,
    account: {...account, balances: [{asset: "BTC", free: "0.00001000", locked: "0"}]}
  }), /below_minimum_notional/);
});

test("blocks if the visible bid depth cannot fill the whole quantity within the price floor", () => {
  assert.throws(() => prepareTabdealSellAllBtc({
    ...readyArgs,
    depth: {
      bids: [["60000.00", "0.00000100"]],
      asks: [["60010.00", "0.00010000"]]
    }
  }), /visible_bid_depth_below_full_quantity/);
});

test("blocks a wide or crossed order book and an unsupported symbol state", () => {
  assert.throws(() => prepareTabdealSellAllBtc({
    ...readyArgs,
    depth: {bids: [["59000.00", "0.01"]], asks: [["61000.00", "0.01"]]}
  }), /spread_above_limit/);
  assert.throws(() => prepareTabdealSellAllBtc({
    ...readyArgs, symbolInfo: {...symbolInfo, status: "HALT"}
  }), /symbol_not_trading/);
});

test("builds a correctly signed BTCUSDT LIMIT IOC SELL request", () => {
  const request = buildTabdealLimitIocSellRequest({
    quantity: "0.00001700", price: "59700.00",
    clientOrderId: "sellbtc-123", apiKey: "test-key", apiSecret: "test-secret",
    timestamp: 1_800_000_000_000
  });
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api1.tabdeal.org/api/v1/order");
  const params = new URLSearchParams(request.body);
  const signature = params.get("signature");
  params.delete("signature");
  assert.equal(signature, createHmac("sha256", "test-secret").update(params.toString()).digest("hex"));
  assert.equal(params.get("symbol"), "BTCUSDT");
  assert.equal(params.get("side"), "SELL");
  assert.equal(params.get("type"), "LIMIT");
  assert.equal(params.get("timeInForce"), "IOC");
  assert.equal(params.get("quantity"), "0.00001700");
  assert.equal(params.get("price"), "59700.00");
  assert.equal(params.get("newClientOrderId"), "sellbtc-123");
});

test("dry-run checks live balances and order book but never sends POST", async () => {
  const {fetchImpl, calls} = readOnlyFetchMock();
  const report = await runTabdealSellAllBtc({
    apiKey: "test-key", apiSecret: "test-secret",
    mode: "dry_run", fetchImpl
  });
  assert.equal(report.result, "dry_run_passed_no_order_sent");
  assert.equal(report.ordersSubmitted, false);
  assert.equal(report.preflight.sellQuantity, "0.00001700");
  assert.equal(calls.some(call => call.method === "POST"), false);
});

test("live mode refuses to POST without the separate explicit live confirmation", async () => {
  const {fetchImpl, calls} = readOnlyFetchMock();
  const report = await runTabdealSellAllBtc({
    apiKey: "test-key", apiSecret: "test-secret",
    mode: "live_sell", confirmLiveSell: false,
    confirmedQuantity: "0.00001700", runId: "123",
    fetchImpl
  });
  assert.equal(report.result, "live_sell_confirmation_missing_halt");
  assert.equal(calls.some(call => call.method === "POST"), false);
});

test("live mode refuses to POST if the confirmed BTC quantity differs from fresh preflight", async () => {
  const {fetchImpl, calls} = readOnlyFetchMock();
  const report = await runTabdealSellAllBtc({
    apiKey: "test-key", apiSecret: "test-secret",
    mode: "live_sell", confirmLiveSell: true,
    confirmedQuantity: "0.00001800", runId: "123",
    fetchImpl
  });
  assert.equal(report.result, "live_sell_quantity_confirmation_mismatch_halt");
  assert.equal(calls.some(call => call.method === "POST"), false);
});

test("live sell performs at most one POST and reports the exchange's fill state", async () => {
  const {fetchImpl, calls} = readOnlyFetchMock();
  const report = await runTabdealSellAllBtc({
    apiKey: "test-key", apiSecret: "test-secret",
    mode: "live_sell", confirmLiveSell: true,
    confirmedQuantity: "0.00001700", runId: "123",
    repository: "Mehran0960/tabdeal-ai-trader-public",
    commitSha: "a".repeat(40), githubToken: "test-github-token",
    fetchImpl,
    claimLock: async () => ({claimed: true, result: "test_lock_claimed"})
  });
  assert.equal(report.result, "sell_filled");
  assert.equal(report.ordersSubmitted, true);
  assert.equal(report.order.executedQuantity, "0.00001700");
  assert.equal(calls.filter(call => call.method === "POST" && new URL(call.url).pathname.endsWith("/order")).length, 1);
});


test("allows a new SELL on a later workflow run while blocking a replay of the same run", async () => {
  const claimedRuns = new Set();
  const lockCalls = [];
  const claimLock = async ({runId}) => {
    lockCalls.push(String(runId));
    if (claimedRuns.has(String(runId))) {
      return {claimed: false, result: "sell_execution_already_claimed"};
    }
    claimedRuns.add(String(runId));
    return {claimed: true, result: "test_lock_claimed"};
  };

  async function execute(runId) {
    const {fetchImpl, calls} = readOnlyFetchMock({
      postResponse: async (_url, options) => {
        const params = new URLSearchParams(options.body);
        return jsonResponse({
          orderId: 456,
          clientOrderId: params.get("newClientOrderId"),
          symbol: "BTCUSDT",
          side: "SELL",
          type: "LIMIT",
          status: "FILLED",
          origQty: params.get("quantity"),
          executedQty: params.get("quantity"),
          cummulativeQuoteQty: "1.01900000"
        });
      }
    });
    const report = await runTabdealSellAllBtc({
      apiKey: "test-key", apiSecret: "test-secret",
      mode: "live_sell", confirmLiveSell: true,
      confirmedQuantity: "0.00001700", runId,
      repository: "Mehran0960/tabdeal-ai-trader-public",
      commitSha: "a".repeat(40), githubToken: "test-github-token",
      fetchImpl, claimLock
    });
    return {report, calls};
  }

  const first = await execute("123");
  const second = await execute("124");
  const sameRunReplay = await execute("123");

  assert.equal(first.report.result, "sell_filled");
  assert.equal(second.report.result, "sell_filled");
  assert.notEqual(first.report.clientOrderId, second.report.clientOrderId);
  assert.equal(first.report.clientOrderId, "sellbtc-123");
  assert.equal(second.report.clientOrderId, "sellbtc-124");
  assert.equal(sameRunReplay.report.result, "sell_execution_already_claimed");
  assert.equal(first.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(second.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(sameRunReplay.calls.filter(call => call.method === "POST").length, 0);
  assert.deepEqual(lockCalls, ["123", "124", "123"]);
});

test("live sell halts without duplicate POST after an uncertain submission", async () => {
  const {fetchImpl: baseFetch, calls} = readOnlyFetchMock({
    postResponse: async () => { throw new Error("simulated network timeout"); }
  });
  const report = await runTabdealSellAllBtc({
    apiKey: "test-key", apiSecret: "test-secret",
    mode: "live_sell", confirmLiveSell: true,
    confirmedQuantity: "0.00001700", runId: "123",
    fetchImpl: baseFetch,
    claimLock: async () => ({claimed: true, result: "test_lock_claimed"})
  });
  assert.equal(report.result, "sell_post_outcome_unknown_halt_no_retry");
  assert.equal(report.ordersSubmitted, "unknown");
  assert.equal(calls.filter(call => call.method === "POST" && new URL(call.url).pathname.endsWith("/order")).length, 1);
});

test("rejects malformed or excessive order quantities before building a request", () => {
  assert.throws(() => buildTabdealLimitIocSellRequest({
    quantity: "1e-4", price: "59700", clientOrderId: "sellbtc-1",
    apiKey: "test-key", apiSecret: "test-secret"
  }), /order_quantity_invalid/);
  assert.throws(() => buildTabdealLimitIocSellRequest({
    quantity: "0.00001", price: "59700", clientOrderId: "bad id",
    apiKey: "test-key", apiSecret: "test-secret"
  }), /client_order_id_invalid/);
});
