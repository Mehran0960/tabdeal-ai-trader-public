#!/usr/bin/env node
import {appendFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {runTabdealSellAllBtc, safeTabdealSellSummary} from "../src/tabdeal-sell-all.js";

export async function runSellAllFromEnvironment(env = process.env, fetchImpl = fetch) {
  return runTabdealSellAllBtc({
    apiKey: env.TABDEAL_API_KEY,
    apiSecret: env.TABDEAL_API_SECRET,
    mode: env.TABDEAL_SELL_MODE || "dry_run",
    orderType: env.TABDEAL_SELL_ORDER_TYPE || "LIMIT",
    confirmLiveSell: env.TABDEAL_SELL_CONFIRM === "true",
    confirmedQuantity: env.TABDEAL_SELL_CONFIRM_QUANTITY || "",
    runId: env.GITHUB_RUN_ID,
    repository: env.GITHUB_REPOSITORY,
    commitSha: env.GITHUB_SHA,
    githubToken: env.GITHUB_TOKEN,
    fetchImpl
  });
}

async function main() {
  const report = await runSellAllFromEnvironment();
  const summary = safeTabdealSellSummary(report);
  console.log("TABDEAL_SELL_ALL_BTC_RESULT");
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const preflight = report.preflight;
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "## Tabdeal BTC-to-USDT sell workflow\n\n" +
      "- Result: **" + report.result + "**\n" +
      "- Mode: " + (report.mode ?? "unknown") + "\n" +
      "- Order submission: " + String(report.ordersSubmitted) + "\n" +
      "- Symbol / side: BTCUSDT / SELL\n" +
      "- Order type: " + (preflight.orderType ?? report.orderType ?? "unknown") + "\n" +
      (preflight ? (
        "- Free BTC: " + preflight.freeBtc + "\n" +
        "- Locked BTC: " + preflight.lockedBtc + "\n" +
        "- Sell quantity: " + preflight.sellQuantity + " BTC\n" +
        "- Step remainder: " + preflight.unsellableStepRemainderBtc + " BTC\n" +
        (preflight.orderType === "LIMIT"
          ? "- Limit price: " + preflight.limitPrice + " USDT\n"
          : "- Market slippage guard: " + preflight.minimumAcceptablePrice + " USDT\n") +
        "- Estimated gross proceeds: " + preflight.estimatedGrossQuote + " USDT\n" +
        "- Estimated fee: " + (preflight.estimatedFeeQuote ?? "not available") + " USDT\n" +
        "- Estimated net proceeds: " + (preflight.estimatedNetQuote ?? "not available") + " USDT\n" +
        "- Estimated slippage: " + preflight.estimatedSlippageBps + " bps\n"
      ) : "") +
      (report.order ? (
        "- Exchange order ID: " + report.order.orderId + "\n" +
        "- Exchange order status: " + report.order.status + "\n" +
        "- Executed BTC: " + (report.order.executedQuantity ?? "not returned") + "\n" +
        "- Cumulative USDT: " + (report.order.cumulativeQuoteQuantity ?? "not returned") + "\n"
      ) : "") +
      (report.reason ? "- Block reason: " + report.reason + "\n" : "") +
      "- Automatic retry: no\n" +
      "- Cancel / withdrawal / transfer: not attempted\n" +
      "- API credentials: never logged\n"
    , "utf8");
  }
  const successfulDryRun = report.result === "dry_run_passed_no_order_sent";
  const acceptedLive = report.ordersSubmitted === true &&
    ["sell_filled", "sell_partially_filled", "sell_order_accepted_not_fully_filled",
      "sell_reconciled_after_uncertain_post", "sell_reconciled_after_server_error"]
      .includes(report.result);
  if (!successfulDryRun && !acceptedLive) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error("TABDEAL_SELL_ALL_BTC_FATAL: " + String(error?.message || error).slice(0, 180));
    process.exitCode = 1;
  });
}
