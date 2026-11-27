import {createHmac} from "node:crypto";

export const TABDEAL_SELL_SYMBOL = "BTCUSDT";
export const TABDEAL_SELL_MAX_SPREAD_BPS = 30;
export const TABDEAL_SELL_MAX_SLIPPAGE_BPS = 50;
const API_BASE = "https://api1.tabdeal.org";
const RECV_WINDOW_MS = 5_000;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$/;
const CLIENT_ORDER_ID = /^[A-Za-z0-9._-]{1,36}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(code) {
  throw new Error(code);
}
function asDecimal(value, name, allowZero = false) {
  const text = String(value ?? "");
  if (!DECIMAL.test(text) || !Number.isFinite(Number(text)) ||
      (allowZero ? Number(text) < 0 : Number(text) <= 0)) {
    fail("tabdeal_sell_" + name + "_invalid");
  }
  return text;
}
function precisionOf(value) {
  const text = String(value ?? "");
  const point = text.indexOf(".");
  return point < 0 ? 0 : text.length - point - 1;
}
function decimalUnits(value, precision) {
  const [whole, fraction = ""] = String(value).split(".");
  if (fraction.length > precision && /[1-9]/.test(fraction.slice(precision))) {
    fail("tabdeal_sell_decimal_precision_invalid");
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
function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function filterOf(info, type) {
  return Array.isArray(info?.filters)
    ? info.filters.find(filter => isRecord(filter) && filter.filterType === type) ?? null
    : null;
}
function normalizeLevels(value, direction) {
  if (!Array.isArray(value) || value.length === 0) fail("tabdeal_sell_order_book_missing");
  const levels = value.map(level => {
    if (!Array.isArray(level) || level.length < 2) return null;
    const price = positive(level[0]);
    const quantity = positive(level[1]);
    return price && quantity ? {price, quantity} : null;
  });
  if (levels.some(level => level === null)) fail("tabdeal_sell_order_book_schema_invalid");
  levels.sort((a, b) => direction === "bids" ? b.price - a.price : a.price - b.price);
  return levels;
}
function normalizeOrders(payload) {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.orders)) return payload.orders;
  fail("tabdeal_sell_open_orders_schema_invalid");
}
function freeAndLockedBtc(account) {
  if (!Array.isArray(account?.balances)) fail("tabdeal_sell_account_balances_missing");
  const row = account.balances.find(item => isRecord(item) && item.asset === "BTC");
  if (!row) return {free: "0", locked: "0"};
  return {
    free: asDecimal(row.free ?? "0", "free_btc", true),
    locked: asDecimal(row.locked ?? "0", "locked_btc", true)
  };
}
function floorToStep(balance, step) {
  const precision = Math.max(precisionOf(balance), precisionOf(step));
  const balanceUnits = decimalUnits(balance, precision);
  const stepUnits = decimalUnits(step, precision);
  if (stepUnits <= 0n) fail("tabdeal_sell_lot_step_invalid");
  const quantityUnits = (balanceUnits / stepUnits) * stepUnits;
  return {
    quantity: unitsDecimal(quantityUnits, precision),
    remainder: unitsDecimal(balanceUnits - quantityUnits, precision)
  };
}
function orderNotionalFilters(info) {
  const minimums = [];
  const maximums = [];
  const minNotional = filterOf(info, "MIN_NOTIONAL");
  if (minNotional) {
    if (minNotional.minNotional === undefined) fail("tabdeal_sell_min_notional_filter_invalid");
    minimums.push(asDecimal(minNotional.minNotional, "min_notional"));
  }
  const notional = filterOf(info, "NOTIONAL");
  if (notional) {
    if (notional.minNotional !== undefined) minimums.push(asDecimal(notional.minNotional, "min_notional"));
    if (notional.maxNotional !== undefined) maximums.push(asDecimal(notional.maxNotional, "max_notional"));
  }
  return {minimums, maximums};
}

