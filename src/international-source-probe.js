const BINANCE_BASE = "https://data-api.binance.vision";
const KRAKEN_BASE = "https://api.kraken.com";

export const INTERNATIONAL_SOURCE_PROBES = Object.freeze([
  {
    id: "binance_ping",
    provider: "binance",
    optional: false,
    url: BINANCE_BASE + "/api/v3/ping"
  },
  {
    id: "binance_exchange_info",
    provider: "binance",
    optional: false,
    url: BINANCE_BASE + "/api/v3/exchangeInfo?symbol=BTCUSDT"
  },
  {
    id: "binance_klines",
    provider: "binance",
    optional: false,
    url: BINANCE_BASE + "/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=5"
  },
  {
    id: "kraken_time",
    provider: "kraken",
    optional: false,
    url: KRAKEN_BASE + "/0/public/Time"
  },
  {
    id: "kraken_ohlc",
    provider: "kraken",
    optional: false,
    url: KRAKEN_BASE + "/0/public/OHLC?pair=XBTUSD&interval=60"
  },
  {
    id: "kraken_trades",
    provider: "kraken",
    optional: false,
    url: KRAKEN_BASE + "/0/public/Trades?pair=XBTUSD"
  },
  {
    id: "coingecko_ping",
    provider: "coingecko",
    optional: true,
    url: "https://api.coingecko.com/api/v3/ping"
  }
]);

const isRecord = value =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function rowsUnderResult(result) {
  if (!isRecord(result)) return null;
  const key = Object.keys(result).find(item => item !== "last" && Array.isArray(result[item]));
  return key ? result[key] : null;
}

export function inspectInternationalProbePayload(id, payload) {
  if (!isRecord(payload) && !Array.isArray(payload)) {
    return {schemaStatus: "invalid_payload", recordCount: 0};
  }

  if (id === "binance_ping") {
    return isRecord(payload)
      ? {schemaStatus: "ok", recordCount: 1}
      : {schemaStatus: "invalid_payload", recordCount: 0};
  }

  if (id === "binance_exchange_info") {
    const markets = Array.isArray(payload.symbols)
      ? payload.symbols
      : (typeof payload.symbol === "string" ? [payload] : []);
    const btcUsdt = markets.find(item =>
      isRecord(item) &&
      String(item.symbol || "").toUpperCase() === "BTCUSDT" &&
      String(item.status || "").toUpperCase() === "TRADING"
    );
    return btcUsdt
      ? {schemaStatus: "ok", recordCount: markets.length}
      : {schemaStatus: "invalid_payload", recordCount: markets.length};
  }

  if (id === "binance_klines") {
    if (!Array.isArray(payload) || payload.length < 2) {
      return {schemaStatus: "invalid_payload", recordCount: Array.isArray(payload) ? payload.length : 0};
    }
    let previousOpen = -Infinity;
    for (const row of payload) {
      if (!Array.isArray(row) || row.length < 8) {
        return {schemaStatus: "invalid_payload", recordCount: payload.length};
      }
      const openTime = Number(row[0]);
      const closeTime = Number(row[6]);
      if (!Number.isSafeInteger(openTime) || !Number.isSafeInteger(closeTime) ||
          openTime <= previousOpen || closeTime < openTime) {
        return {schemaStatus: "invalid_payload", recordCount: payload.length};
      }
      previousOpen = openTime;
    }
    return {schemaStatus: "ok", recordCount: payload.length};
  }

  if (id === "kraken_time") {
    const seconds = Number(payload.result?.unixtime);
    const noErrors = Array.isArray(payload.error) && payload.error.length === 0;
    return noErrors && Number.isSafeInteger(seconds) && seconds > 0
      ? {schemaStatus: "ok", recordCount: 1}
      : {schemaStatus: payload.error?.length ? "provider_error" : "invalid_payload", recordCount: 0};
  }

  if (id === "kraken_ohlc" || id === "kraken_trades") {
    const noErrors = Array.isArray(payload.error) && payload.error.length === 0;
    if (!noErrors) {
      return {schemaStatus: payload.error?.length ? "provider_error" : "invalid_payload", recordCount: 0};
    }
    const rows = rowsUnderResult(payload.result);
    if (!Array.isArray(rows) || rows.length === 0) {
      return {schemaStatus: "invalid_payload", recordCount: 0};
    }
    const minimumFields = id === "kraken_ohlc" ? 8 : 6;
    const validRows = rows.filter(row =>
      Array.isArray(row) &&
      row.length >= minimumFields &&
      Number.isFinite(Number(id === "kraken_ohlc" ? row[0] : row[2]))
    );
    if (validRows.length !== rows.length) {
      return {schemaStatus: "invalid_payload", recordCount: rows.length};
    }
    return {schemaStatus: "ok", recordCount: rows.length};
  }

  if (id === "coingecko_ping") {
    return typeof payload.gecko_says === "string"
      ? {schemaStatus: "ok", recordCount: 1}
      : {schemaStatus: "invalid_payload", recordCount: 0};
  }

  return {schemaStatus: "unknown_probe", recordCount: 0};
}

