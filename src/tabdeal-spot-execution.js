const API_BASE = "https://api1.tabdeal.org";
const MAX_RECEIVE_WINDOW_MS = 10_000;
const CLIENT_ORDER_ID = /^[A-Za-z0-9._-]{1,36}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function fail(code) {
  throw new Error(code);
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function decimal(value, name) {
  const text = String(value ?? "");
  if (!DECIMAL.test(text) || !Number.isFinite(Number(text)) || Number(text) <= 0) {
    fail("tabdeal_" + name + "_invalid");
  }
  return text;
}
function safeSymbol(value, allowedSymbols) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,24}$/.test(symbol) || !allowedSymbols.includes(symbol)) {
    fail("tabdeal_symbol_not_allowlisted");
  }
  return symbol;
}
function toQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.append(key, String(value));
  }
  return query.toString();
}
async function sign(secret, encodedParams) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {name: "HMAC", hash: "SHA-256"},
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedParams));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function signedRequest({method, path, params, apiKey, apiSecret, timestamp, receiveWindowMs}) {
  if (typeof apiKey !== "string" || !apiKey.trim() ||
      typeof apiSecret !== "string" || !apiSecret.trim()) fail("tabdeal_credentials_missing");
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) fail("tabdeal_timestamp_invalid");
  if (!Number.isSafeInteger(receiveWindowMs) || receiveWindowMs < 1 ||
      receiveWindowMs > MAX_RECEIVE_WINDOW_MS) fail("tabdeal_receive_window_invalid");

  const signedParams = {...params, timestamp, recvWindow: receiveWindowMs};
  const unsignedQuery = toQuery(signedParams);
  const signature = await sign(apiSecret, unsignedQuery);
  const finalParams = {...signedParams, signature};
  const encoded = toQuery(finalParams);
  const read = method === "GET";
  const url = API_BASE + (read ? "/r/api/v1" : "/api/v1") + path;
  const headers = {
    accept: "application/json",
    "X-MBX-APIKEY": apiKey
  };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    return {method, url, headers, body: encoded};
  }
  return {method, url: url + "?" + encoded, headers};
}

export const TABDEAL_SPOT_EXECUTION_DEFAULTS = Object.freeze({
  apiBase: API_BASE,
  receiveWindowMs: 5_000,
  allowedSymbols: Object.freeze(["BTCUSDT"]),
  liveTradingEnabled: false,
  killSwitch: true,
  explicitOwnerApproval: false,
  automaticPostRetry: false
});

export async function buildTabdealLimitOrderRequest({
  symbol, side, quantity, price, clientOrderId,
  apiKey, apiSecret, timestamp = Date.now(), receiveWindowMs = 5_000,
  allowedSymbols = TABDEAL_SPOT_EXECUTION_DEFAULTS.allowedSymbols
} = {}) {
  const pair = safeSymbol(symbol, allowedSymbols);
  const direction = String(side ?? "").toUpperCase();
  if (!["BUY", "SELL"].includes(direction)) fail("tabdeal_order_side_invalid");
  const qty = decimal(quantity, "order_quantity");
  const limitPrice = decimal(price, "order_price");
  const clientId = String(clientOrderId ?? "");
  if (!CLIENT_ORDER_ID.test(clientId)) fail("tabdeal_client_order_id_invalid");

  return signedRequest({
    method: "POST",
    path: "/order",
    params: {
      symbol: pair,
      side: direction,
      type: "LIMIT",
      quantity: qty,
      price: limitPrice,
      stopPrice: "0",
      newClientOrderId: clientId
    },
    apiKey, apiSecret, timestamp, receiveWindowMs
  });
}

