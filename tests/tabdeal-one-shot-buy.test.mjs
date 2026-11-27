import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {
  ONE_SHOT_SYMBOL,
  ONE_SHOT_QUOTE_AMOUNT,
  runTabdealOneShotBuy,
  claimOneShotExecutionLock,
  safeOneShotSummary
} from "../scripts/tabdeal-one-shot-buy.mjs";

const apiKey = "unit-test-api-key";
const apiSecret = "unit-test-api-secret";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"content-type": "application/json"}
  });
}
function validExchangeInfo(overrides = {}) {
  return [{
    symbol: "BTCUSDT",
    status: "TRADING",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    orderTypes: ["LIMIT", "MARKET"],
    isSpotTradingAllowed: true,
    isMarginTradingAllowed: false,
    quoteOrderQtyMarketAllowed: true,
    permissions: ["SPOT"],
    filters: [
      {filterType: "MIN_NOTIONAL", minNotional: "1", applyToMarket: true},
      {filterType: "MARKET_LOT_SIZE", minQty: "0.000001", maxQty: "100", stepSize: "0.000001"}
    ],
    ...overrides
  }];
}
function validDepth(overrides = {}) {
  return {
    lastUpdateId: 123,
    bids: [["89999", "2"]],
    asks: [["90000", "2"]],
    ...overrides
  };
}
function validAccount(overrides = {}) {
  return {
    accountType: "SPOT",
    canTrade: true,
    permissions: ["SPOT"],
    balances: [{asset: "USDT", free: "1.00000000", freeze: "0"}],
    ...overrides
  };
}
function filledOrder() {
  return {
    symbol: "BTCUSDT",
    orderId: 7001,
    clientOrderId: "t1shot-12345",
    price: "0",
    origQty: "0.00001111",
    executedQty: "0.00001111",
    cummulativeQuoteQty: "1.00000000",
    status: "FILLED",
    type: "MARKET",
    side: "BUY",
    fills: [{
      price: "90000",
      qty: "0.00001111",
      commission: "0.00000001",
      commissionAsset: "BTC"
    }]
  };
}
function makeFetch({
  exchangeInfo = validExchangeInfo(),
  depth = validDepth(),
  account = validAccount(),
  openOrders = [],
  priorOrderStatus = 404,
  priorOrderBody = {code: 1204, msg: "Order not found"},
  postStatus = 200,
  postBody = filledOrder(),
  postThrows = false,
  recoveredOrder = null,
  recoverAfterPost = false
} = {}) {
  const calls = [];
  let postAttempted = false;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || "GET").toUpperCase();
    calls.push({url, method, init});
    if (method === "POST") {
      postAttempted = true;
      if (postThrows) throw new Error("simulated network uncertainty");
      return jsonResponse(postBody, postStatus);
    }
    if (url.pathname.endsWith("/exchangeInfo")) return jsonResponse(exchangeInfo);
    if (url.pathname.endsWith("/depth")) return jsonResponse(depth);
    if (url.pathname.endsWith("/account")) return jsonResponse(account);
    if (url.pathname.endsWith("/openOrders")) return jsonResponse(openOrders);
    if (url.pathname.endsWith("/order")) {
      if (recoveredOrder && (!recoverAfterPost || postAttempted)) return jsonResponse(recoveredOrder);
      return jsonResponse(priorOrderBody, priorOrderStatus);
    }
    throw new Error("unexpected_test_request " + method + " " + url.pathname);
  };
  return {fetchImpl, calls};
}
function signedBodyParams(call) {
  const body = new URLSearchParams(call.init.body);
  const signature = body.get("signature");
  body.delete("signature");
  const expected = createHmac("sha256", apiSecret).update(body.toString(), "utf8").digest("hex");
  assert.equal(signature, expected);
  return new URLSearchParams(call.init.body);
}

