export const PULLMOL_API_BASE = "https://pool.pullmol.ir";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeUrlPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return "invalid_url";
  }
}

function freshnessSummary(payload, nowMs) {
  const freshness = isRecord(payload?.freshness) ? payload.freshness : null;
  if (!freshness) return null;
  const sourceTimestampMs = finite(freshness.source_timestamp_ms);
  const sourceAgeReportedMs = finite(freshness.source_age_ms);
  const sourceAgeCalculatedMs = sourceTimestampMs === null ? null : nowMs - sourceTimestampMs;
  const staleAfterMs = finite(freshness.stale_after_ms);
  return {
    sourceTimestampMs,
    sourceAgeReportedMs,
    sourceAgeCalculatedMs,
    staleAfterMs,
    reportedStatus: typeof freshness.status === "string" ? freshness.status : null,
    reportedStale: typeof freshness.stale === "boolean" ? freshness.stale : null,
    within60Seconds: sourceAgeCalculatedMs !== null &&
      sourceAgeCalculatedMs >= -60_000 && sourceAgeCalculatedMs <= 60_000
  };
}

function eventRows(payload) {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (Array.isArray(payload?.data)) return payload.data.filter(isRecord);
  if (Array.isArray(payload?.data?.results)) return payload.data.results.filter(isRecord);
  if (Array.isArray(payload?.signals)) return payload.signals.filter(isRecord);
  return [];
}

/**
 * Produces a privacy- and rights-conscious probe summary.
 * It deliberately discards price values, event reasons, raw payloads, and full signal bodies.
 */
export function summarizePullmolResponse({url, status, contentType, payload, elapsedMs, nowMs = Date.now()}) {
  const path = safeUrlPath(url);
  const base = {
    path,
    method: "GET",
    httpStatus: Number.isInteger(status) ? status : null,
    ok: Number.isInteger(status) && status >= 200 && status < 300,
    contentType: typeof contentType === "string" ? contentType.split(";")[0] : null,
    elapsedMs: Math.max(0, finite(elapsedMs) ?? 0),
    json: isRecord(payload) || Array.isArray(payload)
  };

  if (path === "/services") {
    const services = Array.isArray(payload?.data) ? payload.data : [];
    return {...base, serviceCount: services.length, serviceIds: services
      .map(item => cleanIdentifier(item?.id))
      .filter(Boolean)};
  }

  if (path === "/markets") {
    const markets = Array.isArray(payload?.data) ? payload.data : [];
    const normalized = markets.map(value => String(value).toUpperCase());
    return {
      ...base,
      marketCount: markets.length,
      containsBTCUSDT: normalized.includes("BTCUSDT") || normalized.includes("BTC/USDT"),
      containsETHUSDT: normalized.includes("ETHUSDT") || normalized.includes("ETH/USDT"),
      containsPAXGUSDT: normalized.includes("PAXGUSDT") || normalized.includes("PAXG/USDT")
    };
  }

  if (path === "/ticker") {
    return {
      ...base,
      symbolPresent: typeof payload?.data?.symbol === "string",
      bidAskPresent: finite(payload?.data?.bid) !== null && finite(payload?.data?.ask) !== null,
      freshness: freshnessSummary(payload, nowMs)
    };
  }

  if (path === "/candles") {
    const bars = Array.isArray(payload?.data) ? payload.data : [];
    const latestTimestamp = bars.length ? finite(bars[bars.length - 1]?.[0]) : null;
    const ageMs = latestTimestamp === null ? null : nowMs - latestTimestamp;
    const requestedLimit = Number(new URL(url).searchParams.get("limit"));
    return {
      ...base,
      timeframe: cleanIdentifier(payload?.timeframe),
      requestedBars: Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : null,
      returnedBars: bars.length,
      returnedFewerThanRequested: Number.isSafeInteger(requestedLimit) && requestedLimit > bars.length,
      latestBarTimestampMs: latestTimestamp,
      latestBarAgeMs: ageMs,
      freshness: freshnessSummary(payload, nowMs)
    };
  }

  if (path === "/signals") {
    const rows = eventRows(payload);
    const keys = [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
    const hasEntry = rows.some(row => row.entry !== undefined || row.entry_price !== undefined);
    const hasStop = rows.some(row => row.stop !== undefined || row.stop_loss !== undefined || row.stopLoss !== undefined);
    const hasTargets = rows.some(row =>
      Array.isArray(row.targets) || row.tp1 !== undefined || row.take_profit !== undefined
    );
    const directions = [...new Set(rows
      .map(row => typeof row.direction === "string" ? row.direction.toUpperCase() : null)
      .filter(Boolean))].sort();
    return {
      ...base,
      signalEventCount: rows.length,
      eventFieldNames: keys,
      directions,
      containsEntryLevels: hasEntry,
      containsStopLoss: hasStop,
      containsTakeProfitLevels: hasTargets,
      freshness: freshnessSummary(payload, nowMs)
    };
  }

  if (path === "/analysis") {
    return {
      ...base,
      recommendationPresent: typeof payload?.recommendation === "string",
      confidencePresent: finite(payload?.confidence) !== null,
      freshness: freshnessSummary(payload, nowMs)
    };
  }

  return base;
}

function cleanIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9._-]{1,64}$/.test(normalized) ? normalized : null;
}