export async function buildTabdealGetOrderRequest({
  symbol, orderId, clientOrderId, apiKey, apiSecret,
  timestamp = Date.now(), receiveWindowMs = 5_000,
  allowedSymbols = TABDEAL_SPOT_EXECUTION_DEFAULTS.allowedSymbols
} = {}) {
  const pair = safeSymbol(symbol, allowedSymbols);
  if ((orderId === undefined || orderId === null || orderId === "") &&
      (clientOrderId === undefined || clientOrderId === null || clientOrderId === "")) {
    fail("tabdeal_order_lookup_id_required");
  }
  if (clientOrderId !== undefined && clientOrderId !== null && clientOrderId !== "" &&
      !CLIENT_ORDER_ID.test(String(clientOrderId))) fail("tabdeal_client_order_id_invalid");
  return signedRequest({
    method: "GET",
    path: "/order",
    params: {
      symbol: pair,
      ...(orderId !== undefined && orderId !== null && orderId !== "" ? {orderId: String(orderId)} : {}),
      ...(clientOrderId ? {origClientOrderId: String(clientOrderId)} : {})
    },
    apiKey, apiSecret, timestamp, receiveWindowMs
  });
}

export async function buildTabdealCancelOrderRequest({
  symbol, orderId, clientOrderId, apiKey, apiSecret,
  timestamp = Date.now(), receiveWindowMs = 5_000,
  allowedSymbols = TABDEAL_SPOT_EXECUTION_DEFAULTS.allowedSymbols
} = {}) {
  const pair = safeSymbol(symbol, allowedSymbols);
  if ((orderId === undefined || orderId === null || orderId === "") &&
      (clientOrderId === undefined || clientOrderId === null || clientOrderId === "")) {
    fail("tabdeal_order_cancel_id_required");
  }
  if (clientOrderId !== undefined && clientOrderId !== null && clientOrderId !== "" &&
      !CLIENT_ORDER_ID.test(String(clientOrderId))) fail("tabdeal_client_order_id_invalid");
  return signedRequest({
    method: "DELETE",
    path: "/order",
    params: {
      symbol: pair,
      ...(orderId !== undefined && orderId !== null && orderId !== "" ? {orderId: String(orderId)} : {}),
      ...(clientOrderId ? {origClientOrderId: String(clientOrderId)} : {})
    },
    apiKey, apiSecret, timestamp, receiveWindowMs
  });
}


export async function buildTabdealOcoSellOrderRequest({
  symbol, quantity, price, stopPrice, stopLimitPrice,
  listClientOrderId, limitClientOrderId, stopClientOrderId,
  apiKey, apiSecret, timestamp = Date.now(), receiveWindowMs = 5_000,
  allowedSymbols = TABDEAL_SPOT_EXECUTION_DEFAULTS.allowedSymbols
} = {}) {
  const pair = safeSymbol(symbol, allowedSymbols);
  const qty = decimal(quantity, "oco_quantity");
  const limitPrice = decimal(price, "oco_limit_price");
  const triggerPrice = decimal(stopPrice, "oco_stop_price");
  const stopLimit = decimal(stopLimitPrice, "oco_stop_limit_price");
  // Long Spot exit: take-profit limit sits above the stop trigger;
  // the stop-limit execution price sits at or below the trigger.
  if (!(Number(limitPrice) > Number(triggerPrice) &&
        Number(triggerPrice) > Number(stopLimit))) {
    fail("tabdeal_oco_sell_price_relationship_invalid");
  }
  const rawIds = [listClientOrderId, limitClientOrderId, stopClientOrderId];
  if (rawIds.some(id => typeof id !== "string" || !CLIENT_ORDER_ID.test(id))) {
    fail("tabdeal_oco_client_order_id_invalid");
  }
  const ids = rawIds;
  if (new Set(ids).size !== ids.length) fail("tabdeal_oco_client_order_ids_must_be_unique");
  return signedRequest({
    method: "POST",
    path: "/order/oco",
    params: {
      symbol: pair,
      side: "SELL",
      quantity: qty,
      price: limitPrice,
      stopPrice: triggerPrice,
      stopLimitPrice: stopLimit,
      listClientOrderId: ids[0],
      limitClientOrderId: ids[1],
      stopClientOrderId: ids[2]
    },
    apiKey, apiSecret, timestamp, receiveWindowMs
  });
}

