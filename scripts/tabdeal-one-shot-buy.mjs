#!/usr/bin/env node
import {createHmac} from "node:crypto";
import {appendFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";

const API_BASE = "https://api1.tabdeal.org";
export const ONE_SHOT_SYMBOL = "BTCUSDT";
export const ONE_SHOT_QUOTE_ASSET = "USDT";
export const ONE_SHOT_QUOTE_AMOUNT = "1.00000000";
export const ONE_SHOT_CLIENT_ID_PREFIX = "t1shot-";
export const ONE_SHOT_CLIENT_ORDER_ID = "t1shot-btcusdt-20261127";
export const ONE_SHOT_LOCK_REF = "refs/tags/tabdeal-one-shot-1usdt-20261127";
const MAX_SPREAD_BPS = 30;
const MAX_BOOK_SLIPPAGE_BPS = 5;
const RECV_WINDOW_MS = 5_000;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function apiCode(data) {
  return isRecord(data) && (typeof data.code === "number" || typeof data.code === "string")
    ? data.code : null;
}
function clientOrderId() {
  return ONE_SHOT_CLIENT_ORDER_ID;
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
async function responseJson(response) {
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("tabdeal_response_too_large");
  try { return JSON.parse(text); } catch { throw new Error("tabdeal_response_not_json"); }
}
function findSymbolInfo(payload) {
  const rows = Array.isArray(payload) ? payload
    : isRecord(payload) && Array.isArray(payload.symbols) ? payload.symbols
    : isRecord(payload) && isRecord(payload.symbol) ? [payload.symbol]
    : null;
  if (!rows) throw new Error("exchange_info_schema_invalid");
  return rows.find(row => isRecord(row) && row.symbol === ONE_SHOT_SYMBOL) ?? null;
}
function filterOf(info, type) {
  return Array.isArray(info?.filters)
    ? info.filters.find(filter => isRecord(filter) && filter.filterType === type) ?? null
    : null;
}
function levelsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.map(level => {
    if (!Array.isArray(level) || level.length < 2) return null;
    const price = positive(level[0]);
    const quantity = positive(level[1]);
    return price && quantity ? {price, quantity} : null;
  }).filter(Boolean);
}
function normalizeOpenOrders(payload) {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.orders)) return payload.orders;
  throw new Error("open_orders_schema_invalid");
}
function getBalances(account) {
  if (!Array.isArray(account?.balances)) throw new Error("account_balances_missing");
  return account.balances;
}
function precisionOf(value) {
  const text = String(value ?? "");
  const point = text.indexOf(".");
  return point < 0 ? 0 : text.length - point - 1;
}
function decimalUnits(value, precision) {
  const [whole, fraction = ""] = String(value).split(".");
  if (fraction.length > precision && /[1-9]/.test(fraction.slice(precision))) {
    throw new Error("decimal_precision_exceeds_filter");
  }
  return BigInt(whole) * (10n ** BigInt(precision)) +
    BigInt((fraction.slice(0, precision) + "0".repeat(precision)).slice(0, precision) || "0");
}
function unitsDecimal(value, precision) {
  const base = 10n ** BigInt(precision);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(precision, "0");
  return precision ? whole.toString() + "." + fraction : whole.toString();
}
function limitBuyForOneUsdt({symbolInfo, asks, bestAskText, quoteBudget}) {
  if (!Array.isArray(symbolInfo.orderTypes) || !symbolInfo.orderTypes.includes("LIMIT")) {
    throw new Error("limit_order_type_not_allowed");
  }
  const lot = filterOf(symbolInfo, "LOT_SIZE");
  const minQty = positive(lot?.minQty);
  const maxQty = positive(lot?.maxQty);
  const stepSize = positive(lot?.stepSize);
  const priceFilter = filterOf(symbolInfo, "PRICE_FILTER");
  const tickSize = positive(priceFilter?.tickSize);
  const minPrice = positive(priceFilter?.minPrice);
  const maxPrice = positive(priceFilter?.maxPrice);
  if (!minQty || !stepSize || !tickSize) throw new Error("limit_lot_or_price_filter_missing");

  const pricePrecision = Math.max(precisionOf(bestAskText), precisionOf(priceFilter.tickSize));
  const quantityPrecision = Math.max(
    precisionOf(lot.stepSize),
    precisionOf(lot.minQty),
    precisionOf(lot.maxQty ?? lot.stepSize)
  );
  if (pricePrecision > 12 || quantityPrecision > 12) throw new Error("filter_precision_unsupported");

  const bestAskUnits = decimalUnits(bestAskText, pricePrecision);
  const tickUnits = decimalUnits(priceFilter.tickSize, pricePrecision);
  const maxPriceUnits = (bestAskUnits * BigInt(10_000 + MAX_BOOK_SLIPPAGE_BPS)) / 10_000n;
  const limitPriceUnits = (maxPriceUnits / tickUnits) * tickUnits;
  if (limitPriceUnits < bestAskUnits) throw new Error("no_valid_limit_tick_within_slippage_cap");
  const limitPrice = unitsDecimal(limitPriceUnits, pricePrecision);
  const limitPriceNumber = Number(limitPrice);
  if ((minPrice !== null && limitPriceNumber < minPrice) ||
      (maxPrice !== null && limitPriceNumber > maxPrice)) {
    throw new Error("limit_price_outside_price_filter");
  }

  const stepUnits = decimalUnits(lot.stepSize, quantityPrecision);
  const capUnits = decimalUnits(quoteBudget, 8);
  const scale = 10n ** BigInt(pricePrecision + quantityPrecision);
  const quoteScale = 10n ** 8n;
  const maxQuantityUnits = (capUnits * scale) / (quoteScale * limitPriceUnits);
  const quantityUnits = (maxQuantityUnits / stepUnits) * stepUnits;
  const minimumQuantityUnits = decimalUnits(lot.minQty, quantityPrecision);
  if (quantityUnits < minimumQuantityUnits ||
      (maxQty !== null && Number(unitsDecimal(quantityUnits, quantityPrecision)) > maxQty)) {
    throw new Error("one_usdt_limit_quantity_outside_lot_filter");
  }
  const quantity = unitsDecimal(quantityUnits, quantityPrecision);
  const notional = limitPriceNumber * Number(quantity);
  if (!Number.isFinite(notional) || notional <= 0 ||
      notional > Number(quoteBudget) + 1e-12) {
    throw new Error("limit_notional_exceeds_one_usdt");
  }

  const minNotionalFilter = filterOf(symbolInfo, "MIN_NOTIONAL");
  const minNotional = positive(minNotionalFilter?.minNotional);
  if (!minNotional || notional + 1e-10 < minNotional ||
      minNotional > Number(quoteBudget)) {
    throw new Error("limit_notional_below_venue_minimum");
  }

  const visibleAskQuantity = asks
    .filter(level => level.price <= limitPriceNumber)
    .reduce((sum, level) => sum + level.quantity, 0);
  if (!Number.isFinite(visibleAskQuantity) ||
      visibleAskQuantity + 1e-15 < Number(quantity)) {
    throw new Error("visible_ask_quantity_below_limit_order_size");
  }

  return {
    type: "LIMIT",
    quantity,
    price: limitPrice,
    maxQuoteNotional: Number(quoteBudget),
    maxTotalDebitQuote: Number(ONE_SHOT_QUOTE_AMOUNT),
    quoteBudget,
    estimatedQuoteNotional: notional,
    minNotional,
    lotStepSize: lot.stepSize,
    lotMinQty: lot.minQty,
    priceTickSize: priceFilter.tickSize,
    timeInForce: "GTC_DEFAULT",
    executionMode: "price_capped_limit"
  };
}
function buildPreflight({symbolInfo, depth, account, openOrders}) {
  if (!isRecord(symbolInfo) || symbolInfo.symbol !== ONE_SHOT_SYMBOL) {
    throw new Error("btc_usdt_symbol_missing");
  }
  if (symbolInfo.status !== "TRADING" || symbolInfo.isSpotTradingAllowed !== true) {
    throw new Error("btc_usdt_spot_not_trading");
  }
  if (symbolInfo.baseAsset !== "BTC" || symbolInfo.quoteAsset !== ONE_SHOT_QUOTE_ASSET) {
    throw new Error("btc_usdt_asset_identity_mismatch");
  }
  if (Array.isArray(symbolInfo.permissions) && !symbolInfo.permissions.includes("SPOT")) {
    throw new Error("spot_permission_missing");
  }

  if (!isRecord(account) || account.accountType !== "SPOT" || account.canTrade !== true) {
    throw new Error("spot_account_trade_permission_not_confirmed");
  }
  if (Array.isArray(account.permissions) && !account.permissions.includes("SPOT")) {
    throw new Error("account_spot_permission_missing");
  }
  const usdt = getBalances(account).find(row => isRecord(row) && row.asset === ONE_SHOT_QUOTE_ASSET);
  const freeUsdt = positive(usdt?.free) ?? 0;
  if (freeUsdt + 1e-12 < Number(ONE_SHOT_QUOTE_AMOUNT)) {
    throw new Error("free_usdt_below_one");
  }
  const makerCommission = Number(account.makerCommission);
  const takerCommission = Number(account.takerCommission);
  if (!Number.isSafeInteger(makerCommission) || makerCommission < 0 ||
      !Number.isSafeInteger(takerCommission) || takerCommission < 0 ||
      makerCommission > 10_000 || takerCommission > 10_000) {
    throw new Error("account_spot_commission_rate_unavailable");
  }
  const commissionBps = Math.max(makerCommission, takerCommission);
  const quoteBudgetUnits = (100_000_000n * 10_000n) / (10_000n + BigInt(commissionBps));
  const quoteBudget = unitsDecimal(quoteBudgetUnits, 8);
  if (!(Number(quoteBudget) > 0)) throw new Error("quote_budget_after_fees_zero");
  if (!Array.isArray(openOrders) || openOrders.length !== 0) {
    throw new Error("existing_btcusdt_open_orders_present");
  }

  const bids = levelsOf(depth?.bids);
  const asks = levelsOf(depth?.asks);
  if (!bids.length || !asks.length) throw new Error("order_book_schema_or_liquidity_invalid");
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  if (bestAsk < bestBid) throw new Error("crossed_order_book");
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
  if (!Number.isFinite(spreadBps) || spreadBps > MAX_SPREAD_BPS) {
    throw new Error("spread_above_limit");
  }

  if (symbolInfo.quoteOrderQtyMarketAllowed === true) {
    if (!Array.isArray(symbolInfo.orderTypes) || !symbolInfo.orderTypes.includes("MARKET")) {
      throw new Error("market_order_type_not_allowed");
    }
    const minNotionalFilter = filterOf(symbolInfo, "MIN_NOTIONAL");
    const minNotional = positive(minNotionalFilter?.minNotional);
    if (!minNotional || minNotional > Number(quoteBudget)) {
      throw new Error("min_notional_exceeds_one_usdt_or_missing");
    }
    const marketLot = filterOf(symbolInfo, "MARKET_LOT_SIZE") ?? filterOf(symbolInfo, "LOT_SIZE");
    const minQty = positive(marketLot?.minQty);
    const maxQty = positive(marketLot?.maxQty);
    if (!minQty) throw new Error("market_lot_size_filter_missing");
    const maxPrice = bestAsk * (1 + MAX_BOOK_SLIPPAGE_BPS / 10_000);
    let remainingQuote = Number(quoteBudget);
    let estimatedBase = 0;
    let estimatedQuote = 0;
    for (const level of asks) {
      if (level.price > maxPrice) break;
      const levelQuote = level.price * level.quantity;
      const usedQuote = Math.min(remainingQuote, levelQuote);
      estimatedBase += usedQuote / level.price;
      estimatedQuote += usedQuote;
      remainingQuote -= usedQuote;
      if (remainingQuote <= 1e-10) break;
    }
    if (remainingQuote > 1e-8 || estimatedBase < minQty ||
        (maxQty !== null && estimatedBase > maxQty)) {
      throw new Error("visible_ask_depth_or_market_quantity_filter_failed");
    }
    return {
      symbol: ONE_SHOT_SYMBOL, side: "BUY", type: "MARKET",
      quoteOrderQty: quoteBudget,
      maxQuoteNotional: Number(quoteBudget),
      maxTotalDebitQuote: Number(ONE_SHOT_QUOTE_AMOUNT),
      quoteBudget, commissionBps,
      estimatedQuoteNotional: Number(quoteBudget),
      freeUsdt, minNotional, bestBid, bestAsk, spreadBps,
      projectedAveragePrice: estimatedQuote / estimatedBase,
      projectedSlippageBps: ((estimatedQuote / estimatedBase) / bestAsk - 1) * 10_000,
      estimatedBaseQuantity: estimatedBase,
      marketOrderAllowed: true,
      quoteOrderQtyMarketAllowed: true,
      openOrdersBefore: openOrders.length
    };
  }

  const limitIntent = limitBuyForOneUsdt({symbolInfo, asks, bestAskText: String(depth.asks[0][0]), quoteBudget});
  return {
    symbol: ONE_SHOT_SYMBOL, side: "BUY", ...limitIntent,
    freeUsdt, commissionBps, bestBid, bestAsk, spreadBps,
    marketOrderAllowed: false,
    quoteOrderQtyMarketAllowed: false,
    openOrdersBefore: openOrders.length
  };
}

