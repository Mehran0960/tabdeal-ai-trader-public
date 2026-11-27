#!/usr/bin/env node
import {appendFile,mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {
  runRelativeAssetRotationResearch,applyRelativeRotationPaperTick,ROTATION_POLICY
} from "../src/relative-asset-rotation.js";

function arg(name,fallback){
  const index=process.argv.indexOf(name);
  return index>=0?process.argv[index+1]??fallback:fallback;
}
function fail(code){throw new Error(code);}
async function readHistory(historyDir){
  const files=(await readdir(historyDir)).filter(name=>/^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  if(!files.length)fail("rotation_history_month_files_missing");
  const rows=[];
  for(const name of files){
    const content=await readFile(path.join(historyDir,name),"utf8");
    for(const [index,line] of content.split(/\r?\n/).entries()){
      if(!line.trim())continue;
      try{rows.push(JSON.parse(line));}
      catch{fail("rotation_history_jsonl_corrupt_"+name+"_line_"+(index+1));}
    }
  }
  return {rows,filesRead:files.length};
}
async function readState(statePath){
  try{
    const content=await readFile(statePath,"utf8");
    return JSON.parse(content);
  }catch(error){
    if(error?.code==="ENOENT")return null;
    throw error;
  }
}
async function main(){
  const historyDir=arg("--history-dir",path.join("signal-history","data","international-market-history"));
  const statePath=arg("--state",path.join("signal-history","data","relative-asset-rotation","state.json"));
  const outputPath=arg("--output",path.join("artifacts","relative-asset-rotation","latest.json"));
  const runId=process.env.GITHUB_RUN_ID||"local";
  const runAttempt=Number(process.env.GITHUB_RUN_ATTEMPT||1);
  const nowMs=Date.now();
  const {rows,filesRead}=await readHistory(historyDir);
  const report=runRelativeAssetRotationResearch({rows,nowMs});
  let state=await readState(statePath);
  let paperTick=null;
  if(report.available){
    paperTick=applyRelativeRotationPaperTick({report,state,nowMs,runId,runAttempt});
    state=paperTick.state;
    if(paperTick.changed){
      await mkdir(path.dirname(statePath),{recursive:true});
      await writeFile(statePath,JSON.stringify(state,null,2)+"\n","utf8");
    }
  }
  const output={
    ...report,
    history:{filesRead,recordsRead:rows.length},
    forwardPaper:paperTick?{
      changed:paperTick.changed,reason:paperTick.reason,
      events:paperTick.events,
      state:{
        initialCapitalUsdt:state.initialCapitalUsdt,
        cashBalance:state.cashBalance,
        position:state.position,
        lastEquityUsdt:state.lastEquityUsdt??state.initialCapitalUsdt,
        maxDrawdownPct:state.maxDrawdownPct??0,
        tradeCount:state.tradeCount??0,
        haltedByDrawdown:state.haltedByDrawdown??false,
        lastProcessedSignalOpenTimeMs:state.lastProcessedSignalOpenTimeMs??0
      },
      liveTradingEnabled:false,exchangeOrdersPlaced:0,fundsMoved:false
    }:{
      changed:false,reason:report.reason||"historical_report_unavailable",
      statePresent:Boolean(state),liveTradingEnabled:false,exchangeOrdersPlaced:0,fundsMoved:false
    },
    safety:{
      publicHistoryOnly:true,accountDataRead:false,privateCredentialsUsed:false,
      privateExchangeEndpointsUsed:false,exchangeOrdersPlaced:0,fundsMoved:false,
      leverageUsed:false,shortSellingUsed:false,liveTradingEnabled:false
    }
  };
  await mkdir(path.dirname(outputPath),{recursive:true});
  await writeFile(outputPath,JSON.stringify(output,null,2)+"\n","utf8");
  const summaries=report.available?report.costScenarios.map(row=>
    "- "+row.costScenario+": holdout "+Number(row.untouchedHoldout.totalReturnPct).toFixed(2)+
    "%; equal-weight "+Number(row.untouchedHoldout.equalWeightBuyHoldReturnPct).toFixed(2)+
    "%; BTC "+Number(row.untouchedHoldout.btcBuyHoldReturnPct).toFixed(2)+
    "%; max DD "+Number(row.untouchedHoldout.maxDrawdownPct).toFixed(2)+
    "%; rotations "+row.untouchedHoldout.rotationCount
  ):["- Research unavailable: "+(report.reason||"unknown")];
  const lines=[
    "## Relative-asset rotation research and forward Paper",
    "",
    "- Research status: **"+(report.status||"data_not_ready")+"**",
    "- History files: "+filesRead+"; records: "+rows.length,
    "- Universe: "+(report.universe||[]).join(", "),
    "- Closed-candle interval: 4h; signal data: Binance Spot; execution context: Tabdeal Spot",
    "- Untouched holdout results:",
    ...summaries,
    "- Promotion gate: **"+(report.promotionGate?.status||"BLOCKED")+"**",
    "- Forward Paper: "+(paperTick?.reason||report.reason||"not run"),
    "- Paper cash: "+(state?.cashBalance??"not initialized")+" USDT",
    "- Paper held asset: "+(state?.position?.symbol??"none"),
    "- Maximum drawdown stop: "+ROTATION_POLICY.maximumDrawdownPct+"%",
    "- Exchange orders placed: 0",
    "- Funds moved: no",
    "- Live trading enabled: no",
    "",
    "This workflow is research and virtual execution only. Binance candles are signal inputs, not Tabdeal execution prices. Paper fills require fresh Tabdeal local top-five books and provisional fee assumptions."
  ];
  const summary=lines.join("\n");
  console.log("RELATIVE_ASSET_ROTATION_COMPLETE");
  console.log(JSON.stringify({
    reportPath:outputPath,
    status:report.status??"data_not_ready",
    promotionGate:report.promotionGate??null,
    latestSignal:report.latestSignal??null,
    localExecutionReadiness:report.localExecutionReadiness?{
      allFiveBooksReady:report.localExecutionReadiness.allFiveBooksReady,
      forwardPaperEligible:report.localExecutionReadiness.forwardPaperEligible,
      reason:report.localExecutionReadiness.reason
    }:null,
    forwardPaper:output.forwardPaper,
    exchangeOrdersPlaced:0,liveTradingEnabled:false
  },null,2));
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary+"\n","utf8");
  if(!report.available)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{
    console.error("RELATIVE_ASSET_ROTATION_FAILED");
    console.error(String(error?.message||error).slice(0,200));
    process.exitCode=1;
  });
}