export async function buildTabdealGetOcoOrderRequest({
  orderListId, listClientOrderId, apiKey, apiSecret,
  timestamp = Date.now(), receiveWindowMs = 5_000
} = {}) {
  const hasId = orderListId !== undefined && orderListId !== null && orderListId !== "";
  const hasClientId = listClientOrderId !== undefined && listClientOrderId !== null && listClientOrderId !== "";
  if (hasId === hasClientId) fail("tabdeal_oco_lookup_exactly_one_id_required");
  if (hasId && !/^\d{1,30}$/.test(String(orderListId))) fail("tabdeal_oco_order_list_id_invalid");
  if (hasClientId && !CLIENT_ORDER_ID.test(String(listClientOrderId))) {
    fail("tabdeal_oco_list_client_order_id_invalid");
  }
  return signedRequest({
    method: "GET",
    path: "/orderList",
    params: hasId ? {orderListId: String(orderListId)} : {origClientOrderId: String(listClientOrderId)},
    apiKey, apiSecret, timestamp, receiveWindowMs
  });
}

export async function buildTabdealCancelOcoOrderRequest({
  symbol, orderListId, listClientOrderId, apiKey, apiSecret,
  timestamp = Date.now(), receiveWindowMs = 5_000,
  allowedSymbols = TABDEAL_SPOT_EXECUTION_DEFAULTS.allowedSymbols
} = {}) {
  const pair = safeSymbol(symbol, allowedSymbols);
  const hasId = orderListId !== undefined && orderListId !== null && orderListId !== "";
  const hasClientId = listClientOrderId !== undefined && listClientOrderId !== null && listClientOrderId !== "";
  if (hasId === hasClientId) fail("tabdeal_oco_cancel_exactly_one_id_required");
  if (hasId && !/^\d{1,30}$/.test(String(orderListId))) fail("tabdeal_oco_order_list_id_invalid");
  if (hasClientId && !CLIENT_ORDER_ID.test(String(listClientOrderId))) {
    fail("tabdeal_oco_list_client_order_id_invalid");
  }
  return signedRequest({
    method: "DELETE",
    path: "/orderList",
    params: {
      symbol: pair,
      ...(hasId ? {orderListId: String(orderListId)} : {listClientOrderId: String(listClientOrderId)})
    },
    apiKey, apiSecret, timestamp, receiveWindowMs
  });
}

function safeOrder(data, fallbackClientOrderId) {
  if (!record(data)) return null;
  const orderId = data.orderId === undefined || data.orderId === null ? null : String(data.orderId);
  if (!orderId) return null;
  return {
    orderId,
    clientOrderId: data.clientOrderId ? String(data.clientOrderId) : fallbackClientOrderId,
    symbol: typeof data.symbol === "string" ? data.symbol : null,
    side: typeof data.side === "string" ? data.side : null,
    type: typeof data.type === "string" ? data.type : null,
    status: typeof data.status === "string" ? data.status : "UNKNOWN",
    originalQuantity: data.origQty === undefined ? null : String(data.origQty),
    executedQuantity: data.executedQty === undefined ? null : String(data.executedQty),
    price: data.price === undefined ? null : String(data.price),
    updateTime: Number.isSafeInteger(Number(data.updateTime)) ? Number(data.updateTime) : null
  };
}