async function publicGet(path, fetchImpl) {
  const response = await fetchImpl(API_BASE + "/r/api/v1" + path, {
    method: "GET",
    headers: {accept: "application/json"},
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("public_get_http_" + response.status);
  return responseJson(response);
}
function signedGetUrl(path, params, apiSecret) {
  const query = signParams({...params, timestamp: Date.now(), recvWindow: RECV_WINDOW_MS}, apiSecret);
  return API_BASE + "/r/api/v1" + path + "?" + query.toString();
}
async function signedGet(path, params, apiKey, apiSecret, fetchImpl) {
  const response = await fetchImpl(signedGetUrl(path, params, apiSecret), {
    method: "GET",
    headers: {accept: "application/json", "X-MBX-APIKEY": apiKey},
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  const data = await responseJson(response);
  return {response, data};
}
function normalizedOrder(data, fallbackClientOrderId, fallbackType = "MARKET") {
  if (!isRecord(data) || data.orderId === undefined || data.orderId === null) return null;
  const fills = Array.isArray(data.fills) ? data.fills.map(fill => ({
    price: fill?.price ?? null,
    quantity: fill?.qty ?? null,
    commission: fill?.commission ?? null,
    commissionAsset: fill?.commissionAsset ?? null
  })) : [];
  return {
    orderId: String(data.orderId),
    clientOrderId: data.clientOrderId || fallbackClientOrderId,
    symbol: data.symbol ?? ONE_SHOT_SYMBOL,
    side: data.side ?? "BUY",
    type: data.type ?? fallbackType,
    status: data.status ?? "UNKNOWN",
    originalQuantity: data.origQty ?? null,
    executedQuantity: data.executedQty ?? null,
    cumulativeQuoteQuantity: data.cummulativeQuoteQty ?? data.cumulativeQuoteQty ?? null,
    fills
  };
}
export async function claimOneShotExecutionLock({ token, repository, commitSha, fetchImpl = fetch } = {}) {
  const validRepo = typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository);
  if (typeof token !== "string" || !token.trim() || !validRepo ||
      typeof commitSha !== "string" || !/^[a-f0-9]{40}$/i.test(commitSha) ||
      typeof fetchImpl !== "function") return {claimed: false, result: "one_shot_lock_configuration_missing"};
  const base = "https://api.github.com/repos/" + repository;
  const headers = {accept: "application/vnd.github+json", authorization: "Bearer " + token,
    "X-GitHub-Api-Version": "2022-11-28", "content-type": "application/json"};
  try {
    const existing = await fetchImpl(base + "/git/ref/tags/" + encodeURIComponent(ONE_SHOT_LOCK_REF.slice("refs/tags/".length)),
      {method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(8_000)});
    if (existing.ok) return {claimed: false, result: "one_shot_already_claimed"};
    if (existing.status !== 404) return {claimed: false, result: "one_shot_lock_read_unresolved"};
  } catch { return {claimed: false, result: "one_shot_lock_read_unresolved"}; }
  try {
    const created = await fetchImpl(base + "/git/refs", {method: "POST", headers,
      body: JSON.stringify({ref: ONE_SHOT_LOCK_REF, sha: commitSha}), redirect: "error",
      signal: AbortSignal.timeout(8_000)});
    if (created.status === 201) return {claimed: true, result: "one_shot_lock_claimed"};
    if (created.status === 422) return {claimed: false, result: "one_shot_already_claimed"};
    return {claimed: false, result: "one_shot_lock_create_unresolved"};
  } catch { return {claimed: false, result: "one_shot_lock_create_unresolved"}; }
}

async function lookupByClientId({clientId, apiKey, apiSecret, fetchImpl}) {
  const {response, data} = await signedGet("/order", {
    symbol: ONE_SHOT_SYMBOL,
    origClientOrderId: clientId
  }, apiKey, apiSecret, fetchImpl);
  if (response.status === 404 && isRecord(data) && Number(apiCode(data)) === 1204) return null;
  if (!response.ok) throw new Error("order_lookup_unclassified_http_" + response.status);
  const order = normalizedOrder(data, clientId);
  if (!order) throw new Error("order_lookup_payload_invalid");
  return order;
}
export async function runTabdealOneShotBuy({
  apiKey = process.env.TABDEAL_API_KEY,
  apiSecret = process.env.TABDEAL_API_SECRET,
  confirm = process.env.TABDEAL_ONE_SHOT_CONFIRM === "true",
  runId = process.env.GITHUB_RUN_ID,
  fetchImpl = fetch,
  githubToken = process.env.GITHUB_TOKEN,
  repository = process.env.GITHUB_REPOSITORY,
  commitSha = process.env.GITHUB_SHA,
  claimLock = claimOneShotExecutionLock
} = {}) {
  const base = {
    checkedAt: new Date().toISOString(),
    symbol: ONE_SHOT_SYMBOL,
    quoteAsset: ONE_SHOT_QUOTE_ASSET,
    quoteAmountCap: ONE_SHOT_QUOTE_AMOUNT,
    side: "BUY",
    orderType: "MARKET",
    automaticRetry: false,
    sellOrderSent: false,
    cancellationSent: false,
    withdrawalOrTransferSent: false
  };
  if (confirm !== true) return {...base, result: "explicit_workflow_confirmation_missing", orderSubmitted: false};
  if (typeof apiKey !== "string" || !apiKey.trim() ||
      typeof apiSecret !== "string" || !apiSecret.trim()) {
    return {...base, result: "tabdeal_credentials_missing", orderSubmitted: false};
  }
  if (typeof fetchImpl !== "function") return {...base, result: "fetch_unavailable", orderSubmitted: false};
  let clientId;
  try { clientId = clientOrderId(); }
  catch { return {...base, result: "workflow_run_id_missing", orderSubmitted: false}; }

  let preflight;
  try {
    const [exchangeInfo, depth] = await Promise.all([
      publicGet("/exchangeInfo", fetchImpl),
      publicGet("/depth?symbol=" + ONE_SHOT_SYMBOL + "&limit=20", fetchImpl)
    ]);
    const info = findSymbolInfo(exchangeInfo);
    const accountResult = await signedGet("/account", {}, apiKey, apiSecret, fetchImpl);
    if (!accountResult.response.ok) throw new Error("account_read_http_" + accountResult.response.status);
    const ordersResult = await signedGet("/openOrders", {symbol: ONE_SHOT_SYMBOL}, apiKey, apiSecret, fetchImpl);
    if (!ordersResult.response.ok) throw new Error("open_orders_read_http_" + ordersResult.response.status);
    const openOrders = normalizeOpenOrders(ordersResult.data);
    preflight = buildPreflight({
      symbolInfo: info,
      depth,
      account: accountResult.data,
      openOrders
    });
  } catch (error) {
    return {
      ...base,
      result: "preflight_blocked",
      reason: String(error?.message || error).slice(0, 160),
      orderSubmitted: false
    };
  }

  try {
    const priorOrder = await lookupByClientId({clientId, apiKey, apiSecret, fetchImpl});
    if (priorOrder) {
      return {...base, result: "existing_order_reconciled_no_resubmit", preflight, order: priorOrder, orderSubmitted: false};
    }
  } catch (error) {
    return {...base, result: "pre_submit_order_lookup_failed_halt", reason: String(error?.message || error).slice(0, 160), preflight, orderSubmitted: false};
  }

  const lock = await claimLock({token: githubToken, repository, commitSha, fetchImpl});
  if (!lock?.claimed) return {...base, result: lock?.result || "one_shot_lock_not_claimed", preflight, orderSubmitted: false};

  const params = {
    symbol: ONE_SHOT_SYMBOL,
    side: "BUY",
    type: preflight.type,
    ...(preflight.type === "MARKET"
      ? {quoteOrderQty: preflight.quoteOrderQty}
      : {quantity: preflight.quantity, price: preflight.price, stopPrice: "0"}),
    newClientOrderId: clientId,
    timestamp: Date.now(),
    recvWindow: RECV_WINDOW_MS
  };
  const signedBody = signParams(params, apiSecret).toString();
  let postResponse;
  let postData;
  try {
    postResponse = await fetchImpl(API_BASE + "/api/v1/order", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "X-MBX-APIKEY": apiKey
      },
      body: signedBody,
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    postData = await responseJson(postResponse);
  } catch {
    // POST may have reached the exchange. Reconcile by the unique client ID; never retry POST.
    try {
      const reconciled = await lookupByClientId({clientId, apiKey, apiSecret, fetchImpl});
      if (reconciled) {
        return {...base, result: "reconciled_after_uncertain_post", preflight, order: reconciled, orderSubmitted: true};
      }
    } catch {
      // Keep outcome unknown. A human must reconcile before another buy.
    }
    return {...base, result: "post_outcome_unknown_halt_no_retry", preflight, orderSubmitted: "unknown", clientOrderId: clientId};
  }

  if (!postResponse.ok && postResponse.status >= 500) {
    try {
      const reconciled = await lookupByClientId({clientId, apiKey, apiSecret, fetchImpl});
      if (reconciled) return {...base, result: "reconciled_after_server_error", httpStatus: postResponse.status, preflight, order: reconciled, orderSubmitted: true};
      return {...base, result: "server_error_order_not_found_halt_no_retry", httpStatus: postResponse.status, preflight, orderSubmitted: "unknown", clientOrderId: clientId};
    } catch {
      return {...base, result: "server_error_reconciliation_failed_halt_no_retry", httpStatus: postResponse.status, preflight, orderSubmitted: "unknown", clientOrderId: clientId};
    }
  }
  if (!postResponse.ok) {
    return {
      ...base,
      result: "order_rejected_no_retry",
      httpStatus: postResponse.status,
      apiErrorCode: apiCode(postData),
      apiMessage: typeof postData?.msg === "string" ? postData.msg.slice(0, 160) : null,
      preflight,
      orderSubmitted: false
    };
  }

  let order = normalizedOrder(postData, clientId);
  if (!order) {
    try { order = await lookupByClientId({clientId, apiKey, apiSecret, fetchImpl}); }
    catch {
      return {...base, result: "accepted_response_unreconciled_halt", preflight, orderSubmitted: true, clientOrderId: clientId};
    }
  }
  if (!order) {
    return {...base, result: "accepted_but_order_not_reconciled_halt", preflight, orderSubmitted: true, clientOrderId: clientId};
  }
  return {
    ...base,
    result: String(order.status).toUpperCase() === "FILLED" ? "order_filled_reconciled"
      : String(order.status).toUpperCase() === "PARTIALLY_FILLED" ? "order_partially_filled_open"
      : "order_accepted_open",
    preflight,
    order,
    orderSubmitted: true
  };
}
export function safeOneShotSummary(report) {
  return {
    checkedAt: report.checkedAt,
    symbol: report.symbol,
    quoteAmountCap: report.quoteAmountCap,
    side: report.side,
    orderType: report.preflight?.type ?? report.orderType,
    result: report.result,
    reason: report.reason ?? null,
    httpStatus: report.httpStatus ?? null,
    apiErrorCode: report.apiErrorCode ?? null,
    apiMessage: report.apiMessage ?? null,
    preflight: report.preflight ?? null,
    order: report.order ?? null,
    clientOrderId: report.clientOrderId ?? null,
    orderSubmitted: report.orderSubmitted,
    automaticRetry: false,
    sellOrderSent: false,
    cancellationSent: false,
    withdrawalOrTransferSent: false,
    apiKeyLogged: false,
    apiSecretLogged: false
  };
}
async function main() {
  const report = await runTabdealOneShotBuy();
  const summary = safeOneShotSummary(report);
  console.log("TABDEAL_ONE_SHOT_BUY_RESULT");
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "## Tabdeal one-shot Spot buy\n\n" +
      "- Result: **" + report.result + "**\n" +
      "- Symbol: " + ONE_SHOT_SYMBOL + "\n" +
      "- Quote-amount cap: 1.00000000 USDT\n" +
      "- Order submitted: " + String(report.orderSubmitted) + "\n" +
      "- Automatic retry: no\n" +
      "- Sell, cancel, withdrawal or transfer: not attempted\n" +
      (report.order ? "- Exchange order ID: " + report.order.orderId + "\n" +
        "- Order status: " + report.order.status + "\n" +
        "- Filled base quantity: " + (report.order.executedQuantity ?? "not reported") + "\n" +
        "- Quote quantity: " + (report.order.cumulativeQuoteQuantity ?? "not reported") + "\n" : "") +
      (report.reason ? "- Block reason: " + report.reason + "\n" : "")
    );
  }
  if (!report.orderSubmitted || report.orderSubmitted === "unknown" || !report.order) {
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error("TABDEAL_ONE_SHOT_BUY_FATAL: " + String(error?.message || error).slice(0, 160));
    process.exitCode = 1;
  });
}
