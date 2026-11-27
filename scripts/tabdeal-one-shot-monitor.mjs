#!/usr/bin/env node
import {createHmac} from "node:crypto";
import {appendFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";

const API_BASE = "https://api1.tabdeal.org";
const SYMBOL = "BTCUSDT";
const CLIENT_ORDER_ID = "t1shot-btcusdt-20261127";
const ORDER_LOCK_REF = "refs/tags/tabdeal-one-shot-1usdt-20261127";
const MONITOR_DONE_REF = "refs/tags/tabdeal-one-shot-monitor-complete-20261127";
const RECV_WINDOW_MS = 5_000;
const TERMINAL_STATUSES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"]);

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
  const body = await response.text();
  if (body.length > 500_000) throw new Error("response_too_large");
  try { return JSON.parse(body); } catch { throw new Error("response_not_json"); }
}
async function getGitRef({token, repository, ref, fetchImpl}) {
  const tagPath = encodeURIComponent(ref.slice("refs/tags/".length));
  const response = await fetchImpl(
    "https://api.github.com/repos/" + repository + "/git/ref/tags/" + tagPath,
    {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      redirect: "error",
      signal: AbortSignal.timeout(8_000)
    }
  );
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("github_ref_read_http_" + response.status);
  return true;
}
async function markMonitorComplete({token, repository, commitSha, fetchImpl}) {
  if (await getGitRef({token, repository, ref: MONITOR_DONE_REF, fetchImpl})) {
    return "already_complete";
  }
  const response = await fetchImpl(
    "https://api.github.com/repos/" + repository + "/git/refs",
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        "content-type": "application/json"
      },
      body: JSON.stringify({ref: MONITOR_DONE_REF, sha: commitSha}),
      redirect: "error",
      signal: AbortSignal.timeout(8_000)
    }
  );
  if (response.status === 201 || response.status === 422) return "complete";
  throw new Error("github_monitor_completion_http_" + response.status);
}
async function readOrder({apiKey, apiSecret, fetchImpl}) {
  const params = signParams({
    symbol: SYMBOL,
    origClientOrderId: CLIENT_ORDER_ID,
    timestamp: Date.now(),
    recvWindow: RECV_WINDOW_MS
  }, apiSecret);
  const response = await fetchImpl(
    API_BASE + "/r/api/v1/order?" + params.toString(),
    {
      method: "GET",
      headers: {accept: "application/json", "X-MBX-APIKEY": apiKey},
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    }
  );
  const data = await readJson(response);
  if (response.status === 404 && isRecord(data) && Number(data.code) === 1204) return null;
  if (!response.ok) throw new Error("tabdeal_order_lookup_http_" + response.status);
  if (!isRecord(data) || data.orderId === undefined || data.orderId === null) {
    throw new Error("tabdeal_order_lookup_schema_invalid");
  }
  return {
    orderId: String(data.orderId),
    clientOrderId: String(data.clientOrderId || CLIENT_ORDER_ID),
    symbol: typeof data.symbol === "string" ? data.symbol : SYMBOL,
    side: typeof data.side === "string" ? data.side : "BUY",
    type: typeof data.type === "string" ? data.type : null,
    status: typeof data.status === "string" ? data.status.toUpperCase() : "UNKNOWN",
    originalQuantity: data.origQty === undefined ? null : String(data.origQty),
    executedQuantity: data.executedQty === undefined ? null : String(data.executedQty),
    cumulativeQuoteQuantity: data.cummulativeQuoteQty === undefined && data.cumulativeQuoteQty === undefined
      ? null : String(data.cummulativeQuoteQty ?? data.cumulativeQuoteQty),
    isWorking: typeof data.isWorking === "boolean" ? data.isWorking : null,
    updateTime: Number.isSafeInteger(Number(data.updateTime)) ? Number(data.updateTime) : null
  };
}
export async function runTabdealOneShotMonitor({
  apiKey = process.env.TABDEAL_API_KEY,
  apiSecret = process.env.TABDEAL_API_SECRET,
  token = process.env.GITHUB_TOKEN,
  repository = process.env.GITHUB_REPOSITORY,
  commitSha = process.env.GITHUB_SHA,
  fetchImpl = fetch
} = {}) {
  const checkedAt = new Date().toISOString();
  if (typeof apiKey !== "string" || !apiKey.trim() ||
      typeof apiSecret !== "string" || !apiSecret.trim() ||
      typeof token !== "string" || !token.trim() ||
      typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      typeof commitSha !== "string" || !/^[a-f0-9]{40}$/i.test(commitSha)) {
    return {checkedAt, result: "monitor_configuration_missing", complete: false};
  }
  try {
    if (await getGitRef({token, repository, ref: MONITOR_DONE_REF, fetchImpl})) {
      return {checkedAt, result: "monitor_already_complete", complete: true};
    }
    const orderLockExists = await getGitRef({token, repository, ref: ORDER_LOCK_REF, fetchImpl});
    if (!orderLockExists) {
      return {checkedAt, result: "one_shot_not_started", complete: false};
    }
    const order = await readOrder({apiKey, apiSecret, fetchImpl});
    if (!order) {
      await markMonitorComplete({token, repository, commitSha, fetchImpl});
      return {checkedAt, result: "order_not_found_monitor_complete", complete: true};
    }
    if (TERMINAL_STATUSES.has(order.status)) {
      await markMonitorComplete({token, repository, commitSha, fetchImpl});
      return {checkedAt, result: "order_terminal_monitor_complete", complete: true, order};
    }
    return {checkedAt, result: "order_still_open_monitoring", complete: false, order};
  } catch (error) {
    return {
      checkedAt,
      result: "monitor_read_error",
      complete: false,
      error: String(error?.message || error).replace(/[\r\n\t]+/g, " ").slice(0, 160)
    };
  }
}
async function main() {
  const report = await runTabdealOneShotMonitor();
  console.log("TABDEAL_ONE_SHOT_MONITOR");
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "## Tabdeal one-shot order monitor\n\n" +
      "- Result: **" + report.result + "**\n" +
      "- Checked at: " + report.checkedAt + "\n" +
      (report.order ? "- Order ID: " + report.order.orderId + "\n" +
        "- Status: " + report.order.status + "\n" +
        "- Filled base quantity: " + (report.order.executedQuantity ?? "not reported") + "\n" +
        "- Quote executed: " + (report.order.cumulativeQuoteQuantity ?? "not reported") + "\n" : "") +
      "- Read-only: yes\n- New orders/cancellations/transfers: none\n"
    );
  }
  if (report.result === "monitor_read_error" || report.result === "monitor_configuration_missing") {
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error("TABDEAL_ONE_SHOT_MONITOR_FAILED: " + String(error?.message || error).slice(0, 160));
    process.exitCode = 1;
  });
}
