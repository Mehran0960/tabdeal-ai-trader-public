#!/usr/bin/env node
import {createHmac} from "node:crypto";
import {appendFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";

const API_BASE = "https://api1.tabdeal.org";
const SYMBOL = "BTCUSDT";
const CLIENT_ORDER_ID = "t1shot-btcusdt-20261127";
const EXPECTED_ORDER_ID = "118071583933";
const RECV_WINDOW_MS = 5_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function signParams(params, secret) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.append(key, String(value));
  }
  const unsigned = query.toString();
  const signature = createHmac("sha256", secret).update(unsigned, "utf8").digest("hex");
  query.append("signature", signature);
  return query;
}
async function readJson(response) {
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("tabdeal_response_too_large");
  try { return JSON.parse(text); } catch { throw new Error("tabdeal_response_not_json"); }
}
async function signedGet(path, params, apiKey, apiSecret, fetchImpl) {
  const query = signParams({...params, timestamp: Date.now(), recvWindow: RECV_WINDOW_MS}, apiSecret);
  const response = await fetchImpl(API_BASE + "/r/api/v1" + path + "?" + query.toString(), {
    method: "GET",
    headers: {accept: "application/json", "X-MBX-APIKEY": apiKey},
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(path.replace(/[^A-Za-z]/g, "") + "_http_" + response.status +
    (typeof data?.code === "number" ? "_code_" + data.code : ""));
  return data;
}
function cleanTrade(row) {
  if (!isRecord(row)) return null;
  const price = row.price === undefined ? null : String(row.price);
  const qty = row.qty === undefined ? (row.quantity === undefined ? null : String(row.quantity)) : String(row.qty);
  const quote = row.quoteQty === undefined && row.quoteQuantity === undefined
    ? (price && qty ? String(Number(price) * Number(qty)) : null)
    : String(row.quoteQty ?? row.quoteQuantity);
  return {
    tradeId: row.id === undefined ? null : String(row.id),
    orderId: row.orderId === undefined ? null : String(row.orderId),
    price,
    quantity: qty,
    quoteQuantity: quote,
    commission: row.commission === undefined ? null : String(row.commission),
    commissionAsset: row.commissionAsset ?? null,
    time: row.time ?? null,
    isBuyer: row.isBuyer ?? null,
    isBuyerMaker: row.isBuyerMaker ?? null
  };
}
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.trades)) return data.trades;
  if (isRecord(data) && Array.isArray(data.data)) return data.data;
  return null;
}
function compactNumber(value) {
  return Number(value).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}