async function requestJson(fetchImpl, url, timeoutMs) {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {accept: "application/json"},
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
    const elapsedMs = Math.max(0, Date.now() - started);
    const contentType = response.headers?.get?.("content-type") ?? null;
    if (!response.ok) {
      return {
        summary: summarizePullmolResponse({
          url, status: response.status, contentType, payload: null, elapsedMs
        })
      };
    }
    const payload = await response.json();
    return {
      summary: summarizePullmolResponse({
        url, status: response.status, contentType, payload, elapsedMs
      })
    };
  } catch (error) {
    return {
      summary: summarizePullmolResponse({
        url, status: null, contentType: null, payload: null,
        elapsedMs: Math.max(0, Date.now() - started)
      }),
      errorClass: cleanIdentifier(String(error?.name ?? "error")) ?? "error"
    };
  }
}

export async function runPullmolReadOnlyProbe({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 12_000,
  baseUrl = PULLMOL_API_BASE
} = {}) {
  if (baseUrl !== PULLMOL_API_BASE) throw new Error("pullmol_base_url_not_allowlisted");
  const nowMs = Number(now());
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error("probe_clock_invalid");

  const root = PULLMOL_API_BASE;
  const endpoints = [
    "/services",
    "/markets?exchange=tabdeal",
    "/ticker?exchange=tabdeal&symbol=BTC-USDT",
    "/candles?exchange=tabdeal&symbol=BTC-USDT&timeframe=1hour&limit=5",
    "/signals/BTC-USDT?exchange=tabdeal&timeframe=1hour&limit=20",
    "/signals/ETH-USDT?exchange=tabdeal&timeframe=1hour&limit=20",
    "/signals/PAXG-USDT?exchange=tabdeal&timeframe=1hour&limit=20",
    "/analysis/BTC-USDT?exchange=tabdeal&timeframe=1hour&limit=20"
  ];

  const requests = [];
  for (const path of endpoints) {
    const result = await requestJson(fetchImpl, root + path, timeoutMs);
    requests.push({
      ...result.summary,
      ...(result.errorClass ? {errorClass: result.errorClass} : {})
    });
  }

  return {
    schemaVersion: 1,
    provider: "PULLMOL",
    capturedAt: new Date(nowMs).toISOString(),
    scope: "public_read_only_probe",
    requests,
    safety: {
      getRequestsOnly: true,
      credentialsUsed: false,
      accountEndpointsCalled: false,
      signalPayloadValuesPersisted: false,
      rawProviderResponsesPersisted: false,
      orderSubmissionAttempted: false,
      fundsMoved: false
    },
    limitations: [
      "A reachable API is not evidence of permission for long-term storage or model processing.",
      "A signal event is not a complete trade plan unless entry, stop-loss, targets and expiry are present.",
      "Provider freshness metadata is reported, but independent strict freshness gates are still required.",
      "Probe output discards market prices, event reasons and raw signal bodies."
    ]
  };
}