export function prepareTabdealSellAllBtc({
  symbolInfo, depth, account, openOrders,
  maxSpreadBps = TABDEAL_SELL_MAX_SPREAD_BPS,
  maxSlippageBps = TABDEAL_SELL_MAX_SLIPPAGE_BPS
} = {}) {
  if (account?.canTrade === false) fail("tabdeal_sell_account_trading_disabled");
  if (!isRecord(symbolInfo) || symbolInfo.symbol !== TABDEAL_SELL_SYMBOL) {
    fail("tabdeal_sell_symbol_info_missing");
  }
  if (symbolInfo.status && symbolInfo.status !== "TRADING") fail("tabdeal_sell_symbol_not_trading");
  if (symbolInfo.isSpotTradingAllowed === false) fail("tabdeal_sell_spot_trading_disabled");
  if (!Array.isArray(symbolInfo.orderTypes) || !symbolInfo.orderTypes.includes("LIMIT")) {
    fail("tabdeal_sell_limit_order_not_allowed");
  }
  if (!Number.isSafeInteger(maxSpreadBps) || maxSpreadBps < 0 || maxSpreadBps > 500 ||
      !Number.isSafeInteger(maxSlippageBps) || maxSlippageBps < 1 || maxSlippageBps > 500) {
    fail("tabdeal_sell_execution_limits_invalid");
  }
  const orders = normalizeOrders(openOrders);
  if (orders.length > 0) fail("tabdeal_sell_existing_btcusdt_open_orders_present");

  const balances = freeAndLockedBtc(account);
  if (Number(balances.locked) > 0) fail("tabdeal_sell_btc_balance_locked_by_open_orders");
  if (Number(balances.free) <= 0) fail("tabdeal_sell_no_free_btc_balance");

  const lot = filterOf(symbolInfo, "LOT_SIZE");
  const minQty = positive(lot?.minQty);
  const stepSize = positive(lot?.stepSize);
  const maxQty = lot?.maxQty === undefined ? null : positive(lot.maxQty);
  if (!minQty || !stepSize || (lot.maxQty !== undefined && !maxQty)) {
    fail("tabdeal_sell_lot_size_filter_missing_or_invalid");
  }
  const rounded = floorToStep(balances.free, lot.stepSize);
  const quantity = rounded.quantity;
  if (Number(quantity) <= 0 || Number(quantity) < minQty) {
    fail("tabdeal_sell_free_btc_below_minimum_quantity");
  }
  if (maxQty !== null && Number(quantity) > maxQty) {
    fail("tabdeal_sell_quantity_exceeds_single_order_maximum");
  }

  const priceFilter = filterOf(symbolInfo, "PRICE_FILTER");
  const tickSize = positive(priceFilter?.tickSize);
  if (!tickSize) fail("tabdeal_sell_price_filter_missing_or_invalid");
  const bids = normalizeLevels(depth?.bids, "bids");
  const asks = normalizeLevels(depth?.asks, "asks");
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  if (bestAsk < bestBid) fail("tabdeal_sell_crossed_order_book");
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
  if (!Number.isFinite(spreadBps) || spreadBps > maxSpreadBps) {
    fail("tabdeal_sell_spread_above_limit");
  }

  const pricePrecision = Math.max(
    precisionOf(String(bids[0].price)),
    precisionOf(priceFilter.tickSize),
    precisionOf(priceFilter.minPrice ?? "0"),
    precisionOf(priceFilter.maxPrice ?? "0")
  );
  if (pricePrecision > 24) fail("tabdeal_sell_price_precision_unsupported");
  const bidUnits = decimalUnits(String(bids[0].price), pricePrecision);
  const tickUnits = decimalUnits(priceFilter.tickSize, pricePrecision);
  const floorNumerator = bidUnits * BigInt(10_000 - maxSlippageBps);
  const floorUnitsBeforeTick = floorNumerator / 10_000n;
  const limitPriceUnits = (floorUnitsBeforeTick / tickUnits) * tickUnits;
  if (limitPriceUnits <= 0n) fail("tabdeal_sell_limit_price_invalid");
  const limitPrice = unitsDecimal(limitPriceUnits, pricePrecision);
  if (priceFilter.minPrice && Number(limitPrice) < Number(priceFilter.minPrice)) {
    fail("tabdeal_sell_limit_price_below_exchange_minimum");
  }
  if (priceFilter.maxPrice && Number(limitPrice) > Number(priceFilter.maxPrice)) {
    fail("tabdeal_sell_limit_price_above_exchange_maximum");
  }

  const targetQuantity = Number(quantity);
  let remaining = targetQuantity;
  let estimatedGrossQuote = 0;
  let availableWithinLimit = 0;
  for (const level of bids) {
    if (level.price + 1e-12 < Number(limitPrice)) break;
    availableWithinLimit += level.quantity;
    const used = Math.min(remaining, level.quantity);
    estimatedGrossQuote += used * level.price;
    remaining -= used;
    if (remaining <= Math.max(1e-15, targetQuantity * 1e-12)) {
      remaining = 0;
      break;
    }
  }
  if (remaining > Math.max(1e-15, targetQuantity * 1e-12)) {
    fail("tabdeal_sell_visible_bid_depth_below_full_quantity_within_slippage_cap");
  }
  const estimatedVwap = estimatedGrossQuote / targetQuantity;
  const estimatedSlippageBps = ((bestBid - estimatedVwap) / bestBid) * 10_000;
  if (!Number.isFinite(estimatedSlippageBps) || estimatedSlippageBps > maxSlippageBps + 1e-8) {
    fail("tabdeal_sell_estimated_slippage_above_limit");
  }

  const limitNotional = Number(quantity) * Number(limitPrice);
  const {minimums, maximums} = orderNotionalFilters(symbolInfo);
  if (minimums.some(value => limitNotional + 1e-12 < Number(value))) {
    fail("tabdeal_sell_order_below_minimum_notional");
  }
  if (maximums.some(value => limitNotional - 1e-12 > Number(value))) {
    fail("tabdeal_sell_order_above_maximum_notional");
  }
  const takerCommission = Number(account?.takerCommission);
  const commissionBps = Number.isSafeInteger(takerCommission) && takerCommission >= 0 && takerCommission <= 10_000
    ? takerCommission : null;
  const estimatedFeeQuote = commissionBps === null ? null : estimatedGrossQuote * commissionBps / 10_000;

  return {
    status: "READY",
    symbol: TABDEAL_SELL_SYMBOL,
    side: "SELL",
    orderType: "LIMIT",
    timeInForce: "IOC",
    freeBtc: balances.free,
    lockedBtc: balances.locked,
    sellQuantity: quantity,
    unsellableStepRemainderBtc: rounded.remainder,
    limitPrice,
    bestBid,
    bestAsk,
    spreadBps,
    maxSpreadBps,
    maxSlippageBps,
    estimatedSlippageBps,
    estimatedVwap,
    estimatedGrossQuote,
    takerCommissionBps: commissionBps,
    estimatedFeeQuote,
    estimatedNetQuote: estimatedFeeQuote === null ? null : estimatedGrossQuote - estimatedFeeQuote,
    estimatedQuoteAtLimit: limitNotional,
    visibleBidQuantityWithinLimit: availableWithinLimit,
    openOrdersBefore: orders.length,
    ordersSubmitted: false
  };
}

