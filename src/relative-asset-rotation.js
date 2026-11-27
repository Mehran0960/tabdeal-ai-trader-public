import {walkPaperOrderbook} from "./paper-engine.js";

export const ROTATION_SYMBOLS = Object.freeze([
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"
]);
export const ROTATION_POLICY = Object.freeze({
  interval: "4h",
  intervalMs: 14_400_000,
  lookbackBars: 60,
  zScoreWindowBars: 120,
  fastEmaBars: 20,
  slowEmaBars: 50,
  absoluteMomentumBars: 12,
  entryZScore: -1.0,
  exitZScore: 0.25,
  switchAdvantageZScore: 0.75,
  minimumHoldBars: 6,
  discoveryFraction: 0.70,
  minimumAlignedBars: 600,
  maximumLatestCandleAgeMs: 12 * 60 * 60 * 1000,
  maximumBookAgeMs: 30 * 60 * 1000,
  maximumSpreadBps: 35,
  minimumTopFiveDepthUsdt: 1_000,
  maximumDrawdownPct: 20,
  initialPaperCapitalUsdt: 100,
  feeBpsPerOrder: 40,
  latencyBufferBps: 5,
  maximumBookSlippageBps: 25
});
export const ROTATION_COST_SCENARIOS = Object.freeze([
  Object.freeze({id:"base",feeBpsPerOrder:40,slippageBpsPerOrder:10}),
  Object.freeze({id:"moderate",feeBpsPerOrder:50,slippageBpsPerOrder:25}),
  Object.freeze({id:"severe",feeBpsPerOrder:75,slippageBpsPerOrder:50})
]);

