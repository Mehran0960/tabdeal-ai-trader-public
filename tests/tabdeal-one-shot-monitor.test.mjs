import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {runTabdealOneShotMonitor} from "../scripts/tabdeal-one-shot-monitor.mjs";

const apiKey = "monitor-test-key";
const apiSecret = "monitor-test-secret";
const token = "github-test-token";
const repository = "owner/repo";
const commitSha = "a".repeat(40);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"content-type": "application/json"}
  });
}
function makeFetch({orderLock = true, monitorDone = false, order = {
  orderId: 123,
  clientOrderId: "t1shot-btcusdt-20261127",
  symbol: "BTCUSDT",
  side: "BUY",
  type: "LIMIT",
  status: "NEW",
  origQty: "0.00001106",
  executedQty: "0",
  cummulativeQuoteQty: "0",
  isWorking: true
}, orderMissing = false} = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || "GET").toUpperCase();
    calls.push({url, method, init});
    if (url.hostname === "api.github.com") {
      if (url.pathname.endsWith("/git/ref/tags/tabdeal-one-shot-monitor-complete-20261127")) {
        return monitorDone ? jsonResponse({ref: "refs/tags/tabdeal-one-shot-monitor-complete-20261127"}) :
          new Response("Not Found", {status: 404});
      }
      if (url.pathname.endsWith("/git/ref/tags/tabdeal-one-shot-1usdt-20261127")) {
        return orderLock ? jsonResponse({ref: "refs/tags/tabdeal-one-shot-1usdt-20261127"}) :
          new Response("Not Found", {status: 404});
      }
      if (url.pathname.endsWith("/git/refs") && method === "POST") {
        return new Response(JSON.stringify({ref: "refs/tags/tabdeal-one-shot-monitor-complete-20261127"}), {status: 201});
      }
      throw new Error("unexpected GitHub request " + method + " " + url.pathname);
    }
    if (url.hostname === "api1.tabdeal.org") {
      assert.equal(method, "GET", "monitor must never send an exchange write request");
      assert.equal(url.pathname, "/r/api/v1/order");
      const signature = url.searchParams.get("signature");
      url.searchParams.delete("signature");
      const expected = createHmac("sha256", apiSecret).update(url.searchParams.toString(), "utf8").digest("hex");
      assert.equal(signature, expected);
      assert.equal(url.searchParams.get("symbol"), "BTCUSDT");
      assert.equal(url.searchParams.get("origClientOrderId"), "t1shot-btcusdt-20261127");
      return orderMissing
        ? jsonResponse({code: 1204, msg: "Order not found"}, 404)
        : jsonResponse(order);
    }
    throw new Error("unexpected host " + url.hostname);
  };
  return {fetchImpl, calls};
}
function options(fetchImpl) {
  return {apiKey, apiSecret, token, repository, commitSha, fetchImpl};
}

test("does not query the exchange before the one-shot order lock exists", async () => {
  const {fetchImpl, calls} = makeFetch({orderLock: false});
  const result = await runTabdealOneShotMonitor(options(fetchImpl));
  assert.equal(result.result, "one_shot_not_started");
  assert.equal(calls.some(call => call.url.hostname === "api1.tabdeal.org"), false);
});

test("polls an open order with signed GET only and keeps monitoring", async () => {
  const {fetchImpl, calls} = makeFetch();
  const result = await runTabdealOneShotMonitor(options(fetchImpl));
  assert.equal(result.result, "order_still_open_monitoring");
  assert.equal(result.complete, false);
  assert.equal(result.order.status, "NEW");
  assert.equal(calls.filter(call => call.url.hostname === "api1.tabdeal.org").length, 1);
  assert.equal(calls.some(call => call.method === "POST" && call.url.hostname === "api1.tabdeal.org"), false);
  assert.equal(calls.some(call => call.url.hostname === "api.github.com" && call.method === "POST"), false);
});

test("marks monitoring complete when the order reaches FILLED", async () => {
  const {fetchImpl, calls} = makeFetch({
    order: {
      orderId: 123,
      clientOrderId: "t1shot-btcusdt-20261127",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "FILLED",
      origQty: "0.00001106",
      executedQty: "0.00001106",
      cummulativeQuoteQty: "0.99589770",
      isWorking: false
    }
  });
  const result = await runTabdealOneShotMonitor(options(fetchImpl));
  assert.equal(result.result, "order_terminal_monitor_complete");
  assert.equal(result.complete, true);
  assert.equal(calls.filter(call => call.method === "POST" && call.url.hostname === "api.github.com").length, 1);
  assert.equal(calls.some(call => call.url.hostname === "api1.tabdeal.org" && call.method !== "GET"), false);
});

test("marks monitoring complete when documented order-not-found is returned", async () => {
  const {fetchImpl, calls} = makeFetch({orderMissing: true});
  const result = await runTabdealOneShotMonitor(options(fetchImpl));
  assert.equal(result.result, "order_not_found_monitor_complete");
  assert.equal(result.complete, true);
  assert.equal(calls.filter(call => call.method === "POST" && call.url.hostname === "api.github.com").length, 1);
});

test("does nothing after the monitor completion tag exists", async () => {
  const {fetchImpl, calls} = makeFetch({monitorDone: true});
  const result = await runTabdealOneShotMonitor(options(fetchImpl));
  assert.equal(result.result, "monitor_already_complete");
  assert.equal(result.complete, true);
  assert.equal(calls.some(call => call.url.hostname === "api1.tabdeal.org"), false);
});
