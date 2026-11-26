import {backtestLongOnly,rollingOutOfSampleBacktest} from "./research.js";

export const INTERNATIONAL_RESEARCH_POLICY=Object.freeze({
  provider:"binance_spot",interval:"4h",resolutionSeconds:14_400,
  symbols:Object.freeze(["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT"]),
  discoveryFraction:0.8,holdoutWarmupBars:60,trainBars:250,testBars:30,stepBars:30,
  minimumWindows:60,maximumLatestCandleAgeMs:12*60*60*1000,
  riskFraction:0.0025,maxExposureFraction:0.2,stopAtrMultiple:2.5,maxDrawdownStop:0.1,
  initialCapital:10_000,minimumTrades:20,minimumOutperformanceWindowRatePct:60,
  maximumWorstWindowDrawdownPct:1,minimumSevereStressReturnPct:1,maximumFdrQValue:0.05
});
export const INTERNATIONAL_COST_SCENARIOS=Object.freeze([
  Object.freeze({id:"base",feeBpsPerSide:10,slippageBpsPerSide:10}),
  Object.freeze({id:"moderate",feeBpsPerSide:20,slippageBpsPerSide:25}),
  Object.freeze({id:"severe",feeBpsPerSide:35,slippageBpsPerSide:50})
]);
export const INTERNATIONAL_STRATEGIES=Object.freeze(["ema-trend","donchian-breakout","rsi-mean-reversion"]);
const intervalMs=INTERNATIONAL_RESEARCH_POLICY.resolutionSeconds*1000;
const allowedSymbols=new Set(INTERNATIONAL_RESEARCH_POLICY.symbols);
const finitePositive=value=>Number.isFinite(Number(value))&&Number(value)>0;
const finiteNonNegative=value=>Number.isFinite(Number(value))&&Number(value)>=0;
const isRecord=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
function fail(code){throw new Error(code);}
function sameCandle(a,b){
  return ["openTimeMs","closeTimeMs","open","high","low","close","baseVolume","quoteVolume","tradeCount"]
    .every(key=>a[key]===b[key]);
}
export function normalizeInternationalResearchRows(rows,{nowMs=Date.now()}={}){
  if(!Array.isArray(rows)||!Number.isSafeInteger(nowMs))fail("international_research_rows_or_clock_invalid");
  const bySymbol=new Map(INTERNATIONAL_RESEARCH_POLICY.symbols.map(symbol=>[symbol,new Map()]));
  let ignoredRecordCount=0,duplicateCount=0;
  for(const row of rows){
    if(!isRecord(row))fail("international_research_record_invalid");
    if(row.recordType!=="candle"||row.provider!==INTERNATIONAL_RESEARCH_POLICY.provider||
       row.interval!==INTERNATIONAL_RESEARCH_POLICY.interval||!allowedSymbols.has(String(row.symbol||"").toUpperCase())){
      ignoredRecordCount++;continue;
    }
    const symbol=String(row.symbol).toUpperCase(),base=symbol.slice(0,-4);
    const openTimeMs=Number(row.openTimeMs),closeTimeMs=Number(row.closeTimeMs);
    const candle={
      provider:row.provider,symbol,baseAsset:String(row.baseAsset||"").toUpperCase(),
      quoteAsset:String(row.quoteAsset||"").toUpperCase(),quoteUnit:String(row.quoteUnit||"").toUpperCase(),
      interval:row.interval,openTimeMs,closeTimeMs,
      open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),
      baseVolume:Number(row.baseVolume),quoteVolume:row.quoteVolume===null?null:Number(row.quoteVolume),
      tradeCount:Number(row.tradeCount)
    };
    if(candle.baseAsset!==base||candle.quoteAsset!=="USDT"||candle.quoteUnit!=="USDT"||
       !Number.isSafeInteger(openTimeMs)||!Number.isSafeInteger(closeTimeMs)||
       openTimeMs<=0||openTimeMs%intervalMs!==0||closeTimeMs!==openTimeMs+intervalMs-1||
       closeTimeMs>=nowMs||![candle.open,candle.high,candle.low,candle.close].every(finitePositive)||
       !finiteNonNegative(candle.baseVolume)||
       !(candle.quoteVolume===null||finiteNonNegative(candle.quoteVolume))||
       !Number.isSafeInteger(candle.tradeCount)||candle.tradeCount<0||
       candle.high<Math.max(candle.open,candle.close,candle.low)||
       candle.low>Math.min(candle.open,candle.close,candle.high)){
      fail("international_research_candle_invalid_"+symbol);
    }
    const map=bySymbol.get(symbol),prior=map.get(openTimeMs);
    if(prior){
      if(!sameCandle(prior,candle))fail("international_research_conflicting_duplicate_"+symbol);
      duplicateCount++;continue;
    }
    map.set(openTimeMs,candle);
  }
  const candlesBySymbol={},qualityBySymbol={};
  for(const [symbol,map] of bySymbol){
    const ordered=[...map.values()].sort((a,b)=>a.openTimeMs-b.openTimeMs);
    let gapCount=0,maxGapIntervals=1;
    for(let i=1;i<ordered.length;i++){
      const gap=(ordered[i].openTimeMs-ordered[i-1].openTimeMs)/intervalMs;
      if(gap>1){gapCount++;maxGapIntervals=Math.max(maxGapIntervals,gap);}
    }
    const latest=ordered.at(-1)||null,latestClosedAtMs=latest?latest.closeTimeMs+1:null;
    const latestAgeMs=latest?nowMs-latestClosedAtMs:null;
    candlesBySymbol[symbol]=ordered.map(row=>({
      time:Math.floor(row.openTimeMs/1000),open:row.open,high:row.high,low:row.low,
      close:row.close,volume:row.baseVolume
    }));
    qualityBySymbol[symbol]={
      candleCount:ordered.length,gapCount,maximumGapIntervals:maxGapIntervals,
      firstOpenTime:ordered[0]?new Date(ordered[0].openTimeMs).toISOString():null,
      latestOpenTime:latest?new Date(latest.openTimeMs).toISOString():null,
      latestClosedAt:latest?new Date(latestClosedAtMs).toISOString():null,
      latestClosedAgeMs:latestAgeMs,
      fresh:latestAgeMs!==null&&latestAgeMs>=0&&latestAgeMs<=INTERNATIONAL_RESEARCH_POLICY.maximumLatestCandleAgeMs
    };
  }
  return {candlesBySymbol,qualityBySymbol,ignoredRecordCount,duplicateCount,
    selectedRecordCount:Object.values(qualityBySymbol).reduce((sum,item)=>sum+item.candleCount,0)};
}
export function exactBinomialUpperTail(wins,total){
  if(!Number.isSafeInteger(wins)||!Number.isSafeInteger(total)||total<0||wins<0||wins>total||total>512){
    fail("international_research_binomial_input_invalid");
  }
  if(total===0||wins===0)return 1;
  let term=2**(-total),tail=0;
  for(let k=0;k<=total;k++){if(k>=wins)tail+=term;if(k<total)term*=((total-k)/(k+1));}
  return Math.min(1,Math.max(0,tail));
}
export function benjaminiHochbergAdjust(hypotheses){
  if(!Array.isArray(hypotheses))fail("international_research_hypotheses_invalid");
  const ordered=hypotheses.map((item,index)=>({
    index,id:String(item.id??index),
    pValue:Number.isFinite(Number(item.pValue))?Math.min(1,Math.max(0,Number(item.pValue))):1
  })).sort((a,b)=>a.pValue-b.pValue||a.id.localeCompare(b.id));
  const adjusted=new Array(ordered.length);let running=1;
  for(let index=ordered.length-1;index>=0;index--){
    running=Math.min(running,ordered[index].pValue*ordered.length/(index+1),1);
    adjusted[ordered[index].index]=running;
  }
  return hypotheses.map((item,index)=>({id:String(item.id??index),qValue:adjusted[index]}));
}
function costOptions(scenario,strategy){
  return {strategy,initialCapital:INTERNATIONAL_RESEARCH_POLICY.initialCapital,
    feeBps:scenario.feeBpsPerSide,slippageBps:scenario.slippageBpsPerSide,
    resolutionSeconds:INTERNATIONAL_RESEARCH_POLICY.resolutionSeconds,
    riskFraction:INTERNATIONAL_RESEARCH_POLICY.riskFraction,
    maxExposureFraction:INTERNATIONAL_RESEARCH_POLICY.maxExposureFraction,
    stopAtrMultiple:INTERNATIONAL_RESEARCH_POLICY.stopAtrMultiple,
    maxDrawdownStop:INTERNATIONAL_RESEARCH_POLICY.maxDrawdownStop};
}
function summarizeOos(result){
  if(!result||result.available!==true)return {
    available:false,reason:result?.reason||"out_of_sample_unavailable",
    candleCount:Number(result?.candleCount||0),windowCount:Number(result?.windowCount||0),
    minimumWindowsRequired:INTERNATIONAL_RESEARCH_POLICY.minimumWindows,exchangeOrdersPlaced:0
  };
  const windows=Array.isArray(result.windows)?result.windows:[];
  const wins=windows.filter(row=>Number(row.excessReturnPct)>0).length;
  const nonTies=windows.filter(row=>Number(row.excessReturnPct)!==0).length;
  return {
    available:true,method:result.method,windowCount:result.windowCount,
    minimumWindowsRequired:result.minimumWindowsRequired,
    compoundedReturnPct:result.compoundedReturnPct,
    benchmarkCompoundedReturnPct:result.benchmarkCompoundedReturnPct,
    compoundedExcessReturnPct:result.compoundedExcessReturnPct,
    outperformanceWindowRatePct:result.outperformanceWindowRatePct,
    wins,nonTies,signTestPValue:exactBinomialUpperTail(wins,nonTies),
    worstWindowReturnPct:result.worstWindowReturnPct,
    worstWindowDrawdownPct:result.worstWindowDrawdownPct,
    totalTrades:result.totalTrades,averageWindowExcessReturnPct:result.averageWindowExcessReturnPct,
    dataQuality:result.dataQuality,exchangeOrdersPlaced:0
  };
}
function summarizeHoldout(result){
  if(!result||!result.metrics)return {available:false,reason:"untouched_holdout_unavailable"};
  return {
    available:true,totalReturnPct:result.metrics.totalReturnPct,
    benchmarkReturnPct:result.benchmark.totalReturnPct,
    excessReturnPct:result.metrics.totalReturnPct-result.benchmark.totalReturnPct,
    maxDrawdownPct:result.metrics.maxDrawdownPct,tradeCount:result.metrics.tradeCount,
    profitFactor:result.metrics.profitFactor,sharpe:result.metrics.sharpe,
    sortino:result.metrics.sortino,haltedByDrawdown:result.haltedByDrawdown
  };
}
function passCostCase(row){
  const policy=INTERNATIONAL_RESEARCH_POLICY;
  return row.oos?.available===true&&row.oos.windowCount>=policy.minimumWindows&&
    row.oos.totalTrades>=policy.minimumTrades&&
    Number(row.oos.outperformanceWindowRatePct)>=policy.minimumOutperformanceWindowRatePct&&
    Number(row.oos.worstWindowDrawdownPct)<=policy.maximumWorstWindowDrawdownPct;
}
function buildResearchCandidates(results){
  const grouped=new Map();
  for(const row of results){const key=row.symbol+"|"+row.strategy;
    if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);}
  const candidates=[];
  for(const rows of grouped.values()){
    if(!["ema-trend","donchian-breakout"].includes(rows[0]?.strategy))continue;
    const cases=Object.fromEntries(rows.map(row=>[row.costScenario,row]));
    const base=cases.base,moderate=cases.moderate,severe=cases.severe;
    if(!base||!moderate||!severe||!rows.every(passCostCase))continue;
    if(rows.some(row=>!row.holdout?.available||Number(row.holdout.totalReturnPct)<=0||
       Number(row.holdout.excessReturnPct)<=0||Number(row.holdout.tradeCount)<5))continue;
    const maxQ=Math.max(...rows.map(row=>Number(row.qValue??1)));
    if(maxQ>INTERNATIONAL_RESEARCH_POLICY.maximumFdrQValue)continue;
    if(!(Number(base.oos.compoundedReturnPct)>0&&Number(moderate.oos.compoundedReturnPct)>0&&
       Number(severe.oos.compoundedReturnPct)>=INTERNATIONAL_RESEARCH_POLICY.minimumSevereStressReturnPct))continue;
    candidates.push({
      symbol:base.symbol,baseAsset:base.baseAsset,quoteAsset:"USDT",quotePriceUnit:"USDT",
      timeframe:"4h",resolution:"240",strategy:base.strategy,
      baseReturnPct:base.oos.compoundedReturnPct,
      moderateStressReturnPct:moderate.oos.compoundedReturnPct,
      severeStressReturnPct:severe.oos.compoundedReturnPct,
      baseBenchmarkOutperformancePct:base.oos.outperformanceWindowRatePct,
      moderateBenchmarkOutperformancePct:moderate.oos.outperformanceWindowRatePct,
      severeBenchmarkOutperformancePct:severe.oos.outperformanceWindowRatePct,
      worstWindowDrawdownPct:Math.max(...rows.map(row=>Number(row.oos.worstWindowDrawdownPct))),
      minimumWindowCount:Math.min(...rows.map(row=>Number(row.oos.windowCount))),
      minimumTradeCount:Math.min(...rows.map(row=>Number(row.oos.totalTrades))),
      benjaminiHochbergQValue:maxQ,multipleTestingHypothesisCount:results.length,
      untouchedHoldout:{baseReturnPct:base.holdout.totalReturnPct,
        moderateReturnPct:moderate.holdout.totalReturnPct,severeReturnPct:severe.holdout.totalReturnPct},
      paperPromotionAllowed:false,
      paperBlockReason:"fresh Tabdeal-local book, same-pair execution preflight, verified fees/minimums and repeat confirmation are separate pending gates"
    });
  }
  return candidates.sort((a,b)=>b.severeStressReturnPct-a.severeStressReturnPct||
    a.benjaminiHochbergQValue-b.benjaminiHochbergQValue||a.symbol.localeCompare(b.symbol));
}
export function runInternationalStrategyResearch({rows,nowMs=Date.now()}={}){
  const normalized=normalizeInternationalResearchRows(rows,{nowMs}),policy=INTERNATIONAL_RESEARCH_POLICY;
  const hypotheses=[],researchResults=[],sourceReadiness=[];
  for(const symbol of policy.symbols){
    const candles=normalized.candlesBySymbol[symbol],quality=normalized.qualityBySymbol[symbol];
    const splitIndex=Math.floor(candles.length*policy.discoveryFraction);
    const holdoutCandles=candles.slice(Math.max(0,splitIndex-policy.holdoutWarmupBars));
    const discoveryCandles=candles.slice(0,splitIndex);
    const usable=quality.fresh&&discoveryCandles.length>=policy.trainBars+policy.minimumWindows*policy.stepBars;
    sourceReadiness.push({
      symbol,baseAsset:symbol.slice(0,-4),provider:policy.provider,quoteAsset:"USDT",...quality,
      discoveryCandleCount:discoveryCandles.length,
      untouchedHoldoutCandleCount:Math.max(0,holdoutCandles.length-policy.holdoutWarmupBars),
      readyForResearch:usable
    });
    for(const strategy of INTERNATIONAL_STRATEGIES)for(const scenario of INTERNATIONAL_COST_SCENARIOS){
      const id=[symbol,strategy,scenario.id].join("|");
      let oos={available:false,reason:usable?"not_run":"history_or_freshness_gate"};
      let holdout={available:false,reason:usable?"not_run":"history_or_freshness_gate"};
      if(usable){
        try{
          const options=costOptions(scenario,strategy);
          const oosRaw=rollingOutOfSampleBacktest(discoveryCandles,{
            ...options,trainBars:policy.trainBars,testBars:policy.testBars,
            stepBars:policy.stepBars,minimumWindows:policy.minimumWindows
          });
          oos=summarizeOos(oosRaw);
          try{
            const holdoutRaw=backtestLongOnly(holdoutCandles,{
              ...options,startIndex:policy.holdoutWarmupBars,endIndex:holdoutCandles.length-1
            });
            holdout=summarizeHoldout(holdoutRaw);
          }catch(error){holdout={available:false,reason:String(error?.message||error).slice(0,100)};}
        }catch(error){oos={available:false,reason:String(error?.message||error).slice(0,100)};}
      }
      hypotheses.push({id,pValue:oos.available?oos.signTestPValue:1});
      researchResults.push({
        id,symbol,baseAsset:symbol.slice(0,-4),strategy,costScenario:scenario.id,
        feeBpsPerSide:scenario.feeBpsPerSide,slippageBpsPerSide:scenario.slippageBpsPerSide,
        oos,holdout,qValue:1
      });
    }
  }
  const qValues=new Map(benjaminiHochbergAdjust(hypotheses).map(item=>[item.id,item.qValue]));
  for(const row of researchResults)row.qValue=qValues.get(row.id)??1;
  const candidates=buildResearchCandidates(researchResults);
  const readyCount=sourceReadiness.filter(item=>item.readyForResearch).length;
  return {
    schemaVersion:1,reportType:"INTERNATIONAL_SPOT_STRATEGY_RESEARCH",
    generatedAt:new Date(nowMs).toISOString(),
    source:{provider:policy.provider,quoteAsset:"USDT",interval:policy.interval,
      symbols:[...policy.symbols],dataMode:"public historical research data only",
      internationalQuotesNotUsedAsTabdealExecutionPrices:true},
    methodology:{
      discoveryFraction:policy.discoveryFraction,untouchedHoldoutFraction:1-policy.discoveryFraction,
      trainBars:policy.trainBars,testBars:policy.testBars,stepBars:policy.stepBars,
      minimumOutOfSampleWindows:policy.minimumWindows,strategies:[...INTERNATIONAL_STRATEGIES],
      costScenarios:INTERNATIONAL_COST_SCENARIOS.map(item=>({...item,assumptionOnly:true})),
      statisticalTest:"one-sided exact binomial sign test on non-tied OOS window excess returns",
      multiplicityCorrection:"Benjamini-Hochberg across the complete fixed asset × strategy × cost family",
      hypothesisCount:hypotheses.length,
      caveats:[
        "Strategy parameters are fixed before evaluation; trainBars provide indicator warm-up and are not an optimizer.",
        "OOS windows are sequential non-overlapping test blocks; this does not remove regime dependence or all serial dependence.",
        "Sign-test p-values and FDR are research filters, not proof of a causal or persistent edge.",
        "The last 20% of each symbol history is not used in OOS selection and is reported as an untouched holdout.",
        "Cost scenarios are provisional stress assumptions; Tabdeal fee tier, rebates, spread, impact and fill costs remain to be verified.",
        "Only Binance Spot USDT candles are analyzed. Kraken USD is not merged with USDT or treated as a Tabdeal price.",
        "No IRT market is analyzed because its price/settlement unit remains unverified."
      ]
    },
    dataQuality:{selectedRecordCount:normalized.selectedRecordCount,
      duplicateCount:normalized.duplicateCount,ignoredRecordCount:normalized.ignoredRecordCount,
      readySymbolCount:readyCount,symbols:sourceReadiness},
    results:researchResults,researchCandidates:candidates,
    paperGate:{passed:false,liveTradingEnabled:false,exchangeOrdersPlaced:0,
      reason:"External research only; Paper requires a fresh Tabdeal-local Spot confirmation and separately audited execution-cost/unit controls."},
    safety:{unauthenticatedHistoricalDataOnly:true,privateCredentialsUsed:false,
      accountDataRead:false,privateExchangeEndpointsUsed:false,d1Written:false,
      exchangeOrdersPlaced:0,fundsMoved:false,liveTradingEnabled:false},
    status:readyCount===0?"data_not_ready":candidates.length?"research_candidates_found":"no_strategy_passed_research_gates"
  };
}