const EPSILON = 1e-10;
const finite = value => Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value) > 0;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
function fail(code) { throw new Error(code); }
function mean(values) {
  return values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null;
}
function sampleStd(values, average=mean(values)) {
  if (values.length < 2 || !finite(average)) return null;
  const variance=values.reduce((sum,value)=>sum+(value-average)**2,0)/(values.length-1);
  return Math.sqrt(variance);
}
function emaSeries(values, period) {
  const output=Array(values.length).fill(null);
  if(values.length<period)return output;
  let current=mean(values.slice(0,period));
  output[period-1]=current;
  const alpha=2/(period+1);
  for(let i=period;i<values.length;i++){
    current=alpha*values[i]+(1-alpha)*current;
    output[i]=current;
  }
  return output;
}
function normalizeHistory(rows,{nowMs=Date.now()}={}) {
  if(!Array.isArray(rows)||!Number.isSafeInteger(nowMs))fail("rotation_history_or_clock_invalid");
  const maps=new Map(ROTATION_SYMBOLS.map(symbol=>[symbol,new Map()]));
  let ignoredRecordCount=0,duplicateCount=0;
  for(const row of rows){
    if(!record(row))fail("rotation_history_record_invalid");
    if(row.recordType!=="candle"||row.provider!=="binance_spot"||row.interval!==ROTATION_POLICY.interval||
       !ROTATION_SYMBOLS.includes(String(row.symbol||"").toUpperCase())){
      ignoredRecordCount++;continue;
    }
    const symbol=String(row.symbol).toUpperCase();
    const base=symbol.slice(0,-4);
    const candle={
      symbol,baseAsset:String(row.baseAsset||"").toUpperCase(),
      quoteAsset:String(row.quoteAsset||"").toUpperCase(),
      quoteUnit:String(row.quoteUnit||"").toUpperCase(),
      openTimeMs:Number(row.openTimeMs),closeTimeMs:Number(row.closeTimeMs),
      open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),
      baseVolume:Number(row.baseVolume),tradeCount:Number(row.tradeCount)
    };
    const closeExpected=candle.openTimeMs+ROTATION_POLICY.intervalMs-1;
    if(candle.baseAsset!==base||candle.quoteAsset!=="USDT"||candle.quoteUnit!=="USDT"||
       !Number.isSafeInteger(candle.openTimeMs)||!Number.isSafeInteger(candle.closeTimeMs)||
       candle.openTimeMs<=0||candle.openTimeMs%ROTATION_POLICY.intervalMs!==0||
       candle.closeTimeMs!==closeExpected||candle.closeTimeMs>=nowMs||
       ![candle.open,candle.high,candle.low,candle.close].every(positive)||
       !finite(candle.baseVolume)||candle.baseVolume<0||
       !Number.isSafeInteger(candle.tradeCount)||candle.tradeCount<0||
       candle.high<Math.max(candle.open,candle.close,candle.low)||
       candle.low>Math.min(candle.open,candle.close,candle.high)){
      fail("rotation_candle_invalid_"+symbol);
    }
    const byTime=maps.get(symbol);
    const prior=byTime.get(candle.openTimeMs);
    if(prior){
      const same=["open","high","low","close","baseVolume","tradeCount"]
        .every(key=>prior[key]===candle[key]);
      if(!same)fail("rotation_conflicting_duplicate_"+symbol);
      duplicateCount++;
      continue;
    }
    byTime.set(candle.openTimeMs,candle);
  }
  const timeSets=ROTATION_SYMBOLS.map(symbol=>new Set(maps.get(symbol).keys()));
  const common=[...timeSets[0]].filter(time=>timeSets.every(set=>set.has(time))).sort((a,b)=>a-b);
  if(common.length<ROTATION_POLICY.minimumAlignedBars){
    return {available:false,reason:"rotation_aligned_history_below_minimum",alignedBarCount:common.length,
      requiredBars:ROTATION_POLICY.minimumAlignedBars,ignoredRecordCount,duplicateCount,
      perSymbol:Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>[symbol,maps.get(symbol).size]))};
  }
  const segments=[];
  let current=[];
  for(const time of common){
    if(current.length&&time-current.at(-1)!==ROTATION_POLICY.intervalMs){
      segments.push(current);current=[];
    }
    current.push(time);
  }
  if(current.length)segments.push(current);
  const latestSegment=segments.at(-1)||[];
  if(latestSegment.length<ROTATION_POLICY.minimumAlignedBars){
    return {available:false,reason:"rotation_latest_contiguous_segment_below_minimum",
      alignedBarCount:common.length,latestSegmentBars:latestSegment.length,
      requiredBars:ROTATION_POLICY.minimumAlignedBars,ignoredRecordCount,duplicateCount,
      perSymbol:Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>[symbol,maps.get(symbol).size]))};
  }
  const latestOpenTimeMs=latestSegment.at(-1);
  const latestClosedAtMs=latestOpenTimeMs+ROTATION_POLICY.intervalMs;
  const latestAgeMs=nowMs-latestClosedAtMs;
  if(latestAgeMs<0||latestAgeMs>ROTATION_POLICY.maximumLatestCandleAgeMs){
    return {available:false,reason:"rotation_latest_candles_stale_or_future",
      latestClosedAt:new Date(latestClosedAtMs).toISOString(),latestAgeMs,
      alignedBarCount:common.length,latestSegmentBars:latestSegment.length,
      ignoredRecordCount,duplicateCount,
      perSymbol:Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>[symbol,maps.get(symbol).size]))};
  }
  const candlesBySymbol={};
  for(const symbol of ROTATION_SYMBOLS){
    candlesBySymbol[symbol]=latestSegment.map(time=>{
      const row=maps.get(symbol).get(time);
      return {time,open:row.open,high:row.high,low:row.low,close:row.close,volume:row.baseVolume};
    });
  }
  return {
    available:true,candlesBySymbol,times:latestSegment,
    latestOpenTimeMs,latestClosedAtMs,latestAgeMs,
    alignedBarCount:common.length,latestSegmentBars:latestSegment.length,
    segmentCount:segments.length,ignoredRecordCount,duplicateCount,
    perSymbol:Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>[symbol,maps.get(symbol).size]))
  };
}
function buildFeatures(candlesBySymbol) {
  const count=candlesBySymbol[ROTATION_SYMBOLS[0]]?.length||0;
  const closes=Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>[
    symbol,candlesBySymbol[symbol].map(row=>row.close)
  ]));
  const emas=Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>[
    symbol,{fast:emaSeries(closes[symbol],ROTATION_POLICY.fastEmaBars),
      slow:emaSeries(closes[symbol],ROTATION_POLICY.slowEmaBars)}
  ]));
  const relative=new Map(ROTATION_SYMBOLS.map(symbol=>[symbol,Array(count).fill(null)]));
  const lookback=ROTATION_POLICY.lookbackBars;
  for(let index=lookback;index<count;index++){
    const returns=Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>[
      symbol,Math.log(closes[symbol][index]/closes[symbol][index-lookback])
    ]));
    const crossMean=mean(ROTATION_SYMBOLS.map(symbol=>returns[symbol]));
    for(const symbol of ROTATION_SYMBOLS){
      relative.get(symbol)[index]=returns[symbol]-crossMean;
    }
  }
  const featuresByIndex=Array(count).fill(null);
  const firstSignalIndex=lookback+ROTATION_POLICY.zScoreWindowBars;
  for(let index=firstSignalIndex;index<count;index++){
    const features={};
    for(const symbol of ROTATION_SYMBOLS){
      const series=relative.get(symbol);
      const historical=series.slice(index-ROTATION_POLICY.zScoreWindowBars,index)
        .filter(value=>finite(value));
      const current=series[index];
      if(historical.length!==ROTATION_POLICY.zScoreWindowBars||!finite(current))continue;
      const average=mean(historical),deviation=sampleStd(historical,average);
      const fast=emas[symbol].fast[index],slow=emas[symbol].slow[index];
      const momentumIndex=index-ROTATION_POLICY.absoluteMomentumBars;
      const momentum=momentumIndex>=0?closes[symbol][index]/closes[symbol][momentumIndex]-1:null;
      const z=deviation>1e-12?(current-average)/deviation:null;
      if(!finite(z)||!finite(fast)||!finite(slow)||!finite(momentum))continue;
      features[symbol]={
        zScore:z,relativeMomentum60:current,ema20:fast,ema50:slow,
        absoluteMomentum12:momentum,
        trendConfirmed:closes[symbol][index]>slow&&fast>slow&&momentum>0,
        close:closes[symbol][index]
      };
    }
    featuresByIndex[index]=features;
  }
  return {featuresByIndex,firstSignalIndex};
}
export function selectRotationTarget(features,currentSymbol=null,heldBars=0) {
  if(!record(features))return {targetSymbol:null,reason:"rotation_features_missing"};
  const eligible=ROTATION_SYMBOLS
    .filter(symbol=>record(features[symbol])&&features[symbol].trendConfirmed===true&&
      Number(features[symbol].zScore)<=ROTATION_POLICY.entryZScore)
    .sort((a,b)=>Number(features[a].zScore)-Number(features[b].zScore)||a.localeCompare(b));
  const candidate=eligible[0]||null;
  if(!currentSymbol){
    return {targetSymbol:candidate,reason:candidate?"relative_undervaluation_with_trend":"no_qualified_relative_value_asset"};
  }
  const current=features[currentSymbol];
  if(!record(current)){
    return {targetSymbol:candidate,reason:candidate?"current_signal_missing_rotate_to_candidate":"current_signal_missing_exit_to_cash"};
  }
  const currentExit=!current.trendConfirmed||Number(current.zScore)>=ROTATION_POLICY.exitZScore;
  if(candidate&&candidate!==currentSymbol&&
     Number(candidate&&features[candidate].zScore)<=Number(current.zScore)-ROTATION_POLICY.switchAdvantageZScore&&
     Number(heldBars)>=ROTATION_POLICY.minimumHoldBars){
    return {targetSymbol:candidate,reason:"stronger_relative_value_rotation"};
  }
  if(currentExit){
    return {targetSymbol:candidate&&candidate!==currentSymbol?candidate:null,
      reason:candidate&&candidate!==currentSymbol?"current_exit_and_new_candidate":"relative_value_reversion_or_trend_exit"};
  }
  return {targetSymbol:currentSymbol,reason:"hold_current_relative_value_position"};
}
function portfolioMark({cash,quantity,symbol,index,closes,feeRate,slippageRate}) {
  if(!symbol||quantity<=0)return cash;
  const gross=quantity*closes[symbol][index]*(1-slippageRate);
  return cash+gross*(1-feeRate);
}
function executeHistoricalSell(state,symbol,openPrice,cost,reason,index,events) {
  if(!symbol||state.quantity<=0)return;
  const price=openPrice*(1-cost.slippageRate);
  const gross=state.quantity*price;
  const fee=gross*cost.feeRate;
  state.cash+=gross-fee;
  events.push({index,timeMs:state.times[index],side:"SELL",symbol,quantity:state.quantity,
    price,quoteNotional:gross,fee,reason});
  state.quantity=0;
  state.currentSymbol=null;
  state.barsHeld=0;
}
function executeHistoricalBuy(state,symbol,openPrice,cost,index,events) {
  if(!symbol||state.cash<=0)return;
  const price=openPrice*(1+cost.slippageRate);
  const quantity=state.cash/(price*(1+cost.feeRate));
  if(!positive(quantity))return;
  const gross=quantity*price,fee=gross*cost.feeRate;
  const debit=gross+fee;
  if(debit>state.cash+1e-8)fail("rotation_historical_buy_exceeds_cash");
  state.cash=Math.max(0,state.cash-debit);
  state.quantity=quantity;
  state.currentSymbol=symbol;
  state.barsHeld=0;
  state.entryDebit=debit;
  events.push({index,timeMs:state.times[index],side:"BUY",symbol,quantity,price,
    quoteNotional:gross,fee,reason:"relative_rotation_entry"});
}
function calculateMetrics(equityCurve,initialCapital,events,years) {
  const finalEquity=equityCurve.at(-1)?.equity??initialCapital;
  let peak=initialCapital,maxDrawdownPct=0;
  for(const row of equityCurve){
    peak=Math.max(peak,row.equity);
    maxDrawdownPct=Math.max(maxDrawdownPct,peak>0?(peak-row.equity)/peak*100:0);
  }
  const returns=[];
  for(let i=1;i<equityCurve.length;i++){
    const prior=equityCurve[i-1].equity,current=equityCurve[i].equity;
    if(prior>0)returns.push(current/prior-1);
  }
  const average=mean(returns)||0,sd=sampleStd(returns,average);
  const sharpe=sd>0?average/sd*Math.sqrt(365*6):null;
  const buyCount=events.filter(row=>row.side==="BUY").length;
  const sellCount=events.filter(row=>row.side==="SELL").length;
  return {
    initialEquityUsdt:initialCapital,finalEquityUsdt:finalEquity,
    totalReturnPct:(finalEquity/initialCapital-1)*100,
    annualizedReturnPct:years>0?(Math.pow(finalEquity/initialCapital,1/years)-1)*100:null,
    maxDrawdownPct,maxDrawdownLimitPct:ROTATION_POLICY.maximumDrawdownPct,
    riskAdjustedSharpe4h:sharpe,
    barCount:equityCurve.length,years,
    orderCount:events.length,buyOrders:buyCount,sellOrders:sellCount,
    rotationCount:Math.min(buyCount,sellCount),
    timeInMarketPct:equityCurve.length?equityCurve.filter(row=>row.inMarket).length/equityCurve.length*100:0,
    equityCurve
  };
}
function benchmarkMetrics(aligned,startIndex,endIndex,cost,initialCapital) {
  const symbols=ROTATION_SYMBOLS;
  const firstIndex=Math.min(startIndex+1,endIndex);
  const lastIndex=endIndex;
  const durationBars=Math.max(1,lastIndex-firstIndex+1);
  const years=durationBars*ROTATION_POLICY.intervalMs/(365.25*24*60*60*1000);
  const firstOpen=Object.fromEntries(symbols.map(symbol=>[symbol,aligned.candlesBySymbol[symbol][firstIndex].open]));
  const lastClose=Object.fromEntries(symbols.map(symbol=>[symbol,aligned.candlesBySymbol[symbol][lastIndex].close]));
  const perAssetBudget=initialCapital/symbols.length;
  let equalWeightEquity=0;
  for(const symbol of symbols){
    const fill=firstOpen[symbol]*(1+cost.slippageRate);
    const qty=perAssetBudget/(fill*(1+cost.feeRate));
    const entryDebit=qty*fill*(1+cost.feeRate);
    const exitGross=qty*lastClose[symbol]*(1-cost.slippageRate);
    const exitNet=exitGross*(1-cost.feeRate);
    equalWeightEquity+=entryDebit>perAssetBudget+1e-8?0:exitNet;
  }
  const btcFill=firstOpen.BTCUSDT*(1+cost.slippageRate);
  const btcQty=initialCapital/(btcFill*(1+cost.feeRate));
  const btcEquity=btcQty*lastClose.BTCUSDT*(1-cost.slippageRate)*(1-cost.feeRate);
  return {
    equalWeightBuyHoldReturnPct:(equalWeightEquity/initialCapital-1)*100,
    btcBuyHoldReturnPct:(btcEquity/initialCapital-1)*100,
    cashReturnPct:0,years
  };
}
function simulate(aligned,featuresByIndex,{startIndex,endIndex,costScenario,initialCapital=ROTATION_POLICY.initialPaperCapitalUsdt}={}) {
  const start=Math.max(Number(startIndex)||0,featuresByIndex.findIndex(Boolean));
  const end=Math.min(Number(endIndex)||aligned.times.length-1,aligned.times.length-1);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end-start<2){
    return {available:false,reason:"rotation_simulation_window_invalid"};
  }
  const feeRate=Number(costScenario.feeBpsPerOrder)/10_000;
  const slippageRate=Number(costScenario.slippageBpsPerOrder)/10_000;
  if(!finite(feeRate)||feeRate<0||feeRate>=1||!finite(slippageRate)||slippageRate<0||slippageRate>=1){
    fail("rotation_cost_scenario_invalid");
  }
  const cost={feeRate,slippageRate};
  const closes=Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>[
    symbol,aligned.candlesBySymbol[symbol].map(row=>row.close)
  ]));
  const state={cash:initialCapital,quantity:0,currentSymbol:null,barsHeld:0,entryDebit:0,times:aligned.times};
  const events=[],equityCurve=[];
  let peak=initialCapital,haltedByDrawdown=false,drawdownExitPending=false;
  for(let index=start+1;index<=end;index++){
    const signalIndex=index-1;
    if(drawdownExitPending&&state.currentSymbol){
      executeHistoricalSell(state,state.currentSymbol,
        aligned.candlesBySymbol[state.currentSymbol][index].open,cost,"maximum_drawdown_stop",index,events);
      haltedByDrawdown=true;
    }
    if(!haltedByDrawdown&&!drawdownExitPending){
      const signal=featuresByIndex[signalIndex]||{};
      const decision=selectRotationTarget(signal,state.currentSymbol,state.barsHeld);
      if(decision.targetSymbol!==state.currentSymbol){
        if(state.currentSymbol){
          executeHistoricalSell(state,state.currentSymbol,
            aligned.candlesBySymbol[state.currentSymbol][index].open,cost,decision.reason,index,events);
        }
        if(decision.targetSymbol){
          executeHistoricalBuy(state,decision.targetSymbol,
            aligned.candlesBySymbol[decision.targetSymbol][index].open,cost,index,events);
        }
      }else if(state.currentSymbol){
        state.barsHeld++;
      }
    }
    const equity=portfolioMark({cash:state.cash,quantity:state.quantity,symbol:state.currentSymbol,
      index,closes,feeRate,slippageRate});
    peak=Math.max(peak,equity);
    const drawdownPct=peak>0?(peak-equity)/peak*100:0;
    equityCurve.push({timeMs:aligned.times[index]+ROTATION_POLICY.intervalMs,
      equity,inMarket:Boolean(state.currentSymbol),symbol:state.currentSymbol,drawdownPct});
    if(!haltedByDrawdown&&drawdownPct>=ROTATION_POLICY.maximumDrawdownPct){
      drawdownExitPending=true;
    }else if(haltedByDrawdown){
      drawdownExitPending=false;
    }
  }
  const durationBars=Math.max(1,end-start);
  const years=durationBars*ROTATION_POLICY.intervalMs/(365.25*24*60*60*1000);
  const metrics=calculateMetrics(equityCurve,initialCapital,events,years);
  const benchmark=benchmarkMetrics(aligned,start,end,cost,initialCapital);
  return {available:true,metrics,benchmark,events,haltedByDrawdown,
    startTime:new Date(aligned.times[start]).toISOString(),
    endTime:new Date(aligned.times[end]).toISOString(),
    costScenario:{...costScenario,roundTripSwitchCostBps:2*(costScenario.feeBpsPerOrder+costScenario.slippageBpsPerOrder)}};
}
function selectLatestTabdealBooks(rows,nowMs) {
  const latest=new Map();
  for(const row of rows){
    if(!record(row)||row.recordType!=="tabdeal_book"||!ROTATION_SYMBOLS.includes(String(row.symbol||"").toUpperCase()))continue;
    const symbol=String(row.symbol).toUpperCase(),capturedAtMs=Number(row.capturedAtMs);
    if(!Number.isSafeInteger(capturedAtMs)||capturedAtMs>nowMs+10_000)continue;
    const prior=latest.get(symbol);
    if(!prior||capturedAtMs>Number(prior.capturedAtMs))latest.set(symbol,row);
  }
  const books={};
  for(const symbol of ROTATION_SYMBOLS){
    const row=latest.get(symbol);
    if(!row){books[symbol]={available:false,reason:"tabdeal_local_book_missing"};continue;}
    const age=nowMs-Number(row.capturedAtMs);
    const bids=Array.isArray(row.bidLevelsTop5)?row.bidLevelsTop5:[];
    const asks=Array.isArray(row.askLevelsTop5)?row.askLevelsTop5:[];
    const normalizedLevels=values=>values.map(level=>[
      Number(Array.isArray(level)?level[0]:level?.price),
      Number(Array.isArray(level)?level[1]:level?.quantity)
    ]).filter(level=>positive(level[0])&&positive(level[1]));
    const bidLevels=normalizedLevels(bids),askLevels=normalizedLevels(asks);
    const status=row.status==="ok"&&row.quoteUnit==="USDT"&&age>=0&&age<=ROTATION_POLICY.maximumBookAgeMs&&
      bidLevels.length>=1&&askLevels.length>=1&&finite(row.spreadBps)&&
      Number(row.spreadBps)<=ROTATION_POLICY.maximumSpreadBps&&
      Number(row.bidDepthTop5Quote)>=ROTATION_POLICY.minimumTopFiveDepthUsdt&&
      Number(row.askDepthTop5Quote)>=ROTATION_POLICY.minimumTopFiveDepthUsdt&&
      record(row.marketRules)&&positive(row.marketRules.minQty)&&positive(row.marketRules.stepSize)&&
      positive(row.marketRules.minNotional)&&positive(row.marketRules.tickSize);
    books[symbol]={
      available:Boolean(status),reason:status?null:
        age>ROTATION_POLICY.maximumBookAgeMs?"tabdeal_local_book_stale":
        bids.length<1||asks.length<1?"tabdeal_book_levels_not_recorded":
        Number(row.spreadBps)>ROTATION_POLICY.maximumSpreadBps?"tabdeal_book_spread_too_wide":
        Number(row.bidDepthTop5Quote)<ROTATION_POLICY.minimumTopFiveDepthUsdt||
          Number(row.askDepthTop5Quote)<ROTATION_POLICY.minimumTopFiveDepthUsdt?"tabdeal_book_depth_too_thin":
        "tabdeal_market_rules_or_book_invalid",
      capturedAtMs:Number(row.capturedAtMs),ageMs:age,spreadBps:Number(row.spreadBps),
      bidDepthTop5Quote:Number(row.bidDepthTop5Quote),askDepthTop5Quote:Number(row.askDepthTop5Quote),
      bids:bidLevels,asks:askLevels,marketRules:row.marketRules
    };
  }
  return books;
}
export function runRelativeAssetRotationResearch({rows,nowMs=Date.now()}={}) {
  const normalized=normalizeHistory(rows,{nowMs});
  if(!normalized.available){
    return {available:false,status:"data_not_ready",reason:normalized.reason,dataQuality:normalized,
      liveTradingEnabled:false,exchangeOrdersPlaced:0,fundsMoved:false};
  }
  const {featuresByIndex,firstSignalIndex}=buildFeatures(normalized.candlesBySymbol);
  const total=normalized.times.length;
  if(total-firstSignalIndex<100){
    return {available:false,status:"data_not_ready",reason:"rotation_out_of_sample_history_too_short",
      dataQuality:normalized,liveTradingEnabled:false,exchangeOrdersPlaced:0,fundsMoved:false};
  }
  const splitIndex=Math.max(firstSignalIndex+1,Math.floor(total*ROTATION_POLICY.discoveryFraction));
  if(total-splitIndex<100){
    return {available:false,status:"data_not_ready",reason:"rotation_holdout_window_too_short",
      dataQuality:normalized,liveTradingEnabled:false,exchangeOrdersPlaced:0,fundsMoved:false};
  }
  const scenarios=ROTATION_COST_SCENARIOS.map(costScenario=>{
    const full=simulate(normalized,featuresByIndex,{startIndex:firstSignalIndex,endIndex:total-1,costScenario});
    const holdout=simulate(normalized,featuresByIndex,{startIndex:splitIndex,endIndex:total-1,costScenario});
    const holdoutExcessVsEqualWeight=holdout.metrics.totalReturnPct-holdout.benchmark.equalWeightBuyHoldReturnPct;
    return {
      costScenario:costScenario.id,fullSample:full.metrics,
      untouchedHoldout:{
        ...holdout.metrics,
        equalWeightBuyHoldReturnPct:holdout.benchmark.equalWeightBuyHoldReturnPct,
        btcBuyHoldReturnPct:holdout.benchmark.btcBuyHoldReturnPct,
        cashReturnPct:holdout.benchmark.cashReturnPct,
        excessVsEqualWeightPct:holdoutExcessVsEqualWeight,
        excessVsBtcPct:holdout.metrics.totalReturnPct-holdout.benchmark.btcBuyHoldReturnPct
      },
      haltedByDrawdown:full.haltedByDrawdown||holdout.haltedByDrawdown
    };
  });
  const gates=scenarios.map(row=>{
    const oos=row.untouchedHoldout;
    return {
      costScenario:row.costScenario,
      positiveNetReturn:Number(oos.totalReturnPct)>0,
      beatsEqualWeight:Number(oos.excessVsEqualWeightPct)>0,
      beatsBitcoin:Number(oos.excessVsBtcPct)>0,
      drawdownWithinLimit:Number(oos.maxDrawdownPct)<=ROTATION_POLICY.maximumDrawdownPct,
      minimumActivity:Number(oos.rotationCount)>=6,
      passed:Number(oos.totalReturnPct)>0&&Number(oos.excessVsEqualWeightPct)>0&&
        Number(oos.maxDrawdownPct)<=ROTATION_POLICY.maximumDrawdownPct&&Number(oos.rotationCount)>=6
    };
  });
  const promotionPassed=gates.every(row=>row.passed);
  const latestIndex=total-1;
  const latestFeatures=featuresByIndex[latestIndex]||{};
  const recommendation=selectRotationTarget(latestFeatures,null,0);
  const latestBooks=selectLatestTabdealBooks(rows,nowMs);
  const allBooksReady=ROTATION_SYMBOLS.every(symbol=>latestBooks[symbol]?.available===true);
  const someBooksReady=ROTATION_SYMBOLS.some(symbol=>latestBooks[symbol]?.available===true);
  const signalTimeMs=normalized.latestOpenTimeMs;
  return {
    schemaVersion:1,reportType:"TABDEAL_RELATIVE_ASSET_ROTATION_RESEARCH",
    generatedAt:new Date(nowMs).toISOString(),
    provider:"binance_spot_closed_4h_candles_for_signal_research",
    executionVenue:"tabdeal_spot_usdt",
    universe:ROTATION_SYMBOLS,
    strategy:{
      id:"relative-underperformance-with-trend-confirmation",
      description:"Buy a statistically unusual 60-bar relative underperformer only after its short-term absolute trend turns positive; rotate when another qualifying asset is materially cheaper or the held asset mean-reverts or loses trend.",
      parameters:{...ROTATION_POLICY},
      signalUsesOnlyCandlesThroughSignalClose:true,
      executionAssumption:"next 4h candle open for historical backtest; current Tabdeal local orderbook for forward Paper",
      noParameterOptimization:true
    },
    dataQuality:{
      latestClosedCandleAt:new Date(normalized.latestClosedAtMs).toISOString(),
      latestCandleAgeMs:normalized.latestAgeMs,
      alignedBars:normalized.alignedBarCount,latestContiguousBars:normalized.latestSegmentBars,
      contiguousSegments:normalized.segmentCount,ignoredRecords:normalized.ignoredRecordCount,
      duplicateCandles:normalized.duplicateCount,perSymbol:normalized.perSymbol,
      outOfSampleStartAt:new Date(normalized.times[splitIndex]).toISOString(),
      outOfSampleBars:total-splitIndex
    },
    latestSignal:{
      candleOpenTimeMs:signalTimeMs,candleCloseTime:new Date(normalized.latestClosedAtMs).toISOString(),
      recommendedAsset:recommendation.targetSymbol,reason:recommendation.reason,
      assets:Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>[symbol,latestFeatures[symbol]||null]))
    },
    costScenarios:scenarios,gates,
    promotionGate:{
      passed:promotionPassed,
      status:promotionPassed?"FORWARD_PAPER_ELIGIBLE":"RESEARCH_ONLY_NO_PROMOTION",
      reason:promotionPassed?"all untouched-holdout gates passed under all registered cost scenarios":
        "at least one untouched-holdout cost, benchmark, drawdown or activity gate failed",
      allRequiredCostScenariosPassed:promotionPassed,
      minimumHoldoutRotations:6,
      maxDrawdownLimitPct:ROTATION_POLICY.maximumDrawdownPct
    },
    localExecutionReadiness:{
      books:latestBooks,allFiveBooksReady:allBooksReady,
      forwardPaperEligible:promotionPassed&&someBooksReady,
      reason:!promotionPassed?"historical_promotion_gate_not_passed":
        !someBooksReady?"fresh_tabdeal_local_books_with_top5_levels_not_ready":
          allBooksReady?"ready_for_forward_paper_only":"partial_books_ready_candidate_specific_gates_apply"
    },
    safety:{signalHistoryOnly:true,accountDataRead:false,privateCredentialsUsed:false,
      liveTradingEnabled:false,exchangeOrdersPlaced:0,fundsMoved:false,leverageUsed:false,shortSellingUsed:false}
  };
}

