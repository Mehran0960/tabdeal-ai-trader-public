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

export function createTabdealSpotExecutionClient({
  apiKey,
  apiSecret,
  fetchImpl = fetch,
  liveTradingEnabled = TABDEAL_SPOT_EXECUTION_DEFAULTS.liveTradingEnabled,
  killSwitch = TABDEAL_SPOT_EXECUTION_DEFAULTS.killSwitch,
  explicitOwnerApproval = TABDEAL_SPOT_EXECUTION_DEFAULTS.explicitOwnerApproval,
  allowedSymbols = TABDEAL_SPOT_EXECUTION_DEFAULTS.allowedSymbols,
  receiveWindowMs = TABDEAL_SPOT_EXECUTION_DEFAULTS.receiveWindowMs,
  timeoutMs = 8_000
} = {}) {
  const assertLiveGate = () => {
    if (liveTradingEnabled !== true || killSwitch !== false || explicitOwnerApproval !== true) {
      fail("tabdeal_live_execution_gate_closed");
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
    return response.ok ? safeOrder(data, clientOrderId) : null;
  };

  return Object.freeze({
    async submitLimitOrder(intent) {
      assertLiveGate();
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
          return order
            ? {status: "accepted", order, automaticRetry: false}
            : {status: "accepted_response_unreconciled", order: null, automaticRetry: false};
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

    async cancelOrder({symbol, orderId, clientOrderId, timestamp = Date.now()} = {}) {
      assertLiveGate();
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
