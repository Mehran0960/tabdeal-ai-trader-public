#!/usr/bin/env node
import {appendFile,readFile,readdir,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {runStrategyFamilyTournament} from "../src/strategy-family-tournament.js";
function arg(name,fallback){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]??fallback:fallback;}
const historyDir=arg("--history-dir",path.join("signal-history","data","international-market-history"));
const outputPath=arg("--output",path.join("artifacts","strategy-family-tournament","latest.json"));
const files=(await readdir(historyDir)).filter(name=>/^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
if(!files.length)throw new Error("strategy_tournament_history_files_missing");
const rows=[];
for(const name of files){
  const content=await readFile(path.join(historyDir,name),"utf8");
  for(const [index,line] of content.split(/\r?\n/).entries()){
    if(!line.trim())continue;
    try{rows.push(JSON.parse(line));}
    catch{throw new Error("strategy_tournament_history_corrupt_"+name+"_line_"+(index+1));}
  }
}
const report=runStrategyFamilyTournament({rows});
await mkdir(path.dirname(outputPath),{recursive:true});
await writeFile(outputPath,JSON.stringify(report,null,2)+"\n","utf8");
const lines=[
  "## Tabdeal strategy-family tournament","",
  "- Status: **"+report.status+"**",
  "- Historical symbols: "+(report.history?.symbols||[]).join(", "),
  "- Aligned 4h bars: "+(report.history?.latestContiguousBars??0),
  "- OOS bars: "+(report.history?.oosBars??0),
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