function decimalFloorToStep(value,step) {
  if(!positive(value)||!positive(step))return 0;
  const precision=Math.min(12,Math.max(
    (String(value).split(".")[1]||"").length,
    (String(step).split(".")[1]||"").length
  ));
  const scale=10**precision;
  const valueUnits=Math.floor(Number(value)*scale+1e-7);
  const stepUnits=Math.round(Number(step)*scale);
  if(stepUnits<=0)return 0;
  return Math.floor(valueUnits/stepUnits)*stepUnits/scale;
}
function paperMarkToLiquidation(state,books) {
  if(!state.position)return Number(state.cashBalance);
  const book=books[state.position.symbol];
  if(!book?.available)return null;
  const bestBid=book.bids[0][0];
  const gross=Number(state.position.quantity)*bestBid*(1-ROTATION_POLICY.latencyBufferBps/10_000);
  const fee=gross*ROTATION_POLICY.feeBpsPerOrder/10_000;
  return Number(state.cashBalance)+gross-fee;
}
function paperSell(state,symbol,book,nowMs,reason,events) {
  const quantity=Number(state.position?.quantity||0);
  if(!positive(quantity))return {ok:false,reason:"paper_position_missing"};
  const step=Number(book.marketRules.stepSize);
  const maxQty=Number(book.marketRules.maxQty);
  if(!positive(step)||Math.abs(decimalFloorToStep(quantity,step)-quantity)>Math.max(1e-12,quantity*1e-8)||
     (positive(maxQty)&&quantity>maxQty))return {ok:false,reason:"paper_sell_quantity_filter_mismatch"};
  const fill=walkPaperOrderbook({side:"sell",quantity,levels:book.bids,
    latencyBufferBps:ROTATION_POLICY.latencyBufferBps,
    maxSlippageBps:ROTATION_POLICY.maximumBookSlippageBps});
  if(fill.status!=="filled"||Math.abs(fill.filledQuantity-quantity)>Math.max(1e-12,quantity*1e-8)){
    return {ok:false,reason:"paper_sell_book_depth_or_slippage_gate"};
  }
  const notional=fill.quoteNotional;
  const minNotional=Number(book.marketRules.minNotional);
  if(notional+1e-10<minNotional)return {ok:false,reason:"paper_sell_below_venue_minimum"};
  const fee=notional*ROTATION_POLICY.feeBpsPerOrder/10_000;
  state.cashBalance=Number(state.cashBalance)+notional-fee;
  events.push({time:new Date(nowMs).toISOString(),side:"SELL",symbol,quantity,
    averagePrice:fill.avgFillPrice,quoteNotional:notional,fee,reason,
    execution:"PAPER_TABDEAL_LOCAL_TOP5_BOOK"});
  state.position=null;
  return {ok:true,notional,fee};
}
function paperBuy(state,symbol,book,nowMs,reason,events) {
  const cash=Number(state.cashBalance);
  if(!positive(cash))return {ok:false,reason:"paper_quote_cash_unavailable"};
  const feeRate=ROTATION_POLICY.feeBpsPerOrder/10_000;
  const bestAsk=book.asks[0][0];
  const maxDepth=book.asks
    .filter(([price])=>price<=bestAsk*(1+ROTATION_POLICY.maximumBookSlippageBps/10_000))
    .reduce((sum,level)=>sum+level[1],0);
  const step=Number(book.marketRules.stepSize),minQty=Number(book.marketRules.minQty);
  const maxQty=Number(book.marketRules.maxQty);
  const minNotional=Number(book.marketRules.minNotional);
  let quantity=decimalFloorToStep(
    Math.min(cash/(bestAsk*(1+feeRate+ROTATION_POLICY.latencyBufferBps/10_000)),
      maxDepth*0.999,positive(maxQty)?maxQty:Number.POSITIVE_INFINITY),
    step
  );
  for(let attempt=0;attempt<5&&quantity>=minQty;attempt++){
    const fill=walkPaperOrderbook({side:"buy",quantity,levels:book.asks,
      latencyBufferBps:ROTATION_POLICY.latencyBufferBps,
      maxSlippageBps:ROTATION_POLICY.maximumBookSlippageBps});
    if(fill.status==="filled"&&Math.abs(fill.filledQuantity-quantity)<=Math.max(1e-12,quantity*1e-8)){
      const notional=fill.quoteNotional,fee=notional*feeRate,debit=notional+fee;
      if(notional+1e-10<minNotional)return {ok:false,reason:"paper_buy_below_venue_minimum"};
      if(debit<=cash+1e-8){
        state.cashBalance=Math.max(0,cash-debit);
        state.position={symbol,quantity:fill.filledQuantity,averageEntryPrice:fill.avgFillPrice,
          entryTime:new Date(nowMs).toISOString()};
        events.push({time:new Date(nowMs).toISOString(),side:"BUY",symbol,quantity:fill.filledQuantity,
          averagePrice:fill.avgFillPrice,quoteNotional:notional,fee,reason,
          execution:"PAPER_TABDEAL_LOCAL_TOP5_BOOK"});
        return {ok:true,notional,fee,quantity:fill.filledQuantity};
      }
    }
    quantity=decimalFloorToStep(quantity-step,step);
  }
  return {ok:false,reason:"paper_buy_no_full_fill_within_cash_depth_and_filters"};
}
export function applyRelativeRotationPaperTick({report,state,nowMs=Date.now(),runId="manual",runAttempt=1}={}) {
  if(!record(report)||report.reportType!=="TABDEAL_RELATIVE_ASSET_ROTATION_RESEARCH"){
    fail("rotation_paper_report_invalid");
  }
  const current=state===undefined||state===null?{
    schemaVersion:1,initialCapitalUsdt:ROTATION_POLICY.initialPaperCapitalUsdt,
    cashBalance:ROTATION_POLICY.initialPaperCapitalUsdt,position:null,peakEquityUsdt:ROTATION_POLICY.initialPaperCapitalUsdt,
    lastEquityUsdt:ROTATION_POLICY.initialPaperCapitalUsdt,maxDrawdownPct:0,
    lastProcessedSignalOpenTimeMs:0,tradeCount:0,haltedByDrawdown:false,events:[]
  }:structuredClone(state);
  if(current.schemaVersion!==1||!positive(current.initialCapitalUsdt)||
     !finite(current.cashBalance)||Number(current.cashBalance)<0||
     !finite(current.lastProcessedSignalOpenTimeMs)||!Array.isArray(current.events)||
     (current.position&&(!ROTATION_SYMBOLS.includes(current.position.symbol)||!positive(current.position.quantity)))){
    fail("rotation_paper_state_invalid");
  }
  const unchanged={state:current,events:[],changed:false,reason:null};
  if(report.promotionGate?.passed!==true){
    return {...unchanged,reason:"historical_promotion_gate_not_passed"};
  }
  if(report.localExecutionReadiness?.forwardPaperEligible!==true){
    return {...unchanged,reason:report.localExecutionReadiness?.reason||"tabdeal_local_execution_not_ready"};
  }
  const signalTime=Number(report.latestSignal?.candleOpenTimeMs);
  if(!Number.isSafeInteger(signalTime)||signalTime<=Number(current.lastProcessedSignalOpenTimeMs)){
    return {...unchanged,reason:"signal_already_processed_or_invalid"};
  }
  if(current.haltedByDrawdown)return {...unchanged,reason:"paper_drawdown_kill_switch_active"};
  const books=report.localExecutionReadiness.books;
  const mark=paperMarkToLiquidation(current,books);
  if(!positive(mark))return {...unchanged,reason:"paper_mark_to_liquidation_unavailable"};
  current.peakEquityUsdt=Math.max(Number(current.peakEquityUsdt),mark);
  const drawdown=(current.peakEquityUsdt-mark)/current.peakEquityUsdt*100;
  current.maxDrawdownPct=Math.max(Number(current.maxDrawdownPct)||0,drawdown);
  if(drawdown>=ROTATION_POLICY.maximumDrawdownPct){
    if(!current.position)return {...unchanged,reason:"paper_drawdown_kill_switch_active"};
    const book=books[current.position.symbol];
    const events=[];
    const sold=paperSell(current,current.position.symbol,book,nowMs,"maximum_drawdown_kill_switch",events);
    if(!sold.ok)return {...unchanged,reason:"paper_drawdown_liquidation_pending_"+sold.reason};
    current.haltedByDrawdown=true;
    current.lastProcessedSignalOpenTimeMs=signalTime;
    current.lastEquityUsdt=current.cashBalance;
    current.tradeCount+=events.length;
    current.events.push(...events);
    return {state:current,events,changed:true,reason:"paper_drawdown_kill_switch_triggered"};
  }
  const rawFeatureAssets=report.latestSignal.assets||{};
  const featureAssets=Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>[
    symbol,books[symbol]?.available===true?rawFeatureAssets[symbol]:
      record(rawFeatureAssets[symbol])?{...rawFeatureAssets[symbol],trendConfirmed:false}:null
  ]));
  const elapsedBars=current.lastProcessedSignalOpenTimeMs
    ? Math.max(0,Math.floor((signalTime-current.lastProcessedSignalOpenTimeMs)/ROTATION_POLICY.intervalMs))
    : ROTATION_POLICY.minimumHoldBars;
  const selection=selectRotationTarget(featureAssets,current.position?.symbol||null,
    (Number(current.position?.barsHeld)||0)+elapsedBars);
  const target=selection.targetSymbol;
  const oldSymbol=current.position?.symbol||null;
  const events=[];
  if(target!==oldSymbol){
    if(oldSymbol){
      const sold=paperSell(current,oldSymbol,books[oldSymbol],nowMs,selection.reason,events);
      if(!sold.ok)return {...unchanged,reason:sold.reason};
    }
    if(target){
      const bought=paperBuy(current,target,books[target],nowMs,selection.reason,events);
      if(!bought.ok){
        current.lastProcessedSignalOpenTimeMs=signalTime;
        current.lastEquityUsdt=current.cashBalance;
        current.events.push(...events);
        current.tradeCount+=events.length;
        current.lastUpdatedAt=new Date(nowMs).toISOString();
        current.lastRunId=String(runId);
        current.lastRunAttempt=Number(runAttempt);
        return {state:current,events,changed:true,reason:"paper_rotated_to_cash_after_buy_failure_"+bought.reason};
      }
    }
  }
  if(current.position){
    current.position.barsHeld=(Number(current.position.barsHeld)||0)+Math.max(1,elapsedBars);
  }
  const latestMark=paperMarkToLiquidation(current,books);
  if(!positive(latestMark))return {...unchanged,reason:"paper_post_trade_mark_unavailable"};
  current.peakEquityUsdt=Math.max(Number(current.peakEquityUsdt),latestMark);
  current.maxDrawdownPct=Math.max(Number(current.maxDrawdownPct),
    (current.peakEquityUsdt-latestMark)/current.peakEquityUsdt*100);
  current.lastEquityUsdt=latestMark;
  current.lastProcessedSignalOpenTimeMs=signalTime;
  current.tradeCount+=events.length;
  current.events.push(...events);
  current.lastUpdatedAt=new Date(nowMs).toISOString();
  current.lastRunId=String(runId);
  current.lastRunAttempt=Number(runAttempt);
  return {state:current,events,changed:true,reason:selection.reason};
}
export const relativeRotationInternals=Object.freeze({
  normalizeHistory,buildFeatures,selectLatestTabdealBooks,simulate,benchmarkMetrics
});