function aggregate(trades, executedQty, quoteQty) {
  const feeByAsset = new Map();
  let qtyFromTrades = 0;
  let quoteFromTrades = 0;
  for (const trade of trades) {
    if (trade.quantity !== null) qtyFromTrades += Number(trade.quantity);
    if (trade.quoteQuantity !== null) quoteFromTrades += Number(trade.quoteQuantity);
    if (trade.commissionAsset && trade.commission !== null) {
      feeByAsset.set(trade.commissionAsset,
        (feeByAsset.get(trade.commissionAsset) || 0) + Number(trade.commission));
    }
  }
  const fees = [...feeByAsset.entries()].map(([asset, amount]) => ({
    asset,
    amount: compactNumber(amount)
  }));
  const btcFee = feeByAsset.get("BTC") || 0;
  const usdtFee = feeByAsset.get("USDT") || 0;
  return {
    tradeCount: trades.length,
    tradeQuantitySum: compactNumber(qtyFromTrades),
    tradeQuoteQuantitySum: compactNumber(quoteFromTrades),
    feeTotals: fees,
    grossExecutedBTC: executedQty,
    netAcquiredBTCIfBtcFee: compactNumber(Number(executedQty) - btcFee),
    grossQuoteDebitUSDT: quoteQty,
    quoteFeeUSDT: compactNumber(usdtFee),
    totalQuoteDebitIfUsdtFee: compactNumber(Number(quoteQty) + usdtFee)
  };
}
export async function auditTabdealOneShotFill({
  apiKey = process.env.TABDEAL_API_KEY,
  apiSecret = process.env.TABDEAL_API_SECRET,
  fetchImpl = fetch
} = {}) {
  const checkedAt = new Date().toISOString();
  if (typeof apiKey !== "string" || !apiKey.trim() ||
      typeof apiSecret !== "string" || !apiSecret.trim()) {
    return {checkedAt, result: "audit_credentials_missing", readOnly: true};
  }
  try {
    const orderData = await signedGet("/order", {
      symbol: SYMBOL,
      origClientOrderId: CLIENT_ORDER_ID
    }, apiKey, apiSecret, fetchImpl);
    if (!isRecord(orderData) ||
        String(orderData.orderId ?? "") !== EXPECTED_ORDER_ID ||
        orderData.symbol !== SYMBOL ||
        orderData.clientOrderId !== CLIENT_ORDER_ID) {
      throw new Error("order_identity_mismatch");
    }
    const tradesData = await signedGet("/myTrades", {
      symbol: SYMBOL,
      orderId: EXPECTED_ORDER_ID,
      limit: 100
    }, apiKey, apiSecret, fetchImpl);
    const rawTrades = asArray(tradesData);
    if (!rawTrades) throw new Error("my_trades_response_schema_invalid");
    const trades = rawTrades.map(cleanTrade).filter(Boolean);
    const executedQty = String(orderData.executedQty ?? "0");
    const quoteQty = String(orderData.cummulativeQuoteQty ?? orderData.cumulativeQuoteQty ?? "0");
    const status = String(orderData.status ?? "UNKNOWN").toUpperCase();
    return {
      checkedAt,
      result: status === "FILLED" ? "fill_audit_complete" : "order_not_filled",
      readOnly: true,
      order: {
        orderId: EXPECTED_ORDER_ID,
        clientOrderId: CLIENT_ORDER_ID,
        symbol: SYMBOL,
        side: orderData.side ?? "BUY",
        type: orderData.type ?? "LIMIT",
        status,
        originalQuantity: orderData.origQty ?? null,
        executedQuantity: executedQty,
        cumulativeQuoteQuantity: quoteQty,
        averageExecutionPrice: Number(executedQty) > 0
          ? compactNumber(Number(quoteQty) / Number(executedQty)) : null,
        updateTime: orderData.updateTime ?? null
      },
      trades,
      accounting: aggregate(trades, executedQty, quoteQty),
      exchangeWritesSent: 0,
      newOrdersSent: 0,
      cancellationsSent: 0,
      withdrawalsOrTransfersSent: 0
    };
  } catch (error) {
    return {
      checkedAt,
      result: "fill_audit_read_error",
      readOnly: true,
      reason: String(error?.message || error).replace(/[\r\n\t]+/g, " ").slice(0, 180),
      exchangeWritesSent: 0
    };
  }
}
async function main() {
  const report = await auditTabdealOneShotFill();
  console.log("TABDEAL_ONE_SHOT_FILL_AUDIT");
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "## Tabdeal one-shot fill accounting audit\n\n" +
      "- Result: **" + report.result + "**\n" +
      "- Order ID: " + (report.order?.orderId ?? EXPECTED_ORDER_ID) + "\n" +
      "- Status: " + (report.order?.status ?? "unknown") + "\n" +
      "- Executed BTC: " + (report.order?.executedQuantity ?? "unknown") + "\n" +
      "- Quote debit: " + (report.order?.cumulativeQuoteQuantity ?? "unknown") + " USDT\n" +
      "- Average fill price: " + (report.order?.averageExecutionPrice ?? "unknown") + " USDT/BTC\n" +
      "- Fees: " + JSON.stringify(report.accounting?.feeTotals ?? []) + "\n" +
      "- Net acquired BTC (if fee deducted in BTC): " + (report.accounting?.netAcquiredBTCIfBtcFee ?? "unknown") + "\n" +
      "- Read-only; no order writes, cancels, transfers or withdrawals\n"
    );
  }
  if (report.result !== "fill_audit_complete") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error("TABDEAL_ONE_SHOT_FILL_AUDIT_FATAL: " + String(error?.message || error).slice(0, 160));
    process.exitCode = 1;
  });
}
