import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {
  TABDEAL_SPOT_EXECUTION_DEFAULTS,
  buildTabdealLimitOrderRequest,
  buildTabdealGetOrderRequest,
  buildTabdealCancelOrderRequest,
  buildTabdealOcoSellOrderRequest,
  buildTabdealGetOcoOrderRequest,
  buildTabdealCancelOcoOrderRequest,
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
  let lookupCount = 0;
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
      lookupCount++;
      if (lookupCount === 1) {
        return new Response(JSON.stringify({code: -2013, msg: "Order does not exist"}), {
          status: 404, headers: {"content-type": "application/json"}
        });
      }
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
  assert.deepEqual(calls.map(x => x.method), ["GET", "POST", "GET"]);
});

test("does not create a duplicate when the client order ID already exists", async () => {
  const calls = [];
  const client = createTabdealSpotExecutionClient({
    ...credentials,
    liveTradingEnabled: true,
    killSwitch: false,
    explicitOwnerApproval: true,
    maxOrderNotionalQuote: 100,
    portfolioRiskChecksPassed: true,
    fetchImpl: async (_url, options) => {
      calls.push(options.method);
      return new Response(JSON.stringify({
        orderId: 99, clientOrderId: "paper-existing-1", symbol: "BTCUSDT",
        side: "BUY", type: "LIMIT", status: "NEW", origQty: "0.001",
        executedQty: "0", price: "65000", updateTime: 1_800_000_000_002
      }), {status: 200, headers: {"content-type": "application/json"}});
    }
  });
  const result = await client.submitLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "65000",
    clientOrderId: "paper-existing-1",
    riskPlan: {
      approved: true, quantity: 0.001, notional: 65,
      assumptions: {leverage: false, shorting: false}
    }
  });
  assert.equal(result.status, "existing_client_order_reconciled");
  assert.deepEqual(calls, ["GET"]);
});

test("refuses to submit when the risk plan is absent or outside the notional cap", async () => {
  let calls = 0;
  const client = createTabdealSpotExecutionClient({
    ...credentials,
    liveTradingEnabled: true,
    killSwitch: false,
    explicitOwnerApproval: true,
    maxOrderNotionalQuote: 50,
    portfolioRiskChecksPassed: true,
    fetchImpl: async () => { calls++; throw new Error("must not be called"); }
  });
  await assert.rejects(client.submitLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "65000",
    clientOrderId: "paper-over-cap"
  }), /risk_plan_invalid_or_over_cap/);
  assert.equal(calls, 0);
});

test("halts before POST when pre-submit order lookup has a server error", async () => {
  const calls = [];
  const client = createTabdealSpotExecutionClient({
    ...credentials,
    liveTradingEnabled: true,
    killSwitch: false,
    explicitOwnerApproval: true,
    maxOrderNotionalQuote: 100,
    portfolioRiskChecksPassed: true,
    fetchImpl: async (_url, options) => {
      calls.push(options.method);
      return new Response(JSON.stringify({code: 9000, msg: "temporary failure"}), {
        status: 503, headers: {"content-type": "application/json"}
      });
    }
  });
  const result = await client.submitLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "65000",
    clientOrderId: "paper-lookup-503",
    riskPlan: {
      approved: true, quantity: 0.001, notional: 65,
      assumptions: {leverage: false, shorting: false}
    }
  });
  assert.equal(result.status, "pre_submit_lookup_failed_halt");
  assert.deepEqual(calls, ["GET"]);
});

test("halts before POST when a successful order lookup response has no order identity", async () => {
  const calls = [];
  const client = createTabdealSpotExecutionClient({
    ...credentials,
    liveTradingEnabled: true,
    killSwitch: false,
    explicitOwnerApproval: true,
    maxOrderNotionalQuote: 100,
    portfolioRiskChecksPassed: true,
    fetchImpl: async (_url, options) => {
      calls.push(options.method);
      return new Response(JSON.stringify({status: "ok"}), {
        status: 200, headers: {"content-type": "application/json"}
      });
    }
  });
  const result = await client.submitLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "65000",
    clientOrderId: "paper-lookup-malformed",
    riskPlan: {
      approved: true, quantity: 0.001, notional: 65,
      assumptions: {leverage: false, shorting: false}
    }
  });
  assert.equal(result.status, "pre_submit_lookup_failed_halt");
  assert.deepEqual(calls, ["GET"]);
});