function signedQuery(params, apiSecret) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.append(key, String(value));
  }
  const unsigned = query.toString();
  const signature = createHmac("sha256", apiSecret).update(unsigned, "utf8").digest("hex");
  query.append("signature", signature);
  return query.toString();
}

function normalizedOrder(data, fallbackClientOrderId) {
  if (!isRecord(data) || data.orderId === undefined || data.orderId === null) return null;
  return {
    orderId: String(data.orderId),
    clientOrderId: data.clientOrderId || fallbackClientOrderId,
    symbol: data.symbol ?? TABDEAL_SELL_SYMBOL,
    side: data.side ?? "SELL",
    type: data.type ?? "LIMIT",
    status: data.status ?? "UNKNOWN",
    originalQuantity: data.origQty === undefined ? null : String(data.origQty),
    executedQuantity: data.executedQty === undefined ? null : String(data.executedQty),
    cumulativeQuoteQuantity: data.cummulativeQuoteQty ?? data.cumulativeQuoteQty ?? null
  };
}

export function buildTabdealLimitIocSellRequest({
  quantity, price, clientOrderId, apiKey, apiSecret,
  timestamp = Date.now(), receiveWindow = RECV_WINDOW_MS
} = {}) {
  const qty = asDecimal(quantity, "order_quantity");
  const limitPrice = asDecimal(price, "order_price");
  const clientId = String(clientOrderId ?? "");
  if (!CLIENT_ORDER_ID.test(clientId)) fail("tabdeal_sell_client_order_id_invalid");
  if (typeof apiKey !== "string" || !apiKey.trim() ||
      typeof apiSecret !== "string" || !apiSecret.trim()) fail("tabdeal_sell_credentials_missing");
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 ||
      !Number.isSafeInteger(receiveWindow) || receiveWindow < 1 || receiveWindow > 10_000) {
    fail("tabdeal_sell_request_timing_invalid");
  }
  const body = signedQuery({
    symbol: TABDEAL_SELL_SYMBOL,
    side: "SELL",
    type: "LIMIT",
    timeInForce: "IOC",
    quantity: qty,
    price: limitPrice,
    newClientOrderId: clientId,
    timestamp,
    recvWindow: receiveWindow
  }, apiSecret);
  return {
    method: "POST",
    url: API_BASE + "/api/v1/order",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "X-MBX-APIKEY": apiKey
    },
    body
  };
}

