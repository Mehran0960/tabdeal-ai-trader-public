import {appendFile, mkdir, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {runDomesticExchangeProbe} from "../src/domestic-exchange-probe.js";

const outputPath = "artifacts/domestic-exchange-probe/latest.json";
const report = await runDomesticExchangeProbe();
await mkdir(dirname(outputPath), {recursive: true});
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");

const rows = report.providers.map(provider => {
  const minQty = provider.minimumBaseQuantityBtc ??
    provider.spot?.minimumBaseQuantityBtc ??
    provider.otc?.minimumBaseQuantityBtc;
  const minNotional = provider.minimumQuoteNotionalUsdt ??
    provider.spot?.minimumQuoteNotionalUsdt ??
    provider.otc?.minimumQuoteNotionalUsdt;
  const book = provider.book ?? provider.spot?.book ?? provider.otc?.book;
  const meets = provider.referenceQuantityMeetsKnownMinimum ??
    provider.spot?.referenceQuantityMeetsKnownMinimum ??
    provider.otc?.referenceQuantityMeetsKnownMinimum;
  return "| " + provider.provider + " | " +
    (provider.marketListed ? "yes" : "no/unknown") + " | " +
    (minQty ?? "unknown") + " BTC | " +
    (minNotional ?? "unknown") + " USDT | " +
    (book?.spreadBps === null || book?.spreadBps === undefined ? "unknown" : book.spreadBps.toFixed(2) + " bps") + " | " +
    (book?.status ?? "unavailable") + " | " +
    (meets === null || meets === undefined ? "unknown" : meets ? "yes" : "no") + " |";
}).join("\n");

const summary = [
  "## Domestic exchange public API comparison",
  "",
  "- Captured: " + report.capturedAt,
  "- Mode: unauthenticated public GET only",
  "- Reference quantity: " + report.comparisonQuantityBtc + " BTC (illustrative; previous preflight quantity, not a current balance read)",
  "",
  "| Venue | BTC/USDT listed | Min base quantity | Min quote notional | Spread | Book depth | Reference quantity meets known minimum? |",
  "|---|---:|---:|---:|---:|---|---:|",
  rows,
  "",
  "No private endpoints, API keys, order submission, cancellations, transfers or withdrawals were used."
].join("\n");

console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n", "utf8");
}
