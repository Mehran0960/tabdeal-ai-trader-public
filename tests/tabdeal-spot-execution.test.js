import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {
  TABDEAL_SPOT_EXECUTION_DEFAULTS,
  buildTabdealLimitOrderRequest,
  buildTabdealGetOrderRequest,
  buildTabdealCancelOrderRequest,
  createTabdealSpotExecutionClient
} from "../src/tabdeal-spot-execution.js";

const credentials = {apiKey: "test-key", apiSecret: "test-secret"};
const deterministic = {timestamp: 1_800_000_000_000, receiveWindowMs: 5_000};

test("builds a signed Spot LIMIT POST matching the official SDK form/query contract", async () => {
  const request = await buildTabdealLimitOrderRequest({
    ...credentials, ...deterministic, symbol: "BTCUSDT", side: "BUY",
    quantity: "0.001", price: "65000.25", clientOrderId: "paper-20261127-0001"
  });
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api1.tabdeal.org/api/v1/order");
  assert.equal(request.headers["X-MBX-APIKEY"], "test-key");
  assert.match(request.headers["content-type"], /application\/x-www-form-urlencoded/);
  const params = new URLSearchParams(request.body);
  const signature = params.get("signature");
  params.delete("signature");
  const expected = createHmac("sha256", "test-secret").update(params.toString()).digest("hex");
  assert.equal(signature, expected);
  assert.equal(params.get("symbol"), "BTCUSDT");
  assert.equal(params.get("side"), "BUY");
  assert.equal(params.get("type"), "LIMIT");
  assert.equal(params.get("quantity"), "0.001");
  assert.equal(params.get("price"), "65000.25");
  assert.equal(params.get("newClientOrderId"), "paper-20261127-0001");
});

test("builds read-only order lookup against the signed read API", async () => {
  const request = await buildTabdealGetOrderRequest({
    ...credentials, ...deterministic, symbol: "BTCUSDT", clientOrderId: "paper-1"
  });
  assert.equal(request.method, "GET");
  assert.ok(request.url.startsWith("https://api1.tabdeal.org/r/api/v1/order?"));
  const params = new URL(request.url).searchParams;
  assert.equal(params.get("origClientOrderId"), "paper-1");
  assert.ok(params.get("signature"));
});

test("builds cancellation request but does not send it", async () => {
  const request = await buildTabdealCancelOrderRequest({
    ...credentials, ...deterministic, symbol: "BTCUSDT", orderId: 12345
  });
  assert.equal(request.method, "DELETE");
  assert.ok(request.url.startsWith("https://api1.tabdeal.org/api/v1/order?"));
  assert.equal(new URL(request.url).searchParams.get("orderId"), "12345");
});

test("rejects unsupported symbols, non-LIMIT order types and invalid decimal values", async () => {
  await assert.rejects(buildTabdealLimitOrderRequest({
    ...credentials, ...deterministic, symbol: "ETHUSDT", side: "BUY",
    quantity: "0.01", price: "2500", clientOrderId: "x"
  }), /symbol_not_allowlisted/);
  await assert.rejects(buildTabdealLimitOrderRequest({
    ...credentials, ...deterministic, symbol: "BTCUSDT", side: "BUY",
    quantity: "1e-3", price: "2500", clientOrderId: "x"
  }), /order_quantity_invalid/);
  await assert.rejects(buildTabdealLimitOrderRequest({
    ...credentials, ...deterministic, symbol: "BTCUSDT", side: "BUY",
    quantity: "0.01", price: "0", clientOrderId: "x"
  }), /order_price_invalid/);
  await assert.rejects(buildTabdealLimitOrderRequest({
    ...credentials, ...deterministic, symbol: "BTCUSDT", side: "BUY",
    quantity: "0.01", price: "2500", clientOrderId: "bad id"
  }), /client_order_id_invalid/);
});

test("live order submission is blocked by defaults and does not touch the network", async () => {
  let calls = 0;
  const client = createTabdealSpotExecutionClient({
    ...credentials, fetchImpl: async () => { calls++; throw new Error("must not be called"); }
  });
  assert.deepEqual(
    {enabled: TABDEAL_SPOT_EXECUTION_DEFAULTS.liveTradingEnabled, kill: TABDEAL_SPOT_EXECUTION_DEFAULTS.killSwitch},
    {enabled: false, kill: true}
  );
  await assert.rejects(client.submitLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "65000",
    clientOrderId: "paper-closed"
  }), /live_execution_gate_closed/);
  assert.equal(calls, 0);
});

test("never repeats an uncertain POST; it reconciles once by client order ID", async () => {
  const calls = [];
  const client = createTabdealSpotExecutionClient({
    ...credentials,
    liveTradingEnabled: true,
    killSwitch: false,
    explicitOwnerApproval: true,
    maxOrderNotionalQuote: 100,
    portfolioRiskChecksPassed: true,
    fetchImpl: async (url, options) => {
      calls.push({url, method: options.method});
      if (options.method === "POST") throw new Error("simulated network timeout");
      return new Response(JSON.stringify({
        orderId: 77, clientOrderId: "paper-recover-1", symbol: "BTCUSDT",
        side: "BUY", type: "LIMIT", status: "NEW", origQty: "0.001",
        executedQty: "0", price: "65000", updateTime: 1_800_000_000_001
      }), {status: 200, headers: {"content-type": "application/json"}});
    }
  });
  const result = await client.submitLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "65000",
    clientOrderId: "paper-recover-1",
    riskPlan: {
      approved: true, quantity: 0.001, notional: 65,
      assumptions: {leverage: false, shorting: false}
    }
  });
  assert.equal(result.status, "reconciled_after_uncertain_submit");
  assert.equal(result.order.orderId, "77");
  assert.deepEqual(calls.map(x => x.method), ["POST", "GET"]);
});