function signedGetUrl(path, params, apiSecret, timestamp = Date.now()) {
  const query = signedQuery({...params, timestamp, recvWindow: RECV_WINDOW_MS}, apiSecret);
  return API_BASE + "/r/api/v1" + path + "?" + query;
}
async function fetchJson(fetchImpl, url, options = {}, timeoutMs = 10_000) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.text();
  if (body.length > 1_000_000) fail("tabdeal_sell_response_too_large");
  let data;
  try { data = JSON.parse(body); } catch { fail("tabdeal_sell_response_not_json"); }
  return {response, data};
}
async function publicGet(path, fetchImpl) {
  const {response, data} = await fetchJson(fetchImpl, API_BASE + "/r/api/v1" + path, {
    method: "GET", headers: {accept: "application/json"}
  });
  if (!response.ok) fail("tabdeal_sell_public_get_http_" + response.status);
  return data;
}
async function signedGet(path, params, apiKey, apiSecret, fetchImpl) {
  const {response, data} = await fetchJson(fetchImpl,
    signedGetUrl(path, params, apiSecret), {
      method: "GET",
      headers: {accept: "application/json", "X-MBX-APIKEY": apiKey}
    });
  return {response, data};
}
function isOrderNotFound(response, data) {
  return response.status === 404 && isRecord(data) && Number(data.code) === 1204;
}
async function lookupOrder(clientId, apiKey, apiSecret, fetchImpl) {
  const {response, data} = await signedGet("/order", {
    symbol: TABDEAL_SELL_SYMBOL, origClientOrderId: clientId
  }, apiKey, apiSecret, fetchImpl);
  if (isOrderNotFound(response, data)) return null;
  if (!response.ok) fail("tabdeal_sell_order_lookup_unresolved_http_" + response.status);
  const order = normalizedOrder(data, clientId);
  if (!order) fail("tabdeal_sell_order_lookup_schema_invalid");
  return order;
}
async function claimExecutionLock({githubToken, repository, commitSha, runId, fetchImpl}) {
  if (typeof githubToken !== "string" || !githubToken.trim() ||
      typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      typeof commitSha !== "string" || !/^[a-f0-9]{40}$/i.test(commitSha) ||
      !/^\d{1,20}$/.test(String(runId ?? ""))) {
    return {claimed: false, result: "sell_lock_configuration_missing"};
  }
  const tag = "tabdeal-sell-all-btc-" + runId;
  const ref = "refs/tags/" + tag;
  const base = "https://api.github.com/repos/" + repository;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: "Bearer " + githubToken,
    "X-GitHub-Api-Version": "2022-11-28",
    "content-type": "application/json"
  };
  try {
    const existing = await fetchImpl(base + "/git/ref/tags/" + encodeURIComponent(tag), {
      method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(8_000)
    });
    if (existing.ok) return {claimed: false, result: "sell_execution_already_claimed"};
    if (existing.status !== 404) return {claimed: false, result: "sell_lock_read_unresolved"};
  } catch {
    return {claimed: false, result: "sell_lock_read_unresolved"};
  }
  try {
    const created = await fetchImpl(base + "/git/refs", {
      method: "POST", headers,
      body: JSON.stringify({ref, sha: commitSha}),
      redirect: "error", signal: AbortSignal.timeout(8_000)
    });
    if (created.status === 201) return {claimed: true, result: "sell_execution_lock_claimed"};
    if (created.status === 422) return {claimed: false, result: "sell_execution_already_claimed"};
    return {claimed: false, result: "sell_lock_create_unresolved"};
  } catch {
    return {claimed: false, result: "sell_lock_create_unresolved"};
  }
}

