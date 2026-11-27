import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {auditTabdealOneShotFill} from "../scripts/tabdeal-one-shot-fill-audit.mjs";

const apiKey = "audit-test-key";
const apiSecret = "audit-test-secret";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"content-type": "application/json"}
  });
}
function makeFetch({order = {
  orderId: 118071583933,
  clientOrderId: "t1shot-btcusdt-20261127",
  symbol: "BTCUSDT",
  side: "BUY",
  type: "LIMIT",
  status: "FILLED",
  origQty: "0.00001700",
  executedQty: "0.00001700",
  cummulativeQuoteQty: "1.00887792",
  updateTime: 1795791184720
}, trades = [{
  id: 999,
  orderId: 118071583933,
  price: "59345.76",
  qty: "0.00001700",
  quoteQty: "1.00887792",
  commission: "0.00000006",
  commissionAsset: "BTC",
  time: 1795791184720,
  isBuyer: true,
  isBuyerMaker: false
}]} = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || "GET").toUpperCase();
    calls.push({url, method, init});
    assert.equal(method, "GET", "audit must never send exchange writes");
    assert.equal(url.hostname, "api1.tabdeal.org");
    const signature = url.searchParams.get("signature");
    url.searchParams.delete("signature");
    const expected = createHmac("sha256", apiSecret).update(url.searchParams.toString(), "utf8").digest("hex");
    assert.equal(signature, expected);
    if (url.pathname.endsWith("/order")) {
      assert.equal(url.searchParams.get("origClientOrderId"), "t1shot-btcusdt-20261127");
      return jsonResponse(order);
    }
    if (url.pathname.endsWith("/myTrades")) {
      assert.equal(url.searchParams.get("orderId"), "118071583933");
      assert.equal(url.searchParams.get("symbol"), "BTCUSDT");
      return jsonResponse(trades);
    }
    throw new Error("unexpected audit endpoint " + url.pathname);
  };
  return {fetchImpl, calls};
}
test("reads FILLED order and trade commission without any exchange writes", async () => {
  const {fetchImpl, calls} = makeFetch();
  const report = await auditTabdealOneShotFill({apiKey, apiSecret, fetchImpl});
  assert.equal(report.result, "fill_audit_complete");
  assert.equal(report.order.status, "FILLED");
  assert.equal(report.order.executedQuantity, "0.00001700");
  assert.equal(report.order.cumulativeQuoteQuantity, "1.00887792");
  assert.equal(report.accounting.feeTotals[0].asset, "BTC");
  assert.equal(report.accounting.feeTotals[0].amount, "0.00000006");
  assert.equal(report.accounting.netAcquiredBTCIfBtcFee, "0.00001694");
  assert.equal(report.accounting.totalQuoteDebitIfUsdtFee, "1.00887792");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.method === "GET"));
});
test("accounts for commission paid in USDT", async () => {
  const {fetchImpl} = makeFetch({
    trades: [{
      id: 1000,
      orderId: 118071583933,
      price: "59345.76",
      qty: "0.00001700",
      quoteQty: "1.00887792",
      commission: "0.00403551",
      commissionAsset: "USDT"
    }]
  });
  const report = await auditTabdealOneShotFill({apiKey, apiSecret, fetchImpl});
  assert.equal(report.accounting.quoteFeeUSDT, "0.00403551");
  assert.equal(report.accounting.totalQuoteDebitIfUsdtFee, "1.01291343");
  assert.equal(report.accounting.netAcquiredBTCIfBtcFee, "0.000017");
});
test("does not accept an unrelated order identifier", async () => {
  const {fetchImpl} = makeFetch({order: {
    orderId: 99,
    clientOrderId: "different",
    symbol: "BTCUSDT",
    status: "FILLED"
  }});
  const report = await auditTabdealOneShotFill({apiKey, apiSecret, fetchImpl});
  assert.equal(report.result, "fill_audit_read_error");
  assert.equal(report.reason, "order_identity_mismatch");
});
