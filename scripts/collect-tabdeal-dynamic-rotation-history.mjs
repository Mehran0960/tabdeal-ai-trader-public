#!/usr/bin/env node
import {appendFile,mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {createReadStream} from "node:fs";
import readline from "node:readline";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {runTabdealDynamicRotationHistoryCapture} from "../src/tabdeal-dynamic-rotation-history.js";
import {appendInternationalMarketSnapshot} from "./append-international-market-history.mjs";

function arg(name,fallback){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]??fallback:fallback;}
async function rebuildLatestIndex(historyDir){
  const latest={};
  let files=[];
  try{files=(await readdir(historyDir)).filter(name=>/^\d{4}-\d{2}\.jsonl$/.test(name)).sort();}
  catch(error){if(error?.code!=="ENOENT")throw error;}
  for(const name of files){
    const input=createReadStream(path.join(historyDir,name),{encoding:"utf8"});
    const lines=readline.createInterface({input,crlfDelay:Infinity});
    for await(const line of lines){
      if(!line.trim())continue;
      let row;
      try{row=JSON.parse(line);}catch{throw new Error("dynamic_history_existing_jsonl_corrupt_"+name);}
      if(row.recordType!=="candle"||row.provider!=="binance_spot"||row.interval!=="4h"||
         row.quoteUnit!=="USDT"||typeof row.symbol!=="string")continue;
      const time=Number(row.openTimeMs);
      if(Number.isSafeInteger(time)&&time>0)latest[row.symbol]=Math.max(latest[row.symbol]||0,time);
    }
  }
  return latest;
}
async function main(){
  const historyDir=arg("--history-dir",path.join("signal-history","data","international-market-history"));
  const stateDir=arg("--state-dir",path.join("signal-history","data","dynamic-tabdeal-rotation-universe"));
  const outputPath=arg("--output",path.join("artifacts","tabdeal-dynamic-rotation-history","latest.json"));
  const maxMarkets=Number(arg("--max-markets","300"));
  const backfillDays=Number(arg("--backfill-days","730"));
  await mkdir(stateDir,{recursive:true});
  const indexPath=path.join(stateDir,"candle-index.json");
  let latestOpenTimeBySymbol={},indexSource="existing_index";
  try{
    const index=JSON.parse(await readFile(indexPath,"utf8"));
    if(index?.schemaVersion!==1||typeof index.latestOpenTimeBySymbol!=="object"||
       index.latestOpenTimeBySymbol===null)throw new Error("dynamic_history_index_invalid");
    latestOpenTimeBySymbol=index.latestOpenTimeBySymbol;
  }catch(error){
    if(error?.code!=="ENOENT")throw error;
    latestOpenTimeBySymbol=await rebuildLatestIndex(historyDir);
    indexSource="rebuilt_from_existing_history";
  }
  const capture=await runTabdealDynamicRotationHistoryCapture({
    latestOpenTimeBySymbol,maxMarkets,backfillDays
  });
  const snapshotPath=path.join(path.dirname(outputPath),"internal-snapshot.json");
  await mkdir(path.dirname(outputPath),{recursive:true});
  await writeFile(snapshotPath,JSON.stringify(capture.snapshot)+"\n","utf8");
  const appendResult=await appendInternationalMarketSnapshot({
    inputPath:snapshotPath,historyDir
  });
  const nextIndex={
    schemaVersion:1,updatedAt:new Date().toISOString(),
    latestOpenTimeBySymbol:capture.latestOpenTimeBySymbol
  };
  await writeFile(indexPath,JSON.stringify(nextIndex,null,2)+"\n","utf8");
  const universePath=path.join(stateDir,"latest-universe.json");
  await writeFile(universePath,JSON.stringify({
    schemaVersion:1,generatedAt:capture.snapshot.capturedAt,
    ...capture.universe,
    source:"tabdeal_active_spot_intersection_binance_spot_usdt",
    historyCoveragePolicy:{
      interval:"4h",backfillDays,minimumBarsForTournament:2000,
      latestOpenTimeBySymbol:capture.latestOpenTimeBySymbol
    }
  },null,2)+"\n","utf8");
  const report={
    schemaVersion:1,reportType:"TABDEAL_DYNAMIC_ROTATION_HISTORY_CAPTURE",
    generatedAt:capture.snapshot.capturedAt,
    snapshotId:capture.snapshot.snapshotId,
    universe:{
      status:capture.universe.status,
      coverageComplete:capture.universe.coverageComplete,
      eligibleBeforeCap:capture.universe.eligibleBeforeCap,
      selectedMarketCount:capture.universe.selectedMarketCount,
      omittedBySafetyCap:capture.universe.omittedBySafetyCap,
      minimumQuoteVolumeUsdt:capture.universe.minimumQuoteVolumeUsdt,
      minimumTradeCount24h:capture.universe.minimumTradeCount24h,
      excluded:capture.universe.excluded,
      markets:capture.universe.markets.map(row=>({
        symbol:row.symbol,baseAsset:row.baseAsset,quoteVolumeUsdt:row.quoteVolumeUsdt,
        tradeCount24h:row.tradeCount24h,marketRulesReady:row.marketRules.ready
      }))
    },
    collection:capture.summary,
    collectionCounts:capture.counts,
    sourceErrors:capture.sourceErrors,
    historyAppend:appendResult,
    historyIndexSource:indexSource,
    safety:capture.safety,
    limitations:[
      "This collector covers the active Tabdeal/Binance cross-listed USDT Spot intersection, not every Tabdeal Spot symbol.",
      "Binance 24h turnover is a discovery liquidity proxy and is not local Tabdeal execution liquidity.",
      "Historical signals use Binance candles; Tabdeal books are local snapshots. No external candle price is used as a Tabdeal fill.",
      "Order-book sequence semantics, account-specific fees and partial-fill behavior remain unverified.",
      "Symbols need at least 2,000 synchronized contiguous 4h bars before they can qualify for the strategy tournament."
    ]
  };
  await writeFile(outputPath,JSON.stringify(report,null,2)+"\n","utf8");
  const lines=[
    "## Dynamic Tabdeal Spot market-history capture","",
    "- Universe: **"+report.universe.status+"**",
    "- Eligible before cap: "+report.universe.eligibleBeforeCap,
    "- Selected markets: "+report.universe.selectedMarketCount,
    "- Coverage complete: "+report.universe.coverageComplete,
    "- New/updated Binance candles: "+appendResult.appendedRecordCount,
    "- Valid Tabdeal local books: "+capture.summary.validTabdealBooks,
    "- Source errors: "+capture.sourceErrors.length,
    "- Duplicate history records skipped: "+appendResult.duplicateRecordCount,
    "- Exchange orders placed: 0",
    "- Live trading enabled: false","",
    "History-only capture; no account data, private endpoints or exchange orders."
  ].join("\n");
  console.log(lines);
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,lines+"\n","utf8");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{
    console.error("TABDEAL_DYNAMIC_ROTATION_HISTORY_FAILED");
    console.error(String(error?.message||error).slice(0,200));
    process.exitCode=1;
  });
}