export async function runTabdealSellAllBtc({
  apiKey,
  apiSecret,
  mode = "dry_run",
  confirmLiveSell = false,
  confirmedQuantity = "",
  runId,
  repository,
  commitSha,
  githubToken,
  fetchImpl = fetch,
  claimLock = claimExecutionLock
} = {}) {
  const base = {
    checkedAt: new Date().toISOString(),
    symbol: TABDEAL_SELL_SYMBOL,
    mode,
    side: "SELL",
    orderType: "LIMIT",
    timeInForce: "IOC",
    ordersSubmitted: false,
    automaticRetry: false,
    cancellationSent: false,
    withdrawalOrTransferSent: false
  };
  if (mode !== "dry_run" && mode !== "live_sell") {
    return {...base, result: "invalid_mode_halt"};
  }
  if (typeof apiKey !== "string" || !apiKey.trim() ||
      typeof apiSecret !== "string" || !apiSecret.trim()) {
    return {...base, result: "credentials_missing_halt"};
  }

  let preflight;
  try {
    const [exchangeInfo, depth] = await Promise.all([
      publicGet("/exchangeInfo", fetchImpl),
      publicGet("/depth?symbol=" + TABDEAL_SELL_SYMBOL + "&limit=100", fetchImpl)
    ]);
    const symbols = Array.isArray(exchangeInfo) ? exchangeInfo
      : Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : null;
    if (!symbols) fail("tabdeal_sell_exchange_info_schema_invalid");
    const symbolInfo = symbols.find(item => isRecord(item) && item.symbol === TABDEAL_SELL_SYMBOL);
    if (!symbolInfo) fail("tabdeal_sell_btcusdt_symbol_missing");
    const [accountResult, ordersResult] = await Promise.all([
      signedGet("/account", {}, apiKey, apiSecret, fetchImpl),
      signedGet("/openOrders", {symbol: TABDEAL_SELL_SYMBOL}, apiKey, apiSecret, fetchImpl)
    ]);
    if (!accountResult.response.ok) fail("tabdeal_sell_account_read_http_" + accountResult.response.status);
    if (!ordersResult.response.ok) fail("tabdeal_sell_open_orders_read_http_" + ordersResult.response.status);
    preflight = prepareTabdealSellAllBtc({
      symbolInfo, depth, account: accountResult.data, openOrders: ordersResult.data
    });
  } catch (error) {
    return {
      ...base,
      result: "preflight_blocked",
      reason: String(error?.message || error).slice(0, 180),
      preflight: null
    };
  }
  if (preflight.status !== "READY") {
    return {...base, result: "preflight_blocked", preflight};
  }
  if (mode === "dry_run") {
    return {...base, result: "dry_run_passed_no_order_sent", preflight};
  }
  if (confirmLiveSell !== true) {
    return {...base, result: "live_sell_confirmation_missing_halt", preflight};
  }
  if (String(confirmedQuantity) !== preflight.sellQuantity) {
    return {...base, result: "live_sell_quantity_confirmation_mismatch_halt", preflight};
  }
  const clientOrderId = "sellbtc-" + String(runId ?? "");
  if (!/^sellbtc-\d{1,20}$/.test(clientOrderId) || clientOrderId.length > 36) {
    return {...base, result: "sell_run_id_invalid_halt", preflight};
  }

  let priorOrder;
  try {
    priorOrder = await lookupOrder(clientOrderId, apiKey, apiSecret, fetchImpl);
  } catch (error) {
    return {...base, result: "pre_submit_order_lookup_failed_halt",
      reason: String(error?.message || error).slice(0, 180), preflight, clientOrderId};
  }
  if (priorOrder) {
    return {...base, result: "existing_sell_order_reconciled_no_resubmit",
      preflight, clientOrderId, order: priorOrder, ordersSubmitted: false};
  }

  const lock = await claimLock({githubToken, repository, commitSha, runId, fetchImpl});
  if (!lock?.claimed) {
    return {...base, result: lock?.result || "sell_execution_lock_not_claimed",
      preflight, clientOrderId, ordersSubmitted: false};
  }

  const request = buildTabdealLimitIocSellRequest({
    quantity: preflight.sellQuantity,
    price: preflight.limitPrice,
    clientOrderId,
    apiKey,
    apiSecret
  });
  let postResponse;
  let postData;
  try {
    ({response: postResponse, data: postData} = await fetchJson(fetchImpl, request.url, {
      method: request.method, headers: request.headers, body: request.body
    }));
  } catch {
    try {
      const reconciled = await lookupOrder(clientOrderId, apiKey, apiSecret, fetchImpl);
      if (reconciled) return {
        ...base, result: "sell_reconciled_after_uncertain_post",
        preflight, clientOrderId, order: reconciled, ordersSubmitted: true
      };
    } catch {
      // Preserve uncertainty: this run is permanently locked and POST is never repeated.
    }
    return {...base, result: "sell_post_outcome_unknown_halt_no_retry",
      preflight, clientOrderId, ordersSubmitted: "unknown"};
  }
  if (!postResponse.ok) {
    if (postResponse.status >= 500) {
      try {
        const reconciled = await lookupOrder(clientOrderId, apiKey, apiSecret, fetchImpl);
        if (reconciled) return {
          ...base, result: "sell_reconciled_after_server_error",
          httpStatus: postResponse.status, preflight, clientOrderId,
          order: reconciled, ordersSubmitted: true
        };
      } catch {
        // Preserve unknown state; never repeat an uncertain POST.
      }
      return {...base, result: "sell_server_error_outcome_unknown_halt",
        httpStatus: postResponse.status, preflight, clientOrderId, ordersSubmitted: "unknown"};
    }
    return {...base, result: "sell_order_rejected_no_retry",
      httpStatus: postResponse.status,
      apiErrorCode: postData?.code ?? null,
      apiMessage: typeof postData?.msg === "string" ? postData.msg.slice(0, 180) : null,
      preflight, clientOrderId, ordersSubmitted: false};
  }
  let order = normalizedOrder(postData, clientOrderId);
  if (!order) {
    try { order = await lookupOrder(clientOrderId, apiKey, apiSecret, fetchImpl); } catch { order = null; }
  }
  if (!order) {
    return {...base, result: "sell_accepted_response_unreconciled_halt",
      preflight, clientOrderId, ordersSubmitted: true};
  }
  return {
    ...base,
    result: String(order.status).toUpperCase() === "FILLED" ? "sell_filled"
      : String(order.status).toUpperCase() === "PARTIALLY_FILLED" ? "sell_partially_filled"
      : "sell_order_accepted_not_fully_filled",
    preflight, clientOrderId, order, ordersSubmitted: true
  };
}

export function safeTabdealSellSummary(report) {
  return {
    checkedAt: report.checkedAt,
    symbol: report.symbol,
    mode: report.mode,
    side: report.side,
    orderType: report.orderType,
    timeInForce: report.timeInForce,
    result: report.result,
    reason: report.reason ?? null,
    httpStatus: report.httpStatus ?? null,
    apiErrorCode: report.apiErrorCode ?? null,
    apiMessage: report.apiMessage ?? null,
    preflight: report.preflight ?? null,
    clientOrderId: report.clientOrderId ?? null,
    order: report.order ?? null,
    ordersSubmitted: report.ordersSubmitted,
    automaticRetry: false,
    cancellationSent: false,
    withdrawalOrTransferSent: false,
    apiKeyLogged: false,
    apiSecretLogged: false
  };
}
