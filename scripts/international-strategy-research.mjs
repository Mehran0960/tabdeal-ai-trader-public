#!/usr/bin/env node
import {readdir,readFile,mkdir,writeFile,appendFile} from "node:fs/promises";
import path from "node:path";
import {runInternationalStrategyResearch} from "../src/international-strategy-research.js";
function arg(name,fallback){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]??fallback:fallback;}
const historyDir=arg("--history-dir",path.join("signal-history","data","international-market-history"));
const outputPath=arg("--output",path.join("artifacts","international-strategy-research","latest.json"));
const files=(await readdir(historyDir)).filter(name=>/^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
if(!files.length)throw new Error("international_research_history_month_files_missing");
const rows=[];
for(const name of files){
  const content=await readFile(path.join(historyDir,name),"utf8");
  for(const [index,line] of content.split(/\r?\n/).entries()){
    if(!line.trim())continue;
    try{rows.push(JSON.parse(line));}
    catch{throw new Error("international_research_jsonl_corrupt_"+name+"_line_"+(index+1));}
  }
}
const report=runInternationalStrategyResearch({rows});
await mkdir(path.dirname(outputPath),{recursive:true});
await writeFile(outputPath,JSON.stringify(report,null,2)+"\n","utf8");
const summaries=report.results.filter(row=>row.oos.available).sort((a,b)=>
  Number(b.oos.compoundedExcessReturnPct)-Number(a.oos.compoundedExcessReturnPct)).slice(0,8);
const lines=[
  "## International Spot strategy research","",
  "- Status: **"+report.status+"**",
  "- Historical records read: "+rows.length,
  "- Symbols with fresh and sufficiently long history: "+report.dataQuality.readySymbolCount+"/4",
  "- Fixed hypotheses evaluated: "+report.methodology.hypothesisCount,
  "- Research-only candidates: "+report.researchCandidates.length,
  "- Paper promotion allowed: no","- Exchange orders placed: 0","- Live trading enabled: false","",
  "### Best OOS research rows (not trade instructions)",
  ...summaries.map(row=>"- "+row.symbol+" / "+row.strategy+" / "+row.costScenario+
    ": net "+Number(row.oos.compoundedReturnPct).toFixed(2)+"%, vs benchmark "+
    Number(row.oos.compoundedExcessReturnPct).toFixed(2)+"%, windows beating benchmark "+
    Number(row.oos.outperformanceWindowRatePct).toFixed(1)+"%, BH q="+Number(row.qValue).toFixed(4)),
  "","This report uses public research data and provisional cost scenarios. It does not approve a strategy or create any exchange order."
];
const summary=lines.join("\n");
console.log(summary);
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary+"\n","utf8");