function safeOco(data, fallbackListClientOrderId) {
  if (!record(data)) return null;
  const orderListId = data.orderListId === undefined || data.orderListId === null
    ? null : String(data.orderListId);
  if (!orderListId || !/^\d{1,30}$/.test(orderListId) ||
      !Array.isArray(data.orders) || data.orders.length !== 2) return null;
  const orders = data.orders.map(row => {
    if (!record(row) || row.orderId === undefined || row.orderId === null) return null;
    return {
      orderId: String(row.orderId),
      clientOrderId: row.clientOrderId ? String(row.clientOrderId) : null,
      symbol: typeof row.symbol === "string" ? row.symbol : null
    };
  });
  if (orders.some(row => row === null)) return null;
  return {
    orderListId,
    listClientOrderId: data.listClientOrderId || fallbackListClientOrderId || null,
    symbol: typeof data.symbol === "string" ? data.symbol : null,
    listStatusType: typeof data.listStatusType === "string" ? data.listStatusType : "UNKNOWN",
    listOrderStatus: typeof data.listOrderStatus === "string" ? data.listOrderStatus : "UNKNOWN",
    orders
  };
}

export function createTabdealSpotExecutionClient({
  apiKey,
  apiSecret,
  fetchImpl = fetch,
  liveTradingEnabled = TABDEAL_SPOT_EXECUTION_DEFAULTS.liveTradingEnabled,
  killSwitch = TABDEAL_SPOT_EXECUTION_DEFAULTS.killSwitch,
  explicitOwnerApproval = TABDEAL_SPOT_EXECUTION_DEFAULTS.explicitOwnerApproval,
  allowedSymbols = TABDEAL_SPOT_EXECUTION_DEFAULTS.allowedSymbols,
  receiveWindowMs = TABDEAL_SPOT_EXECUTION_DEFAULTS.receiveWindowMs,
  maxOrderNotionalQuote = 0,
  portfolioRiskChecksPassed = false,
  timeoutMs = 8_000
} = {}) {
  const assertLiveGate = () => {
    if (liveTradingEnabled !== true || killSwitch !== false || explicitOwnerApproval !== true) {
      fail("tabdeal_live_execution_gate_closed");
    }
    if (portfolioRiskChecksPassed !== true ||
        !Number.isFinite(Number(maxOrderNotionalQuote)) || Number(maxOrderNotionalQuote) <= 0) {
      fail("tabdeal_portfolio_risk_cap_missing");
    }
    if (typeof fetchImpl !== "function") fail("tabdeal_fetch_unavailable");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      fail("tabdeal_timeout_invalid");
    }
  };

  const getOrder = async ({symbol, clientOrderId, timestamp = Date.now()} = {}) => {
    const request = await buildTabdealGetOrderRequest({
      symbol, clientOrderId, apiKey, apiSecret, timestamp, receiveWindowMs, allowedSymbols
    });
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json().catch(() => null);
    if (response.status === 404 && record(data) && Number(data.code) === 1204) return null;
    if (response.status === 404) fail("tabdeal_order_lookup_unclassified_404");
    if (!response.ok) fail("tabdeal_order_lookup_http_" + response.status);
    const order = safeOrder(data, clientOrderId);
    if (!order) fail("tabdeal_order_lookup_payload_invalid");
    return order;
  };


  const getOcoOrder = async ({orderListId, listClientOrderId, timestamp = Date.now()} = {}) => {
    const request = await buildTabdealGetOcoOrderRequest({
      orderListId, listClientOrderId, apiKey, apiSecret, timestamp, receiveWindowMs
    });
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json().catch(() => null);
    if (response.status === 404 && record(data) && Number(data.code) === 1205) return null;
    if (response.status === 404) fail("tabdeal_oco_lookup_unclassified_404");
    if (!response.ok) fail("tabdeal_oco_lookup_http_" + response.status);
    const order = safeOco(data, listClientOrderId);
    if (!order) fail("tabdeal_oco_lookup_payload_invalid");
    return order;
  };

  const assertCancelGate = () => {
    // Cancellation is risk-reducing and must remain available after the kill
    // switch disables new entries. It still requires a separately approved
    // live-pilot configuration and valid credentials.
    if (explicitOwnerApproval !== true) fail("tabdeal_cancel_owner_approval_required");
    if (typeof fetchImpl !== "function") fail("tabdeal_fetch_unavailable");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      fail("tabdeal_timeout_invalid");
    }
  };

  return Object.freeze({
    async submitLimitOrder(intent) {
      assertLiveGate();
      if (!record(intent?.riskPlan) || intent.riskPlan.approved !== true ||
          !Number.isFinite(Number(intent.riskPlan.quantity)) ||
          !Number.isFinite(Number(intent.riskPlan.notional)) ||
          Number(intent.riskPlan.quantity) <= 0 ||
          Number(intent.riskPlan.quantity) !== Number(intent.quantity) ||
          Number(intent.riskPlan.notional) > Number(maxOrderNotionalQuote) ||
          intent.riskPlan.assumptions?.leverage !== false ||
          intent.riskPlan.assumptions?.shorting !== false) {
        fail("tabdeal_risk_plan_invalid_or_over_cap");
      }
      const actualOrderNotional = Number(intent.quantity) * Number(intent.price);
      if (!Number.isFinite(actualOrderNotional) || actualOrderNotional <= 0 ||
          actualOrderNotional > Number(maxOrderNotionalQuote) ||
          actualOrderNotional > Number(intent.riskPlan.notional) * 1.000001) {
        fail("tabdeal_order_notional_exceeds_approved_risk_plan");
      }
      let priorOrder;
      try {
        priorOrder = await getOrder({
          symbol: intent.symbol,
          clientOrderId: intent.clientOrderId
        });
      } catch {
        return {
          status: "pre_submit_lookup_failed_halt",
          clientOrderId: String(intent.clientOrderId),
          automaticRetry: false
        };
      }
      if (priorOrder) {
        return {status: "existing_client_order_reconciled", order: priorOrder, automaticRetry: false};
      }

      const request = await buildTabdealLimitOrderRequest({
        ...intent, apiKey, apiSecret, allowedSymbols, receiveWindowMs
      });
      try {
        const response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(timeoutMs)
        });
        const data = await response.json().catch(() => null);
        if (response.ok) {
          const order = safeOrder(data, intent.clientOrderId);
          if (order) return {status: "accepted", order, automaticRetry: false};
          try {
            const reconciled = await getOrder({
              symbol: intent.symbol,
              clientOrderId: intent.clientOrderId
            });
            if (reconciled) {
              return {status: "reconciled_after_uncertain_acceptance", order: reconciled, automaticRetry: false};
            }
          } catch {
            // A successful but malformed POST response remains uncertain.
          }
          return {status: "accepted_response_unreconciled", order: null, automaticRetry: false};
        }
        if (response.status < 500) {
          return {
            status: "rejected",
            httpStatus: response.status,
            exchangeCode: record(data) && (typeof data.code === "number" || typeof data.code === "string")
              ? data.code : null,
            automaticRetry: false
          };
        }
      } catch {
        // An uncertain POST is reconciled by client order ID; the POST is never repeated.
      }

      try {
        const order = await getOrder({
          symbol: intent.symbol,
          clientOrderId: intent.clientOrderId
        });
        if (order) return {status: "reconciled_after_uncertain_submit", order, automaticRetry: false};
      } catch {
        // Preserve uncertainty. Never issue a second POST after a timeout/5xx.
      }
      return {
        status: "unknown_submission_state_halt",
        clientOrderId: String(intent.clientOrderId),
        automaticRetry: false,
        reason: "query_by_client_order_id_required_before_any_new_intent"
      };
    },

    async getOrder(args) {
      return getOrder(args);
    },


    async getOcoOrder(args) {
      return getOcoOrder(args);
    },

    async submitOcoExit(intent) {
      assertLiveGate();
      if (!record(intent?.riskPlan) || intent.riskPlan.approved !== true ||
          !Number.isFinite(Number(intent.riskPlan.quantity)) ||
          !Number.isFinite(Number(intent.riskPlan.notional)) ||
          Number(intent.riskPlan.quantity) <= 0 ||
          Number(intent.riskPlan.quantity) !== Number(intent.quantity) ||
          Number(intent.riskPlan.notional) > Number(maxOrderNotionalQuote) ||
          intent.riskPlan.assumptions?.leverage !== false ||
          intent.riskPlan.assumptions?.shorting !== false) {
        fail("tabdeal_oco_risk_plan_invalid_or_over_cap");
      }
      const actualNotional = Number(intent.quantity) * Number(intent.price);
      if (!Number.isFinite(actualNotional) || actualNotional <= 0 ||
          actualNotional > Number(maxOrderNotionalQuote) ||
          actualNotional > Number(intent.riskPlan.notional) * 1.000001) {
        fail("tabdeal_oco_notional_exceeds_approved_risk_plan");
      }
      let prior;
      try {
        prior = await getOcoOrder({symbol: intent.symbol, listClientOrderId: intent.listClientOrderId});
      } catch {
        return {
          status: "pre_submit_oco_lookup_failed_halt",
          listClientOrderId: String(intent.listClientOrderId),
          automaticRetry: false
        };
      }
      if (prior) return {status: "existing_oco_reconciled", order: prior, automaticRetry: false};

      const request = await buildTabdealOcoSellOrderRequest({
        ...intent, symbol: intent.symbol, apiKey, apiSecret, allowedSymbols, receiveWindowMs
      });
      try {
        const response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(timeoutMs)
        });
        const data = await response.json().catch(() => null);
        if (response.ok) {
          const order = safeOco(data, intent.listClientOrderId);
          if (order) return {status: "accepted", order, automaticRetry: false};
          try {
            const reconciled = await getOcoOrder({listClientOrderId: intent.listClientOrderId});
            if (reconciled) return {status: "reconciled_after_uncertain_oco_acceptance", order: reconciled, automaticRetry: false};
          } catch {
            // Keep the POST outcome uncertain. Never send a second OCO POST.
          }
          return {status: "accepted_oco_response_unreconciled", order: null, automaticRetry: false};
        }
        if (response.status < 500) {
          return {
            status: "rejected",
            httpStatus: response.status,
            exchangeCode: record(data) && (typeof data.code === "number" || typeof data.code === "string")
              ? data.code : null,
            automaticRetry: false
          };
        }
      } catch {
        // Reconcile once by list client ID; never repeat an uncertain OCO POST.
      }
      try {
        const reconciled = await getOcoOrder({listClientOrderId: intent.listClientOrderId});
        if (reconciled) return {status: "reconciled_after_uncertain_oco_submit", order: reconciled, automaticRetry: false};
      } catch {
        // Keep uncertain state visible to the operator.
      }
      return {
        status: "unknown_oco_submission_state_halt",
        listClientOrderId: String(intent.listClientOrderId),
        automaticRetry: false,
        reason: "query_by_list_client_order_id_required_before_any_new_exit"
      };
    },

    async cancelOcoOrder({symbol, orderListId, listClientOrderId, timestamp = Date.now()} = {}) {
      assertCancelGate();
      const request = await buildTabdealCancelOcoOrderRequest({
        symbol, orderListId, listClientOrderId, apiKey, apiSecret, timestamp,
        receiveWindowMs, allowedSymbols
      });
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          status: "oco_cancel_rejected",
          httpStatus: response.status,
          exchangeCode: record(data) && (typeof data.code === "number" || typeof data.code === "string")
            ? data.code : null
        };
      }
      const order = safeOco(data, listClientOrderId);
      return {status: "oco_cancel_response_received", order};
    },

    async cancelOrder({symbol, orderId, clientOrderId, timestamp = Date.now()} = {}) {
      assertCancelGate();
      const request = await buildTabdealCancelOrderRequest({
        symbol, orderId, clientOrderId, apiKey, apiSecret, timestamp,
        receiveWindowMs, allowedSymbols
      });
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          status: "cancel_rejected",
          httpStatus: response.status,
          exchangeCode: record(data) && (typeof data.code === "number" || typeof data.code === "string")
            ? data.code : null
        };
      }
      return {status: "cancel_response_received", order: safeOrder(data, clientOrderId)};
    }
  });
}
