#!/usr/bin/env node
import {mkdir,readFile,writeFile,access,readdir} from "node:fs/promises";
import path from "node:path";
import {appendFile} from "node:fs/promises";
import {runInternationalMarketCollection} from "../src/international-market-history.js";

function getArg(name,fallback) {
  const index=process.argv.indexOf(name);
  return index>=0?process.argv[index+1]??fallback:fallback;
}

const outputPath=getArg("--output",path.join("artifacts","international-market-history","latest.json"));
const historyDir=getArg("--history-dir",process.env.INTERNATIONAL_HISTORY_DIR||path.join("signal-history","data","international-market-history"));
const requestedMode=getArg("--mode","auto");
const backfillDays=Number(getArg("--backfill-days",process.env.INTERNATIONAL_BACKFILL_DAYS||365));
let historyPresent=false;
try {
  const files=await readdir(historyDir);
  historyPresent=files.some(name=>/^\d{4}-\d{2}\.jsonl$/.test(name));
} catch (error) {
  if (error?.code!=="ENOENT") throw error;
}
const report=await runInternationalMarketCollection({
  mode:requestedMode,
  historyPresent,
  backfillDays
});
await mkdir(path.dirname(outputPath),{recursive:true});
await writeFile(outputPath,JSON.stringify(report,null,2)+"\n","utf8");

const summary=[
  "## International market history capture",
  "",
  "- Mode: **"+report.mode+"**",
  "- Captured: "+report.capturedAt,
  "- Binance closed candles: "+report.summary.binanceCandles,
  "- Kraken closed candles: "+report.summary.krakenCandles,
  "- Tabdeal USDT books: "+report.summary.tabdealBooksOk+"/"+report.tabdealBooks.length,
  "- Cross-venue aligned candle comparisons: "+report.summary.crossVenueMatches,
  "- Source/series errors: "+report.sourceErrors.length,
  "- Orders submitted: 0",
  "- Live trading enabled: false",
  "",
  "This workflow collects research history only. It does not generate orders or approve a strategy."
].join("\n");

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,summary+"\n","utf8");
