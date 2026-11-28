#!/usr/bin/env node
import {createHmac} from "node:crypto";
import {appendFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";

// Recheck signed Spot POST permission; the probe payload below is intentionally invalid and cannot represent a valid order.
const API_BASE = "https://api1.tabdeal.org";
export const TABDEAL_POST_PROBE_SYMBOL = "ZZZPROBE20261127";
export const TABDEAL_POST_PROBE_CLIENT_ORDER_ID = "probe-invalid-no-order-20261127";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeApiCode(data) {
  return isRecord(data) && (typeof data.code === "number" || typeof data.code === "string")
    ? data.code : null;
}
function safeApiMessage(data) {
  if (!isRecord(data)) return null;
  const value = typeof data.msg === "string" ? data.msg
    : typeof data.message === "string" ? data.message : null;
  return value ? value.replace(/[\r\n\t]+/g, " ").slice(0, 180) : null;
}
function signedInvalidOrderBody(apiSecret, timestamp) {
  const params = new URLSearchParams({
    symbol: TABDEAL_POST_PROBE_SYMBOL,
    side: "__INVALID_SIDE__",
    type: "__INVALID_TYPE__",
    quantity: "0",
    price: "0",
    newClientOrderId: TABDEAL_POST_PROBE_CLIENT_ORDER_ID,
    timestamp: String(timestamp),
    recvWindow: "5000"
  });
  const signature = createHmac("sha256", apiSecret).update(params.toString(), "utf8").digest("hex");
  params.append("signature", signature);
  return params.toString();
}
async function readJsonResponse(response) {
  const raw = await response.text();
  if (raw.length > 100_000) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Sends exactly one signed POST containing an impossible order payload.
 * Preflight aborts if the deliberately invalid symbol appears in exchangeInfo.
 * No real market symbol, valid side/type, positive quantity, retry or cancellation is used.
 */
export async function runTabdealPostPermissionProbe({
  apiKey = process.env.TABDEAL_API_KEY,
  apiSecret = process.env.TABDEAL_API_SECRET,
  fetchImpl = fetch,
  clock = () => Date.now()
} = {}) {
  const checkedAt = new Date(clock()).toISOString();
  const credentialsPresent = {
    apiKey: typeof apiKey === "string" && apiKey.trim() !== "",
    apiSecret: typeof apiSecret === "string" && apiSecret.trim() !== ""
  };
  const base = {
    checkedAt,
    credentialsPresent,
    endpoint: "/api/v1/order",
    authenticationClass: "TRADE",
    probeSymbol: TABDEAL_POST_PROBE_SYMBOL,
    preflightPassed: false,
    postAttempted: false,
    validOrderPayloadSent: false,
    positiveQuantitySent: false,
    realMarketSymbolUsed: false,
    automaticRetry: false,
    ordersSubmitted: false,
    cancellationAttempted: false,
    fundsMoved: false,
    permissionConclusive: false
  };

  if (!credentialsPresent.apiKey || !credentialsPresent.apiSecret) {
    return {...base, result: "credentials_missing"};
  }
  if (typeof fetchImpl !== "function") return {...base, result: "fetch_unavailable"};

  let preflight;
  try {
    const response = await fetchImpl(API_BASE + "/r/api/v1/exchangeInfo", {
      method: "GET",
      headers: {accept: "application/json"},
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return {...base, result: "preflight_http_error", preflightHttpStatus: response.status};
    preflight = await readJsonResponse(response);
  } catch {
    return {...base, result: "preflight_network_error"};
  }

  const markets = Array.isArray(preflight) ? preflight
    : isRecord(preflight) && Array.isArray(preflight.symbols) ? preflight.symbols : null;
  if (!markets || markets.length === 0 || markets.length > 5_000 ||
      !markets.some(row => isRecord(row) && typeof row.symbol === "string")) {
    return {...base, result: "preflight_schema_unverified"};
  }
  const symbolListed = markets.some(row =>
    isRecord(row) && String(row.symbol || "").trim().toUpperCase() === TABDEAL_POST_PROBE_SYMBOL
  );
  if (symbolListed) {
    return {...base, result: "aborted_probe_symbol_exists", preflightPassed: false};
  }

  const timestamp = clock();
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return {...base, result: "invalid_local_clock", preflightPassed: true};
  }
  const body = signedInvalidOrderBody(apiSecret, timestamp);

  let response;
  let data;
  try {
    response = await fetchImpl(API_BASE + "/api/v1/order", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "X-MBX-APIKEY": apiKey
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8_000)
    });
    data = await readJsonResponse(response);
  } catch {
    return {
      ...base, preflightPassed: true, postAttempted: true,
      result: "post_outcome_unknown_network_or_signing_error"
    };
  }

  let result;
  if (response.status === 401 || response.status === 403) {
    result = "signed_post_explicitly_denied";
  } else if (response.status >= 500) {
    result = "post_server_error_unresolved";
  } else if (response.status === 429) {
    result = "post_rate_limited_unresolved";
  } else if (response.status >= 400 && response.status < 500 && response.status !== 404) {
    result = "signed_post_rejected_invalid_payload_permission_not_proven";
  } else if (response.status === 404) {
    result = "post_endpoint_or_permission_unresolved";
  } else if (response.status >= 200 && response.status < 300) {
    result = "unexpected_success_for_invalid_payload_manual_review_required";
  } else {
    result = "unexpected_http_response_unresolved";
  }

  return {
    ...base,
    preflightPassed: true,
    postAttempted: true,
    httpStatus: response.status,
    apiErrorCode: safeApiCode(data),
    apiMessage: safeApiMessage(data),
    result
  };
}

export function safeTabdealPostProbeSummary(report) {
  return {
    checkedAt: report.checkedAt,
    endpoint: report.endpoint,
    authenticationClass: report.authenticationClass,
    credentialsPresent: report.credentialsPresent,
    preflightPassed: report.preflightPassed,
    postAttempted: report.postAttempted,
    httpStatus: report.httpStatus ?? null,
    apiErrorCode: report.apiErrorCode ?? null,
    apiMessage: report.apiMessage ?? null,
    result: report.result,
    permissionConclusive: false,
    validOrderPayloadSent: false,
    positiveQuantitySent: false,
    realMarketSymbolUsed: false,
    automaticRetry: false,
    ordersSubmitted: false,
    cancellationAttempted: false,
    fundsMoved: false,
    signingMaterialLogged: false,
    responseOrderDetailsLogged: false
  };
}

async function main() {
  const report = await runTabdealPostPermissionProbe();
  const summary = safeTabdealPostProbeSummary(report);
  console.log("TABDEAL_SIGNED_POST_NEGATIVE_PROBE");
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "## Tabdeal signed POST negative-payload probe\n\n" +
      "- Result: **" + report.result + "**\n" +
      "- Preflight: " + (report.preflightPassed ? "passed" : "not passed") + "\n" +
      "- Signed POST attempted: " + (report.postAttempted ? "yes" : "no") + "\n" +
      "- HTTP status: " + (report.httpStatus ?? "not returned") + "\n" +
      "- API error code: " + (report.apiErrorCode ?? "not returned") + "\n" +
      "- Permission conclusively proven: **no**\n" +
      "- Valid order payload, real symbol, positive quantity: **not sent**\n" +
      "- Order, cancellation, or funds movement: **not performed**\n"
    );
  }
  if ([
    "credentials_missing", "fetch_unavailable", "preflight_http_error",
    "preflight_network_error", "preflight_schema_unverified",
    "aborted_probe_symbol_exists", "invalid_local_clock",
    "post_outcome_unknown_network_or_signing_error",
    "post_server_error_unresolved", "post_rate_limited_unresolved",
    "post_endpoint_or_permission_unresolved",
    "unexpected_success_for_invalid_payload_manual_review_required",
    "unexpected_http_response_unresolved"
  ].includes(report.result)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error("TABDEAL_SIGNED_POST_NEGATIVE_PROBE_FAILED");
    console.error(String(error?.message || error).slice(0, 160));
    process.exitCode = 1;
  });
}
