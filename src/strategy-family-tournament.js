const INTERVAL_MS = 14_400_000;
const MIN_BARS = 420;
const EPS = 1e-12;

export const STRATEGY_TOURNAMENT_POLICY = Object.freeze({
  interval: "4h", intervalMs: INTERVAL_MS,
  minimumAlignedBars: MIN_BARS, minimumSymbols: 3, maximumSymbols: 20,
  minimumHistoryBarsForDynamicUniverse: 2_000,
  discoveryFraction: 0.70, relativeLookbackBars: 60, relativeZWindowBars: 120,
  momentumLookbackBars: 60, volatilityLookbackBars: 30,
  trendFastEmaBars: 20, trendSlowEmaBars: 50,
  shortReversalBars: 3, trendMomentumBars: 12,
  relativeEntryZ: -1, relativeExitZ: 0.25, relativeSwitchAdvantageZ: 0.75,
  relativeMinimumHoldBars: 6, momentumSwitchAdvantage: 0.15,
  momentumMinimumHoldBars: 3, hybridSwitchAdvantage: 0.15,
  hybridMinimumHoldBars: 6, windowBars: 30, minimumOosWindows: 20,
  minimumSwitches: 6, minimumOutperformanceWindowRatePct: 60,
  maximumDrawdownPct: 20, maximumFdrQValue: 0.05,
  initialCapitalUsdt: 1_000, maximumExposureFraction: 1
});
export const STRATEGY_FAMILIES = Object.freeze([
  Object.freeze({id:"relative_value", name:"Relative-value rotation"}),
  Object.freeze({id:"momentum", name:"Cross-sectional momentum"}),
  Object.freeze({id:"hybrid", name:"Trend + relative-value hybrid"})
]);
export const STRATEGY_TOURNAMENT_COSTS = Object.freeze([
  Object.freeze({id:"base", feeBpsPerOrder:40, slippageBpsPerOrder:10}),
  Object.freeze({id:"moderate", feeBpsPerOrder:50, slippageBpsPerOrder:25}),
  Object.freeze({id:"severe", feeBpsPerOrder:75, slippageBpsPerOrder:50})
]);
const EXCLUDED_BASES = new Set([
  "USDT","USDC","BUSD","FDUSD","TUSD","USDP","DAI","USDE",
  "USDD","UST","USTC","EUR","TRY","BRL","GBP","AUD"
]);
const LEVERAGED_SUFFIXES = ["UP","DOWN","BULL","BEAR","2L","2S","3L","3S","5L","5S"];
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value) > 0;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
function fail(code) { throw new Error(code); }
function mean(values) {
  return values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null;
}
function median(values) {
  if (!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}
function sampleStd(values,average=mean(values)) {
  if(values.length<2||!finite(average))return null;
  return Math.sqrt(values.reduce((sum,value)=>sum+(value-average)**2,0)/(values.length-1));
}
function emaSeries(values,period) {
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
function eligibleBase(base) {
  const value=String(base||"").toUpperCase();
  return /^[A-Z0-9]{2,20}$/.test(value)&&!EXCLUDED_BASES.has(value)&&
    !LEVERAGED_SUFFIXES.some(suffix=>value.endsWith(suffix));
}

export function normalizeStrategyTournamentHistory(rows,{nowMs=Date.now(),symbols=null}={}) {
  if(!Array.isArray(rows)||!Number.isSafeInteger(nowMs))fail("tournament_history_or_clock_invalid");
  const bySymbol=new Map();
  let ignoredRecordCount=0,duplicateCount=0;
  for(const row of rows){
    if(!isRecord(row))fail("tournament_history_record_invalid");
    if(row.recordType!=="candle"||row.provider!=="binance_spot"||
       row.interval!==STRATEGY_TOURNAMENT_POLICY.interval||
       String(row.quoteAsset||"").toUpperCase()!=="USDT"||
       String(row.quoteUnit||"").toUpperCase()!=="USDT"){
      ignoredRecordCount++;continue;
    }
    const symbol=String(row.symbol||"").toUpperCase();
    const baseAsset=String(row.baseAsset||"").toUpperCase();
    if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol)||symbol!==baseAsset+"USDT"||!eligibleBase(baseAsset)){
      ignoredRecordCount++;continue;
    }
    const candle={
      symbol,baseAsset,openTimeMs:Number(row.openTimeMs),closeTimeMs:Number(row.closeTimeMs),
      open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),
      baseVolume:Number(row.baseVolume),tradeCount:Number(row.tradeCount)
    };
    const expectedClose=candle.openTimeMs+INTERVAL_MS-1;
    if(!Number.isSafeInteger(candle.openTimeMs)||!Number.isSafeInteger(candle.closeTimeMs)||
       candle.openTimeMs<=0||candle.openTimeMs%INTERVAL_MS!==0||
       candle.closeTimeMs!==expectedClose||candle.closeTimeMs>=nowMs||
       ![candle.open,candle.high,candle.low,candle.close].every(positive)||
       !finite(candle.baseVolume)||candle.baseVolume<0||
       !Number.isSafeInteger(candle.tradeCount)||candle.tradeCount<0||
       candle.high<Math.max(candle.open,candle.close,candle.low)||
       candle.low>Math.min(candle.open,candle.close,candle.high)){
      fail("tournament_candle_invalid_"+symbol);
    }
    if(!bySymbol.has(symbol))bySymbol.set(symbol,new Map());
    const map=bySymbol.get(symbol),prior=map.get(candle.openTimeMs);
    if(prior){
      if(!["open","high","low","close","baseVolume","tradeCount"].every(key=>prior[key]===candle[key])){
        fail("tournament_conflicting_duplicate_"+symbol);
      }
      duplicateCount++;
    }else map.set(candle.openTimeMs,candle);
  }
  const hasExplicitUniverse=Array.isArray(symbols);
  const requested=hasExplicitUniverse
    ?[...new Set(symbols.map(value=>String(value).toUpperCase()))]
    :[...bySymbol.keys()];
  const ranked=requested.filter(symbol=>bySymbol.has(symbol))
    .map((symbol,priority)=>({symbol,count:bySymbol.get(symbol).size,priority}))
    .filter(row=>row.count>=(hasExplicitUniverse
      ?STRATEGY_TOURNAMENT_POLICY.minimumHistoryBarsForDynamicUniverse
      :STRATEGY_TOURNAMENT_POLICY.minimumAlignedBars))
    .sort((a,b)=>hasExplicitUniverse
      ?a.priority-b.priority
      :b.count-a.count||a.symbol.localeCompare(b.symbol))
    .slice(0,STRATEGY_TOURNAMENT_POLICY.maximumSymbols);
  const selectedSymbols=ranked.map(row=>row.symbol);
  if(selectedSymbols.length<STRATEGY_TOURNAMENT_POLICY.minimumSymbols){
    return {available:false,reason:"tournament_too_few_eligible_symbols",selectedSymbols,
      ignoredRecordCount,duplicateCount,
      perSymbolBars:Object.fromEntries([...bySymbol].map(([symbol,map])=>[symbol,map.size]))};
  }
  const timeSets=selectedSymbols.map(symbol=>new Set(bySymbol.get(symbol).keys()));
  const common=[...timeSets[0]].filter(time=>timeSets.every(set=>set.has(time))).sort((a,b)=>a-b);
  const segments=[];let current=[];
  for(const time of common){
    if(current.length&&time-current.at(-1)!==INTERVAL_MS){segments.push(current);current=[];}
    current.push(time);
  }
  if(current.length)segments.push(current);
  const latest=segments.at(-1)||[];
  if(latest.length<STRATEGY_TOURNAMENT_POLICY.minimumAlignedBars){
    return {available:false,reason:"tournament_aligned_contiguous_history_below_minimum",
      selectedSymbols,alignedBars:common.length,latestContiguousBars:latest.length,
      requiredBars:STRATEGY_TOURNAMENT_POLICY.minimumAlignedBars,ignoredRecordCount,duplicateCount};
  }
  const latestClosedAtMs=latest.at(-1)+INTERVAL_MS,latestAgeMs=nowMs-latestClosedAtMs;
  if(latestAgeMs<0||latestAgeMs>12*60*60*1000){
    return {available:false,reason:"tournament_latest_history_stale_or_future",selectedSymbols,
      alignedBars:common.length,latestContiguousBars:latest.length,
      latestClosedAt:new Date(latestClosedAtMs).toISOString(),latestAgeMs,
      ignoredRecordCount,duplicateCount};
  }
  const candlesBySymbol={};
  for(const symbol of selectedSymbols){
    candlesBySymbol[symbol]=latest.map(time=>{
      const row=bySymbol.get(symbol).get(time);
      return {time,open:row.open,high:row.high,low:row.low,close:row.close,volume:row.baseVolume};
    });
  }
  return {available:true,symbols:selectedSymbols,candlesBySymbol,
    alignedBars:common.length,latestContiguousBars:latest.length,
    latestClosedAt:new Date(latestClosedAtMs).toISOString(),latestAgeMs,
    ignoredRecordCount,duplicateCount,
    perSymbolBars:Object.fromEntries(selectedSymbols.map(symbol=>[symbol,bySymbol.get(symbol).size]))};
}

