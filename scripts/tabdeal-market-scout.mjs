#!/usr/bin/env node
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {runTabdealPublicMarketScout} from "../src/tabdeal-market-data.js";

export async function runTabdealMarketScout(options={}) {
  return runTabdealPublicMarketScout(options);
}

async function main() {
  const report = await runTabdealPublicMarketScout();
  const stamp=report.generatedAt.replace(/[:.]/g,"-");
  const outputPath=path.join("artifacts","tabdeal-market-data","tabdeal-public-market-"+stamp+".json");
  await mkdir(path.dirname(outputPath),{recursive:true});
  await writeFile(outputPath,JSON.stringify(report,null,2)+"\n","utf8");
  console.log("TABDEAL_PUBLIC_MARKET_SCOUT_COMPLETE");
  console.log(JSON.stringify({
    generatedAt:report.generatedAt,
    activeSpotMarketCount:report.activeSpotMarketCount,
    symbolsRequested:report.symbolsRequested.length,
    symbolsProcessed:report.summary.symbolsProcessed,
    validOrderbooks:report.summary.validOrderbooks,
    validTradeSnapshots:report.summary.validTradeSnapshots,
    tradeSnapshotsWithin60s:report.summary.tradeSnapshotsWithin60s,
    tradeSnapshotsOlderThan60s:report.summary.tradeSnapshotsOlderThan60s,
    tradeSnapshotsWithFutureTimestamp:report.summary.tradeSnapshotsWithFutureTimestamp,
    tradeFreshnessDiagnosticThresholdMs:report.summary.tradeFreshnessDiagnosticThresholdMs,
    cappedTradePages:report.summary.cappedTradePages,
    rejectedSymbols:report.rejected,
    outputPath,
    publicEndpointsOnly:report.safety.publicEndpointsOnly,
    apiKeyUsed:report.safety.apiKeyUsed,
    liveTradingEnabled:report.safety.liveTradingEnabled
  },null,2));
  if(!report.snapshots.length) throw new Error("tabdeal_public_market_no_snapshots");
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{
    console.error("TABDEAL_PUBLIC_MARKET_SCOUT_FAILED");
    console.error(String(error?.message||error).slice(0,180));
    process.exitCode=1;
  });
}