test("rejects actual order notional above the cap even if supplied risk metadata understates it", async () => {
  let calls = 0;
  const client = createTabdealSpotExecutionClient({
    ...credentials,
    liveTradingEnabled: true,
    killSwitch: false,
    explicitOwnerApproval: true,
    maxOrderNotionalQuote: 100,
    portfolioRiskChecksPassed: true,
    fetchImpl: async () => { calls++; throw new Error("must not be called"); }
  });
  await assert.rejects(client.submitLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.002", price: "65000",
    clientOrderId: "paper-actual-over-cap",
    riskPlan: {
      approved: true, quantity: 0.002, notional: 100,
      assumptions: {leverage: false, shorting: false}
    }
  }), /order_notional_exceeds_approved_risk_plan/);
  assert.equal(calls, 0);
});

test("emergency cancellation remains available when the kill switch is active", async () => {
  const calls = [];
  const client = createTabdealSpotExecutionClient({
    ...credentials,
    liveTradingEnabled: false,
    killSwitch: true,
    explicitOwnerApproval: true,
    fetchImpl: async (_url, options) => {
      calls.push(options.method);
      return new Response(JSON.stringify({
        orderId: 88, clientOrderId: "paper-cancel-1", symbol: "BTCUSDT",
        side: "BUY", type: "LIMIT", status: "CANCELED", origQty: "0.001",
        executedQty: "0", price: "65000", updateTime: 1_800_000_000_003
      }), {status: 200, headers: {"content-type": "application/json"}});
    }
  });
  const result = await client.cancelOrder({symbol: "BTCUSDT", orderId: 88});
  assert.equal(result.status, "cancel_response_received");
  assert.deepEqual(calls, ["DELETE"]);
});

test("emergency cancellation still requires explicit owner approval", async () => {
  let calls = 0;
  const client = createTabdealSpotExecutionClient({
    ...credentials,
    fetchImpl: async () => { calls++; throw new Error("must not be called"); }
  });
  await assert.rejects(client.cancelOrder({symbol: "BTCUSDT", orderId: 88}),
    /cancel_owner_approval_required/);
  assert.equal(calls, 0);
});


test("builds a signed SELL OCO protective exit matching Tabdeal's documented fields", async () => {
  const request = await buildTabdealOcoSellOrderRequest({
    ...credentials, ...deterministic, symbol: "BTCUSDT",
    quantity: "0.001", price: "68000", stopPrice: "63000", stopLimitPrice: "62900",
    listClientOrderId: "oco-list-1", limitClientOrderId: "oco-limit-1", stopClientOrderId: "oco-stop-1"
  });
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api1.tabdeal.org/api/v1/order/oco");
  const params = new URLSearchParams(request.body);
  const signature = params.get("signature");
  params.delete("signature");
  assert.equal(signature, createHmac("sha256", "test-secret").update(params.toString()).digest("hex"));
  assert.equal(params.get("side"), "SELL");
  assert.equal(params.get("symbol"), "BTCUSDT");
  assert.equal(params.get("quantity"), "0.001");
  assert.equal(params.get("price"), "68000");
  assert.equal(params.get("stopPrice"), "63000");
  assert.equal(params.get("stopLimitPrice"), "62900");
  assert.equal(params.get("listClientOrderId"), "oco-list-1");
  assert.equal(params.get("limitClientOrderId"), "oco-limit-1");
  assert.equal(params.get("stopClientOrderId"), "oco-stop-1");
});

test("builds OCO lookup and cancellation on the documented signed endpoints", async () => {
  const lookup = await buildTabdealGetOcoOrderRequest({
    ...credentials, ...deterministic, listClientOrderId: "oco-list-1"
  });
  assert.equal(lookup.method, "GET");
  assert.ok(lookup.url.startsWith("https://api1.tabdeal.org/r/api/v1/orderList?"));
  assert.equal(new URL(lookup.url).searchParams.get("origClientOrderId"), "oco-list-1");
  const cancel = await buildTabdealCancelOcoOrderRequest({
    ...credentials, ...deterministic, symbol: "BTCUSDT", orderListId: 321
  });
  assert.equal(cancel.method, "DELETE");
  assert.ok(cancel.url.startsWith("https://api1.tabdeal.org/api/v1/orderList?"));
  assert.equal(new URL(cancel.url).searchParams.get("orderListId"), "321");
});