function buildTournamentFeatures(history) {
  const symbols=history.symbols,count=history.candlesBySymbol[symbols[0]].length;
  const closes=Object.fromEntries(symbols.map(symbol=>[symbol,history.candlesBySymbol[symbol].map(row=>row.close)]));
  const emas=Object.fromEntries(symbols.map(symbol=>[symbol,{
    fast:emaSeries(closes[symbol],STRATEGY_TOURNAMENT_POLICY.trendFastEmaBars),
    slow:emaSeries(closes[symbol],STRATEGY_TOURNAMENT_POLICY.trendSlowEmaBars)
  }]));
  const relative=Object.fromEntries(symbols.map(symbol=>[symbol,Array(count).fill(null)]));
  const features=Array(count).fill(null),lookback=STRATEGY_TOURNAMENT_POLICY.relativeLookbackBars;
  for(let i=lookback;i<count;i++){
    const returns=symbols.map(symbol=>Math.log(closes[symbol][i]/closes[symbol][i-lookback]));
    const crossMean=mean(returns);
    symbols.forEach((symbol,index)=>{relative[symbol][i]=returns[index]-crossMean;});
  }
  const firstIndex=lookback+STRATEGY_TOURNAMENT_POLICY.relativeZWindowBars;
  for(let i=firstIndex;i<count;i++){
    const assets={},rawMomentum=[];
    for(const symbol of symbols){
      const price=closes[symbol];
      const return60=price[i]/price[i-STRATEGY_TOURNAMENT_POLICY.momentumLookbackBars]-1;
      const return24=price[i]/price[i-24]-1;
      const return12=price[i]/price[i-STRATEGY_TOURNAMENT_POLICY.trendMomentumBars]-1;
      const return3=price[i]/price[i-STRATEGY_TOURNAMENT_POLICY.shortReversalBars]-1;
      const volReturns=[];
      for(let j=i-STRATEGY_TOURNAMENT_POLICY.volatilityLookbackBars+1;j<=i;j++){
        volReturns.push(Math.log(price[j]/price[j-1]));
      }
      const volatility30=sampleStd(volReturns);
      const relativeHistory=relative[symbol].slice(i-STRATEGY_TOURNAMENT_POLICY.relativeZWindowBars,i);
      const relativeAverage=mean(relativeHistory),relativeDeviation=sampleStd(relativeHistory,relativeAverage);
      const relativeZ=relativeDeviation>EPS?(relative[symbol][i]-relativeAverage)/relativeDeviation:0;
      const fast=emas[symbol].fast[i],slow=emas[symbol].slow[i];
      const riskAdjustedMomentum=return60/Math.max((volatility30||0)*Math.sqrt(60),0.0001);
      const trendConfirmed=finite(fast)&&finite(slow)&&price[i]>slow&&fast>slow&&return12>0;
      assets[symbol]={close:price[i],return60,return24,return12,return3,volatility30,
        relativeZ,riskAdjustedMomentum,trendConfirmed};
      rawMomentum.push({symbol,value:riskAdjustedMomentum});
    }
    rawMomentum.sort((a,b)=>a.value-b.value||a.symbol.localeCompare(b.symbol));
    const ranks=new Map(rawMomentum.map((row,index)=>[row.symbol,rawMomentum.length<=1?0.5:index/(rawMomentum.length-1)]));
    const breadth=symbols.filter(symbol=>assets[symbol].trendConfirmed).length/symbols.length;
    const medianReturn24=median(symbols.map(symbol=>assets[symbol].return24));
    for(const symbol of symbols){
      assets[symbol].momentumRank=ranks.get(symbol);
      assets[symbol].hybridScore=0.60*assets[symbol].momentumRank+
        0.40*clamp((1-assets[symbol].relativeZ)/4,0,1);
    }
    features[i]={assets,breadth,medianReturn24,riskOn:medianReturn24>0||breadth>=0.60};
  }
  return {features,firstIndex};
}