test("requires explicit manual workflow confirmation before any network call", async () => {
  const {fetchImpl, calls} = makeFetch();
  const report = await runTabdealOneShotBuy({
    claimLock: async () => ({claimed: true, result: "test_lock_claimed"}),
    apiKey, apiSecret, confirm: false, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "explicit_workflow_confirmation_missing");
  assert.equal(report.orderSubmitted, false);
  assert.equal(calls.length, 0);
});

test("sends one capped BTCUSDT quote-sized market buy after all preflight gates pass", async () => {
  const {fetchImpl, calls} = makeFetch();
  const report = await runTabdealOneShotBuy({
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "order_accepted_reconciled");
  assert.equal(report.orderSubmitted, true);
  assert.equal(report.order.symbol, ONE_SHOT_SYMBOL);
  assert.equal(report.order.status, "FILLED");
  assert.equal(report.order.cumulativeQuoteQuantity, ONE_SHOT_QUOTE_AMOUNT);
  const posts = calls.filter(call => call.method === "POST");
  assert.equal(posts.length, 1);
  const params = signedBodyParams(posts[0]);
  assert.equal(params.get("symbol"), "BTCUSDT");
  assert.equal(params.get("side"), "BUY");
  assert.equal(params.get("type"), "MARKET");
  assert.equal(params.get("quoteOrderQty"), ONE_SHOT_QUOTE_AMOUNT);
  assert.equal(params.get("newClientOrderId"), "t1shot-12345");
  assert.equal(params.has("quantity"), false);
  assert.equal(report.automaticRetry, false);
  assert.equal(report.sellOrderSent, false);
  assert.equal(report.cancellationSent, false);
  assert.equal(report.withdrawalOrTransferSent, false);
});

test("aborts before POST when quoteOrderQty market buys are not allowed", async () => {
  const {fetchImpl, calls} = makeFetch({
    exchangeInfo: validExchangeInfo({quoteOrderQtyMarketAllowed: false})
  });
  const report = await runTabdealOneShotBuy({
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "preflight_blocked");
  assert.equal(report.reason, "quote_order_qty_market_not_allowed");
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
});

test("aborts before POST when free USDT is below the one-USDT cap", async () => {
  const {fetchImpl, calls} = makeFetch({
    account: validAccount({balances: [{asset: "USDT", free: "0.999", freeze: "0"}]})
  });
  const report = await runTabdealOneShotBuy({
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "preflight_blocked");
  assert.equal(report.reason, "free_usdt_below_one");
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
});

test("aborts before POST when the venue minimum exceeds one USDT", async () => {
  const info = validExchangeInfo();
  info[0].filters[0].minNotional = "1.01";
  const {fetchImpl, calls} = makeFetch({exchangeInfo: info});
  const report = await runTabdealOneShotBuy({
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "preflight_blocked");
  assert.equal(report.reason, "min_notional_exceeds_one_usdt_or_missing");
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
});

test("aborts before POST when existing BTCUSDT open orders are present", async () => {
  const {fetchImpl, calls} = makeFetch({openOrders: [{orderId: 77, symbol: "BTCUSDT"}]});
  const report = await runTabdealOneShotBuy({
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "preflight_blocked");
  assert.equal(report.reason, "existing_btcusdt_open_orders_present");
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
});

test("aborts before POST when spread exceeds the configured execution ceiling", async () => {
  const {fetchImpl, calls} = makeFetch({
    depth: validDepth({bids: [["89000", "2"]], asks: [["90000", "2"]]})
  });
  const report = await runTabdealOneShotBuy({
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "preflight_blocked");
  assert.equal(report.reason, "spread_above_limit");
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
});

test("rejects a valid order once and never retries a 4xx response", async () => {
  const {fetchImpl, calls} = makeFetch({
    postStatus: 400,
    postBody: {code: -1013, msg: "Filter failure"}
  });
  const report = await runTabdealOneShotBuy({
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "order_rejected_no_retry");
  assert.equal(report.orderSubmitted, false);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

test("reconciles an uncertain POST once and never repeats the order request", async () => {
  const {fetchImpl, calls} = makeFetch({
    postThrows: true,
    priorOrderStatus: 404,
    priorOrderBody: {code: 1204, msg: "Order not found"}
  });
  const report = await runTabdealOneShotBuy({
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "post_outcome_unknown_halt_no_retry");
  assert.equal(report.orderSubmitted, "unknown");
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

test("reuses the same client order ID on rerun and does not duplicate a prior order", async () => {
  const {fetchImpl, calls} = makeFetch({recoveredOrder: filledOrder()});
  const report = await runTabdealOneShotBuy({
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "existing_order_reconciled_no_resubmit");
  assert.equal(report.orderSubmitted, false);
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
});


test("does not submit when the permanent one-shot lock already exists", async () => {
  const {fetchImpl, calls} = makeFetch();
  const report = await runTabdealOneShotBuy({
    claimLock: async () => ({claimed: false, result: "one_shot_already_claimed"}),
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "one_shot_already_claimed");
  assert.equal(report.orderSubmitted, false);
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
});

test("reconciles an HTTP 5xx by client ID without repeating POST", async () => {
  const {fetchImpl, calls} = makeFetch({
    postStatus: 500,
    postBody: {message: "server error"},
    recoveredOrder: filledOrder(),
    recoverAfterPost: true
  });
  const report = await runTabdealOneShotBuy({
    claimLock: async () => ({claimed: true, result: "test_lock_claimed"}),
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  assert.equal(report.result, "reconciled_after_server_error");
  assert.equal(report.orderSubmitted, true);
  assert.equal(report.order.status, "FILLED");
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

test("atomically claims a permanent GitHub ref before the only order POST", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url: String(url), method: init.method});
    if (init.method === "GET") return new Response("not found", {status: 404});
    if (init.method === "POST") return new Response(JSON.stringify({ref: "refs/tags/tabdeal-one-shot-1usdt-20261127"}), {status: 201});
    throw new Error("unexpected method");
  };
  const result = await claimOneShotExecutionLock({
    token: "unit-test-token",
    repository: "owner/repo",
    commitSha: "a".repeat(40),
    fetchImpl
  });
  assert.equal(result.claimed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
});

test("safe summary never exposes API credentials", async () => {
  const {fetchImpl} = makeFetch();
  const report = await runTabdealOneShotBuy({
    apiKey, apiSecret, confirm: true, runId: "12345", fetchImpl
  });
  const summary = JSON.stringify(safeOneShotSummary(report));
  assert.equal(summary.includes(apiKey), false);
  assert.equal(summary.includes(apiSecret), false);
});