function classifyHttpFailure(status) {
  if (status === 401 || status === 403) return "auth_required_or_access_restricted";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_http_error";
  return "http_error";
}

export function summarizeProviderReachability(results) {
  const providers = {};
  for (const provider of ["binance", "kraken", "coingecko"]) {
    const rows = results.filter(item => item.provider === provider);
    if (!rows.length) continue;
    const reachableCount = rows.filter(item => item.status === "reachable").length;
    providers[provider] = {
      optional: rows.every(item => item.optional),
      checkedEndpoints: rows.length,
      reachableEndpoints: reachableCount,
      status: reachableCount === rows.length
        ? "all_checked_endpoints_reachable"
        : reachableCount > 0
          ? "partially_reachable"
          : "unavailable_or_restricted"
    };
  }
  return providers;
}

export async function runInternationalSourceProbe({
  fetchImpl = fetch,
  now = () => new Date(),
  timeoutMs = 10_000,
  probes = INTERNATIONAL_SOURCE_PROBES
} = {}) {
  const results = [];
  for (const probe of probes) {
    const startedAt = Date.now();
    let result;
    try {
      const response = await fetchImpl(probe.url, {
        method: "GET",
        headers: {accept: "application/json"},
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs)
      });
      const latencyMs = Math.max(0, Date.now() - startedAt);
      if (!response.ok) {
        result = {
          id: probe.id,
          provider: probe.provider,
          optional: probe.optional,
          status: classifyHttpFailure(response.status),
          httpStatus: response.status,
          latencyMs,
          schemaStatus: "not_checked",
          recordCount: 0
        };
      } else {
        let payload;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        const shape = inspectInternationalProbePayload(probe.id, payload);
        result = {
          id: probe.id,
          provider: probe.provider,
          optional: probe.optional,
          status: shape.schemaStatus === "ok" ? "reachable" :
            shape.schemaStatus === "provider_error" ? "provider_error" : "invalid_payload",
          httpStatus: response.status,
          latencyMs,
          schemaStatus: shape.schemaStatus,
          recordCount: shape.recordCount
        };
      }
    } catch (error) {
      result = {
        id: probe.id,
        provider: probe.provider,
        optional: probe.optional,
        status: error?.name === "TimeoutError" ? "timeout" : "network_error",
        httpStatus: null,
        latencyMs: Math.max(0, Date.now() - startedAt),
        schemaStatus: "not_checked",
        recordCount: 0,
        errorName: String(error?.name || "Error").slice(0, 40)
      };
    }
    results.push(result);
  }

  const providerSummary = summarizeProviderReachability(results);
  const requiredProviders = ["binance", "kraken"];
  const requiredReady = requiredProviders.every(provider =>
    providerSummary[provider]?.status === "all_checked_endpoints_reachable"
  );

  return {
    schemaVersion: 1,
    capturedAt: now().toISOString(),
    mode: "unauthenticated_public_market_data_get_only",
    requiredProviderStatus: requiredReady ? "reachable" : "partial_or_blocked",
    providers: providerSummary,
    probes: results,
    safety: {
      credentialsUsed: false,
      privateEndpointsCalled: false,
      accountDataRead: false,
      ordersSubmitted: 0,
      fundsMoved: false,
      liveTradingEnabled: false
    },
    interpretation: "This is a bounded reachability and response-shape probe only. It does not validate historical completeness, source terms, regional policy, price-unit equivalence, signal quality or profitability."
  };
}