function chooseTarget(strategyId,featureRow,heldSymbol,heldBars) {
  if(!featureRow)return {target:null,reason:"features_unavailable"};
  const assets=featureRow.assets,symbols=Object.keys(assets);
  const eligible=symbols.filter(symbol=>assets[symbol].trendConfirmed);
  let candidate=null;
  if(strategyId==="relative_value"){
    candidate=eligible.filter(symbol=>assets[symbol].relativeZ<=STRATEGY_TOURNAMENT_POLICY.relativeEntryZ&&
      assets[symbol].return3>0).sort((a,b)=>assets[a].relativeZ-assets[b].relativeZ||a.localeCompare(b))[0]||null;
  }else if(strategyId==="momentum"){
    candidate=eligible.filter(symbol=>assets[symbol].return60>0)
      .sort((a,b)=>assets[b].riskAdjustedMomentum-assets[a].riskAdjustedMomentum||a.localeCompare(b))[0]||null;
  }else if(strategyId==="hybrid"){
    if(!featureRow.riskOn)return {target:null,reason:"hybrid_market_regime_risk_off"};
    candidate=eligible.filter(symbol=>assets[symbol].return60>0&&assets[symbol].return3>0)
      .sort((a,b)=>assets[b].hybridScore-assets[a].hybridScore||a.localeCompare(b))[0]||null;
  }else fail("tournament_strategy_not_allowlisted");
  if(!heldSymbol)return {target:candidate,reason:candidate?"qualified_entry":"no_qualified_asset"};
  const held=assets[heldSymbol],heldTrend=held?.trendConfirmed===true;
  if(!heldTrend)return {target:candidate===heldSymbol?null:candidate,
    reason:candidate&&candidate!==heldSymbol?"held_asset_trend_failed_rotate":"held_asset_trend_failed_exit"};
  if(strategyId==="relative_value"){
    if(held.relativeZ>=STRATEGY_TOURNAMENT_POLICY.relativeExitZ){
      return {target:candidate===heldSymbol?null:candidate,reason:"relative_value_exit"};
    }
    if(candidate&&candidate!==heldSymbol&&heldBars>=STRATEGY_TOURNAMENT_POLICY.relativeMinimumHoldBars&&
       assets[candidate].relativeZ<=held.relativeZ-STRATEGY_TOURNAMENT_POLICY.relativeSwitchAdvantageZ){
      return {target:candidate,reason:"relative_value_rotation"};
    }
  }else if(strategyId==="momentum"){
    if(held.return60<=0)return {target:candidate===heldSymbol?null:candidate,reason:"momentum_positive_trend_lost"};
    if(candidate&&candidate!==heldSymbol&&heldBars>=STRATEGY_TOURNAMENT_POLICY.momentumMinimumHoldBars&&
       assets[candidate].riskAdjustedMomentum>held.riskAdjustedMomentum*(1+STRATEGY_TOURNAMENT_POLICY.momentumSwitchAdvantage)){
      return {target:candidate,reason:"momentum_leader_change"};
    }
  }else if(strategyId==="hybrid"){
    if(!featureRow.riskOn)return {target:null,reason:"hybrid_market_regime_risk_off"};
    if(candidate&&candidate!==heldSymbol&&heldBars>=STRATEGY_TOURNAMENT_POLICY.hybridMinimumHoldBars&&
       assets[candidate].hybridScore>held.hybridScore+STRATEGY_TOURNAMENT_POLICY.hybridSwitchAdvantage){
      return {target:candidate,reason:"hybrid_leader_change"};
    }
  }
  return {target:heldSymbol,reason:"hold_existing_asset"};
}

