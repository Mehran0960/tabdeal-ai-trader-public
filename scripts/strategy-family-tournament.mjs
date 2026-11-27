#!/usr/bin/env node
import {appendFile,readFile,readdir} from "node:fs/promises";
import {createReadStream} from "node:fs";
import readline from "node:readline";
import path from "node:path";
import {runStrategyFamilyTournament} from "../src/strategy-family-tournament.js";

function arg(name,fallback){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]??fallback:fallback;}
const historyDir=arg("--history-dir",path.join("signal-history","data","international-market-history"));
const universePath=arg("--universe",path.join("signal-history","data","dynamic-tabdeal-rotation-universe","latest-universe.json"));
const outputPath=arg("--output",path.join("artifacts","strategy-family-tournament","latest.json"));
let dynamicUniverse=null,requestedSymbols=null;
try{
  dynamicUniverse=JSON.parse(await readFile(universePath,"utf8"));
  if(!Array.isArray(dynamicUniverse?.markets))throw new Error("strategy_tournament_dynamic_universe_invalid");
  requestedSymbols=dynamicUniverse.markets.map(row=>String(row.symbol||"").toUpperCase())
    .filter(symbol=>/^[A-Z0-9]{2,30}$/.test(symbol));
  if(new Set(requestedSymbols).size!==requestedSymbols.length)throw new Error("strategy_tournament_dynamic_universe_duplicates");
}catch(error){
  if(error?.code!=="ENOENT")throw error;
  dynamicUniverse=null;
  requestedSymbols=null;
}
const requestedSet=requestedSymbols?new Set(requestedSymbols):null;
const files=(await readdir(historyDir)).filter(name=>/^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
if(!files.length)throw new Error("strategy_tournament_history_files_missing");
const rows=[];
let totalRecordsRead=0,eligibleCandlesRead=0;
for(const name of files){
  const input=createReadStream(path.join(historyDir,name),{encoding:"utf8"});
  const lines=readline.createInterface({input,crlfDelay:Infinity});
  let lineNumber=0;
  for await(const line of lines){
    lineNumber++;
    if(!line.trim())continue;
    totalRecordsRead++;
    let row;
    try{row=JSON.parse(line);}
    catch{throw new Error("strategy_tournament_history_corrupt_"+name+"_line_"+lineNumber);}
    if(row.recordType!=="candle"||row.provider!=="binance_spot"||
       row.interval!=="4h"||row.quoteAsset!=="USDT"||row.quoteUnit!=="USDT")continue;
    const symbol=String(row.symbol||"").toUpperCase();
    if(requestedSet&&!requestedSet.has(symbol))continue;
    rows.push(row);
    eligibleCandlesRead++;
  }
}
const report=runStrategyFamilyTournament({
  rows,symbols:requestedSymbols,dynamicUniverse
});
report.historyFilesRead=files.length;
report.historyRecordsRead=totalRecordsRead;
report.historyCandlesRead=eligibleCandlesRead;
report.dynamicUniverseManifest=dynamicUniverse?universePath:null;
await import("node:fs/promises").then(({mkdir,writeFile})=>
  mkdir(path.dirname(outputPath),{recursive:true}).then(()=>
    writeFile(outputPath,JSON.stringify(report,null,2)+"\n","utf8")));
const lines=[
  "## Tabdeal strategy-family tournament","",
  "- Status: **"+report.status+"**",
  "- Historical symbols: "+(report.history?.symbols||[]).join(", "),
  "- Selected symbol count: "+(report.history?.symbolCount??0),
  "- Synchronized 4h bars: "+(report.history?.latestContiguousBars??0),
  "- OOS bars: "+(report.history?.oosBars??0),
  "- Market manifest: "+(dynamicUniverse?"dynamic Tabdeal/Binance USDT Spot":"legacy history fallback"),
  "- Universe coverage complete: "+(report.universeCoverage?.coverageComplete??"not supplied"),
  "- Candidate markets in manifest: "+(report.universeCoverage?.selectedMarketCount??"n/a"),
  "- Paper review block: "+(report.paperReviewBlockReason||"none"),
  "- Model families: relative value, cross-sectional momentum, hybrid",
  "- Cost cases: base / moderate / severe",
  "- Paper enabled: no","- Live trading enabled: no","- Exchange orders placed: 0","","### Results"
];
for(const row of report.results||[]){
  lines.push("- "+row.strategyId+" / "+row.costScenario+
    ": net "+Number(row.totalReturnPct).toFixed(2)+"%; CAGR "+Number(row.cagrPct).toFixed(2)+
    "%; max DD "+Number(row.maxDrawdownPct).toFixed(2)+"%; equal-weight excess "+
    Number(row.excessVsEqualWeightPct).toFixed(2)+"%; switches "+row.switchCount+
    "; winning windows "+Number(row.outperformanceWindowRatePct).toFixed(1)+"%; q="+
    Number(row.fdrQValue).toFixed(4));
}
lines.push("","This is a fixed-parameter historical research screen. It does not initiate Paper or live trading.");
const summary=lines.join("\n");
console.log(summary);
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary+"\n","utf8");