test("rejects unsafe OCO price relationships, duplicate IDs and ambiguous lookups", async () => {
  const base = {
    ...credentials, ...deterministic, symbol: "BTCUSDT", quantity: "0.001",
    price: "68000", stopPrice: "63000", stopLimitPrice: "62900",
    listClientOrderId: "oco-list-1", limitClientOrderId: "oco-limit-1", stopClientOrderId: "oco-stop-1"
  };
  await assert.rejects(buildTabdealOcoSellOrderRequest({...base, stopPrice: "69000"}), /price_relationship_invalid/);
  await assert.rejects(buildTabdealOcoSellOrderRequest({...base, stopClientOrderId: "oco-limit-1"}), /client_order_ids_must_be_unique/);
  await assert.rejects(buildTabdealGetOcoOrderRequest({...credentials, ...deterministic}), /exactly_one_id_required/);
  await assert.rejects(buildTabdealCancelOcoOrderRequest({
    ...credentials, ...deterministic, symbol: "BTCUSDT", orderListId: 1, listClientOrderId: "oco-list-1"
  }), /exactly_one_id_required/);
});

test("OCO submission stays closed by default and makes no network request", async () => {
  let calls = 0;
  const client = createTabdealSpotExecutionClient({
    ...credentials, fetchImpl: async () => { calls++; throw new Error("must not be called"); }
  });
  await assert.rejects(client.submitOcoExit({
    symbol: "BTCUSDT", quantity: "0.001", price: "68000", stopPrice: "63000",
    stopLimitPrice: "62900", listClientOrderId: "oco-list-1",
    limitClientOrderId: "oco-limit-1", stopClientOrderId: "oco-stop-1",
    riskPlan: {approved: true, quantity: 0.001, notional: 68, assumptions: {leverage: false, shorting: false}}
  }), /live_execution_gate_closed/);
  assert.equal(calls, 0);
});

test("OCO submission reconciles before posting and never repeats an uncertain POST", async () => {
  const calls = [];
  const client = createTabdealSpotExecutionClient({
    ...credentials, liveTradingEnabled: true, killSwitch: false, explicitOwnerApproval: true,
    maxOrderNotionalQuote: 100, portfolioRiskChecksPassed: true,
    fetchImpl: async (url, options) => {
      calls.push({url: String(url), method: options.method});
      if (options.method === "GET") return new Response(JSON.stringify({code: -2013, msg: "not found"}), {status: 404});
      if (options.method === "POST") throw new Error("simulated timeout");
      throw new Error("unexpected_method");
    }
  });
  const result = await client.submitOcoExit({
    symbol: "BTCUSDT", quantity: "0.001", price: "68000", stopPrice: "63000",
    stopLimitPrice: "62900", listClientOrderId: "oco-list-2",
    limitClientOrderId: "oco-limit-2", stopClientOrderId: "oco-stop-2",
    riskPlan: {approved: true, quantity: 0.001, notional: 68, assumptions: {leverage: false, shorting: false}}
  });
  assert.equal(result.status, "unknown_oco_submission_state_halt");
  assert.deepEqual(calls.map(call => call.method), ["GET", "POST", "GET"]);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

test("OCO cancellation requires owner approval but remains available with kill switch active", async () => {
  let calls = 0;
  const guarded = createTabdealSpotExecutionClient({
    ...credentials, fetchImpl: async () => { calls++; throw new Error("must not be called"); }
  });
  await assert.rejects(guarded.cancelOcoOrder({
    symbol: "BTCUSDT", orderListId: 7
  }), /cancel_owner_approval_required/);
  const approved = createTabdealSpotExecutionClient({
    ...credentials, explicitOwnerApproval: true, liveTradingEnabled: false, killSwitch: true,
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.method, "DELETE");
      return new Response(JSON.stringify({
        orderListId: 7, listOrderStatus: "ALL_DONE", listStatusType: "ALL_DONE",
        orders: [
          {orderId: 11, clientOrderId: "oco-limit", symbol: "BTCUSDT"},
          {orderId: 12, clientOrderId: "oco-stop", symbol: "BTCUSDT"}
        ]
      }), {status: 200, headers: {"content-type": "application/json"}});
    }
  });
  const result = await approved.cancelOcoOrder({symbol: "BTCUSDT", orderListId: 7});
  assert.equal(result.status, "oco_cancel_response_received");
  assert.equal(result.order.listOrderStatus, "ALL_DONE");
  assert.equal(calls, 1);
});