function exactBinomialUpperTail(wins,total) {
  if(!Number.isSafeInteger(wins)||!Number.isSafeInteger(total)||wins<0||wins>total||total<0||total>512){
    fail("tournament_binomial_input_invalid");
  }
  if(total===0||wins===0)return 1;
  let term=2**(-total),tail=0;
  for(let k=0;k<=total;k++){if(k>=wins)tail+=term;if(k<total)term*=(total-k)/(k+1);}
  return clamp(tail,0,1);
}
function benjaminiHochberg(rows) {
  const ordered=rows.map((row,index)=>({index,p:row.pValue})).sort((a,b)=>a.p-b.p||a.index-b.index);
  const output=new Array(rows.length);let running=1;
  for(let i=ordered.length-1;i>=0;i--){
    running=Math.min(running,ordered[i].p*ordered.length/(i+1),1);
    output[ordered[i].index]=running;
  }
  return output;
}
function executeOrder({cash,position,target,sellPrice,buyPrice,feeRate,slippageRate,price}) {
  let nextCash=cash,nextPosition=position,orderCount=0;
  const actualSellPrice=positive(sellPrice)?sellPrice:price;
  const actualBuyPrice=positive(buyPrice)?buyPrice:price;
  if(position&&position.symbol!==target){
    if(!positive(actualSellPrice))fail("tournament_sell_fill_price_invalid");
    nextCash=position.quantity*actualSellPrice*(1-slippageRate)*(1-feeRate);
    nextPosition=null;orderCount++;
  }
  if(target&&(!nextPosition||nextPosition.symbol!==target)){
    if(!positive(actualBuyPrice))fail("tournament_buy_fill_price_invalid");
    const quantity=nextCash*(1-feeRate)/(actualBuyPrice*(1+slippageRate));
    if(!(quantity>0&&Number.isFinite(quantity)))fail("tournament_paper_quantity_invalid");
    nextPosition={symbol:target,quantity};nextCash=0;orderCount++;
  }
  return {cash:nextCash,position:nextPosition,orderCount};
}
function portfolioEquity(cash,position,candlesBySymbol,index) {
  return position?position.quantity*candlesBySymbol[position.symbol][index].close:cash;
}
function maximumDrawdown(curve) {
  let peak=0,max=0;
  for(const value of curve){peak=Math.max(peak,value);if(peak>0)max=Math.max(max,(peak-value)/peak*100);}
  return max;
}
function benchmarkReturn(candlesBySymbol,symbols,startIndex,endIndex,feeRate,slippageRate,initialCapital) {
  const allocation=initialCapital/symbols.length;let finalEquity=0;
  for(const symbol of symbols){
    const candles=candlesBySymbol[symbol],buyPrice=candles[startIndex+1].open*(1+slippageRate);
    const quantity=allocation*(1-feeRate)/buyPrice;
    finalEquity+=quantity*candles[endIndex].close*(1-slippageRate)*(1-feeRate);
  }
  return (finalEquity/initialCapital-1)*100;
}
function buildWindowStats(curve,candlesBySymbol,symbols,startIndex,endIndex) {
  const stats=[],size=STRATEGY_TOURNAMENT_POLICY.windowBars;
  for(let start=0;start+size<curve.length;start+=size){
    const finish=start+size,firstGlobal=startIndex+start,lastGlobal=Math.min(endIndex,startIndex+finish);
    const startEquity=curve[start],endEquity=curve[finish];
    if(!(startEquity>0&&endEquity>0))continue;
    const benchmarkReturnPct=mean(symbols.map(symbol=>
      candlesBySymbol[symbol][lastGlobal].close/candlesBySymbol[symbol][firstGlobal].close-1))*100;
    const strategyReturnPct=(endEquity/startEquity-1)*100;
    stats.push({startBar:firstGlobal,endBar:lastGlobal,strategyReturnPct,benchmarkReturnPct,
      excessReturnPct:strategyReturnPct-benchmarkReturnPct});
  }
  return stats;
}
function simulateFamily({strategyId,history,features,splitIndex,cost,initialCapital}) {
  const symbols=history.symbols,candlesBySymbol=history.candlesBySymbol,lastIndex=history.latestContiguousBars-1;
  const startIndex=splitIndex;
  if(startIndex>=lastIndex-1)fail("tournament_oos_window_invalid");
  const feeRate=cost.feeBpsPerOrder/10_000,slippageRate=cost.slippageBpsPerOrder/10_000;
  let cash=initialCapital,position=null,heldBars=0;
  let orderCount=0,switchCount=0,entryCount=0,exitCount=0,exposedBars=0;
  const equityCurve=[initialCapital],riskCurve=[initialCapital],tradeEvents=[];
  for(let i=startIndex;i<lastIndex;i++){
    const decision=chooseTarget(strategyId,features[i],position?.symbol||null,heldBars);
    const target=decision.target,executionIndex=i+1,priorSymbol=position?.symbol||null;
    if(target!==priorSymbol){
      const result=executeOrder({
        cash,position,target,
        sellPrice:position?candlesBySymbol[priorSymbol][executionIndex].open:null,
        buyPrice:target?candlesBySymbol[target][executionIndex].open:null,
        feeRate,slippageRate
      });
      cash=result.cash;position=result.position;orderCount+=result.orderCount;
      if(priorSymbol&&target)switchCount++;
      else if(!priorSymbol&&target)entryCount++;
      else if(priorSymbol&&!target)exitCount++;
      tradeEvents.push({signalOpenTimeMs:candlesBySymbol[symbols[0]][i].time,
        executionOpenTimeMs:candlesBySymbol[symbols[0]][executionIndex].time,
        from:priorSymbol,to:target,reason:decision.reason,orderCount:result.orderCount});
      heldBars=0;
    }else if(position)heldBars++;
    if(position)exposedBars++;
    const closeEquity=portfolioEquity(cash,position,candlesBySymbol,executionIndex);
    equityCurve.push(closeEquity);
    const intrabarLowEquity=position
      ? Math.min(closeEquity,position.quantity*candlesBySymbol[position.symbol][executionIndex].low)
      : cash;
    riskCurve.push(intrabarLowEquity);
  }
  let finalEquity=cash;
  if(position){
    finalEquity=position.quantity*candlesBySymbol[position.symbol][lastIndex].close*
      (1-slippageRate)*(1-feeRate);
    orderCount++;exitCount++;
  }
  equityCurve[equityCurve.length-1]=finalEquity;
  riskCurve[riskCurve.length-1]=Math.min(riskCurve.at(-1),finalEquity);
  const maxDrawdownPct=maximumDrawdown(riskCurve),totalReturnPct=(finalEquity/initialCapital-1)*100;
  const elapsedMs=candlesBySymbol[symbols[0]][lastIndex].time-
    candlesBySymbol[symbols[0]][startIndex].time+INTERVAL_MS;
  const years=Math.max(elapsedMs/(365.25*24*60*60*1000),1/365.25);
  const cagrPct=(finalEquity>0?(finalEquity/initialCapital)**(1/years)-1:-1)*100;
  const periodReturns=equityCurve.slice(1).map((value,index)=>
    equityCurve[index]>0?value/equityCurve[index]-1:0).filter(finite);
  const avg=mean(periodReturns)||0,std=sampleStd(periodReturns,avg)||0;
  const sharpeRatio=std>EPS?avg/std*Math.sqrt(365.25*6):null;
  const equalWeightReturnPct=benchmarkReturn(candlesBySymbol,symbols,startIndex,lastIndex,
    feeRate,slippageRate,initialCapital);
  const btcBuyHoldReturnPct=symbols.includes("BTCUSDT")
    ?benchmarkReturn(candlesBySymbol,["BTCUSDT"],startIndex,lastIndex,feeRate,slippageRate,initialCapital):null;
  const windows=buildWindowStats(equityCurve,candlesBySymbol,symbols,startIndex,lastIndex);
  const wins=windows.filter(row=>row.excessReturnPct>0).length;
  const nonTies=windows.filter(row=>row.excessReturnPct!==0).length;
  return {
    strategyId,costScenario:cost.id,feeBpsPerOrder:cost.feeBpsPerOrder,
    slippageBpsPerOrder:cost.slippageBpsPerOrder,totalReturnPct,cagrPct,maxDrawdownPct,
    equalWeightReturnPct,excessVsEqualWeightPct:totalReturnPct-equalWeightReturnPct,
    btcBuyHoldReturnPct,sharpeRatio,
    exposurePct:exposedBars/Math.max(1,lastIndex-startIndex)*100,
    switchCount,entryCount,exitCount,orderCount,
    windowCount:windows.length,outperformanceWindows:wins,
    outperformanceWindowRatePct:nonTies?wins/nonTies*100:0,
    signTestPValue:exactBinomialUpperTail(wins,nonTies),
    windows,trades:tradeEvents.slice(-100),
    initialCapitalUsdt:initialCapital,finalEquityUsdt:finalEquity,liveTradingEnabled:false
  };
}

export function runStrategyFamilyTournament({rows,nowMs=Date.now(),symbols=null,dynamicUniverse=null,
  initialCapitalUsdt=STRATEGY_TOURNAMENT_POLICY.initialCapitalUsdt}={}) {
  if(!Array.isArray(rows)||!Number.isSafeInteger(nowMs)||!positive(initialCapitalUsdt))fail("tournament_input_invalid");
  const history=normalizeStrategyTournamentHistory(rows,{nowMs,symbols});
  if(!history.available)return {available:false,status:"data_not_ready",reason:history.reason,history,
    safety:{liveTradingEnabled:false,exchangeOrdersPlaced:0,fundsMoved:false}};
  const splitIndex=Math.floor(history.latestContiguousBars*STRATEGY_TOURNAMENT_POLICY.discoveryFraction);
  const {features,firstIndex}=buildTournamentFeatures(history);
  if(splitIndex<firstIndex+1)return {available:false,status:"data_not_ready",
    reason:"tournament_discovery_warmup_too_short",
    history:{...history,splitIndex,firstFeatureIndex:firstIndex},
    safety:{liveTradingEnabled:false,exchangeOrdersPlaced:0,fundsMoved:false}};
  const results=[];
  for(const family of STRATEGY_FAMILIES){
    for(const cost of STRATEGY_TOURNAMENT_COSTS){
      results.push(simulateFamily({strategyId:family.id,history,features,splitIndex,cost,
        initialCapital:Number(initialCapitalUsdt)}));
    }
  }
  const qValues=benjaminiHochberg(results.map(row=>({pValue:row.signTestPValue})));
  results.forEach((row,index)=>{row.fdrQValue=qValues[index];});
  const gates=STRATEGY_FAMILIES.map(family=>{
    const cases=results.filter(row=>row.strategyId===family.id).map(row=>{
      const passed=row.totalReturnPct>0&&row.excessVsEqualWeightPct>0&&
        row.maxDrawdownPct<=STRATEGY_TOURNAMENT_POLICY.maximumDrawdownPct&&
        row.switchCount>=STRATEGY_TOURNAMENT_POLICY.minimumSwitches&&
        row.windowCount>=STRATEGY_TOURNAMENT_POLICY.minimumOosWindows&&
        row.outperformanceWindowRatePct>=STRATEGY_TOURNAMENT_POLICY.minimumOutperformanceWindowRatePct&&
        row.fdrQValue<=STRATEGY_TOURNAMENT_POLICY.maximumFdrQValue;
      return {costScenario:row.costScenario,passed,totalReturnPct:row.totalReturnPct,
        excessVsEqualWeightPct:row.excessVsEqualWeightPct,maxDrawdownPct:row.maxDrawdownPct,
        switchCount:row.switchCount,windowCount:row.windowCount,
        outperformanceWindowRatePct:row.outperformanceWindowRatePct,fdrQValue:row.fdrQValue};
    });
    const passAll=cases.every(row=>row.passed);
    return {strategyId:family.id,name:family.name,passedAllCostScenarios:passAll,
      status:passAll?"eligible_for_prospective_paper_review":"research_only_no_promotion",
      costCases:cases};
  });
  const eligible=gates.filter(row=>row.passedAllCostScenarios);
  const coverageComplete=!dynamicUniverse||dynamicUniverse.coverageComplete===true;
  return {
    available:true,reportType:"TABDEAL_STRATEGY_FAMILY_TOURNAMENT",
    generatedAt:new Date(nowMs).toISOString(),
    status:eligible.length?"paper_review_candidates_found":"no_family_passed_all_gates",
    market:"Tabdeal Spot USDT candidate universe; Binance Spot USDT closed 4h candles for research",
    history:{symbols:history.symbols,symbolCount:history.symbols.length,
      alignedBars:history.alignedBars,latestContiguousBars:history.latestContiguousBars,
      latestClosedAt:history.latestClosedAt,latestAgeMs:history.latestAgeMs,
      ignoredRecordCount:history.ignoredRecordCount,duplicateCount:history.duplicateCount,
      splitIndex,oosBars:history.latestContiguousBars-splitIndex,
      split:"70% discovery/warmup, 30% fixed out-of-sample; parameters pre-registered"},
    policy:STRATEGY_TOURNAMENT_POLICY,costScenarios:STRATEGY_TOURNAMENT_COSTS,
    results,gates,
    universeCoverage:dynamicUniverse?{
      source:dynamicUniverse.source||"dynamic_tabdeal_binance_spot_usdt",
      status:dynamicUniverse.status||"unknown",
      coverageComplete:dynamicUniverse.coverageComplete===true,
      eligibleBeforeCap:Number(dynamicUniverse.eligibleBeforeCap)||0,
      selectedMarketCount:Number(dynamicUniverse.selectedMarketCount)||0,
      omittedBySafetyCap:Number(dynamicUniverse.omittedBySafetyCap)||0,
      tournamentMinimumBars:STRATEGY_TOURNAMENT_POLICY.minimumHistoryBarsForDynamicUniverse
    }:{source:"legacy_history_without_dynamic_universe_manifest",coverageComplete:true},
    prospectivePaperCandidates:coverageComplete?eligible.map(row=>row.strategyId):[],
    paperReviewBlockReason:coverageComplete?null:"dynamic_universe_coverage_incomplete",
    paperTradingEnabled:false,
    promotionRule:"A family is only eligible for a separately reviewed prospective Paper stage if every cost case passes all gates. This historical tournament never starts Paper or live trading.",
    limitations:[
      "Current historical coverage is limited to the synchronized symbols listed in this report; the dynamic exchange universe does not automatically imply historical candle coverage.",
      "Signal discovery uses Binance Spot candles; these are not Tabdeal executable prices.",
      "Historical cost cases are provisional per-order assumptions; actual account fee tiers and historical Tabdeal order-book replay are not yet incorporated.",
      "The 70/30 fixed OOS split is a research screen, not proof of future profitability. Selecting among three families is itself a model-selection step; any candidate must pass a new prospective Paper period.",
      "This tournament is long-only Spot/cash. It does not open short positions, use leverage, read private account data, submit exchange orders, or move funds."
    ],
    safety:{publicHistoricalMarketDataOnly:true,privateCredentialsUsed:false,accountDataRead:false,
      exchangeOrdersPlaced:0,fundsMoved:false,liveTradingEnabled:false,leverageUsed:false,shortSellingUsed:false}
  };
}
export const strategyTournamentInternals=Object.freeze({
  emaSeries,exactBinomialUpperTail,benjaminiHochberg,chooseTarget,executeOrder,
  buildTournamentFeatures,simulateFamily
});
