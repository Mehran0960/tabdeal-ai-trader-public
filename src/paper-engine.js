import { calculateRiskPlan } from "./risk.js";

const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const finiteNonNegative = value => Number.isFinite(Number(value)) && Number(value) >= 0;

export const PAPER_LIMITS = Object.freeze({
  maxOrderbookAgeMs: 30_000,
  maxSlippageBps: 25,
  spreadLimitBps: Object.freeze({ RIAL: 25, USDT: 30 }),
  depth25Minimum: Object.freeze({ RIAL: 1_000_000_000, USDT: 1_000 }),
  stopAtrMultiple: 2,
  takeProfitRiskMultiple: 3,
  minHistoricalOutperformancePct: 60,
  minHistoricalWindowCount: 30,
  maxHistoricalWorstWindowDrawdownPct: 0.5
});

export function qualifiesForPaperWatch(candidate = {}) {
  if (candidate.paperType === "multi_asset") {
    const symbol=String(candidate.symbol||"").toUpperCase();
    const quote=String(candidate.quoteAsset||"").toUpperCase();
    const suffix=quote==="IRT"?"IRT":quote==="USDT"?"USDT":"";
    return Boolean(suffix && symbol.endsWith(suffix) &&
      String(candidate.resolution||"")==="240" &&
      ["ema-trend","donchian-breakout"].includes(String(candidate.strategy||"")) &&
      Number(candidate.confirmedScans)>=2 &&
      Number(candidate.severeStressActualReturnPct)>=1 &&
      Number(candidate.baseActualReturnPct)>0 &&
      Number(candidate.moderateStressActualReturnPct)>0 &&
      Number(candidate.baseOutperformanceWindowRatePct)>=60 &&
      Number(candidate.moderateOutperformanceWindowRatePct)>=60 &&
      Number(candidate.severeOutperformanceWindowRatePct)>=60 &&
      Number(candidate.worstWindowDrawdownPct)<=1 &&
      Number(candidate.minimumWindowCount)>=60 &&
      Number(candidate.minimumTradeCount)>=20 &&
      Number(candidate.benjaminiHochbergQValue)>=0 &&
      Number(candidate.benjaminiHochbergQValue)<=0.05 &&
      Number(candidate.multipleTestingHypothesisCount)>=30);
  }
  return String(candidate.symbol || "").toUpperCase() === "BTCIRT" &&
    String(candidate.quoteAsset || "").toUpperCase() === "IRT" &&
    String(candidate.resolution || "") === "240" &&
    String(candidate.strategy || "") === "ema-trend" &&
    finitePositive(candidate.severeStressActualReturnPct) &&
    Number(candidate.baseOutperformanceWindowRatePct) >= PAPER_LIMITS.minHistoricalOutperformancePct &&
    Number(candidate.worstWindowDrawdownPct) <= PAPER_LIMITS.maxHistoricalWorstWindowDrawdownPct &&
    Number(candidate.minimumWindowCount) >= PAPER_LIMITS.minHistoricalWindowCount &&
    Number(candidate.minimumTradeCount) >= 5;
}
export function classifyForwardPaperSignal({candidate,analysis,hasOpenPosition=false}={}) {
  const strategy=String(candidate?.strategy||"");
  const validManagementIdentity=String(candidate?.symbol||"").toUpperCase().endsWith("IRT") ||
    String(candidate?.symbol||"").toUpperCase().endsWith("USDT");
  if (hasOpenPosition) {
    if (!validManagementIdentity || !["ema-trend","donchian-breakout"].includes(strategy)) {
      return {action:"skip",reason:"existing_position_identity_invalid"};
    }
  } else if (!qualifiesForPaperWatch(candidate)) {
    return {action:"skip",reason:"historical_paper_watch_gate_not_met"};
  }
  if (!analysis?.available) return {action:"skip",reason:"live_research_analysis_unavailable"};
  if (analysis.dataQuality?.status !== "usable" || analysis.dataQuality?.materialGapCount > 0) {
    return {action:"skip",reason:"history_quality_or_gap_gate"};
  }
  if (analysis.execution?.liveTradingEnabled !== false || analysis.execution?.paperOnly !== true) {
    return {action:"skip",reason:"research_execution_contract_invalid"};
  }
  const close=Number(analysis.lastCandle?.close);
  const ema20=Number(analysis.marketState?.ema20);
  const ema50=Number(analysis.marketState?.ema50);
  if (![close,ema20,ema50].every(finitePositive)) return {action:"skip",reason:"latest_indicator_data_invalid"};
  if (hasOpenPosition) {
    const exit = strategy==="donchian-breakout"
      ? analysis.strategySignals?.breakout?.exitSignal==="EXIT_CANDIDATE"
      : ema20 < ema50 || close < ema50;
    return {action:exit?"exit":"hold",reason:exit
      ? (strategy==="donchian-breakout"?"donchian_channel_exit":"ema_trend_exit")
      : (strategy==="donchian-breakout"?"donchian_position_hold":"ema_trend_position_hold")};
  }
  const signal = strategy==="donchian-breakout"
    ? analysis.strategySignals?.breakout?.signal
    : analysis.strategySignals?.trendFollowing?.signal;
  if (analysis.decision !== "RESEARCH_BUY_CANDIDATE" ||
      signal !== "BUY_CANDIDATE" ||
      analysis.forecastAssessment?.confirmsLong !== true ||
      analysis.marketState?.volatilityRegime === "high") {
    return {action:"wait",reason:"forward_signal_not_confirmed"};
  }
  return {action:"buy",reason:"historical_oos_fdr_and_live_forecast_signal_confirmed"};
}
export function walkPaperOrderbook({
  side,quantity,levels,latencyBufferBps=5,maxSlippageBps=PAPER_LIMITS.maxSlippageBps
}={}){
  const direction=String(side||"").toLowerCase();
  if(!["buy","sell"].includes(direction)||!finitePositive(quantity)||
     !Array.isArray(levels)||!levels.length||
     !finiteNonNegative(latencyBufferBps)||!finitePositive(maxSlippageBps)){
    return {status:"invalid_input",filledQuantity:0,avgFillPrice:null,quoteNotional:0,unfilledQuantity:Math.max(0,Number(quantity)||0),fills:[]};
  }
  const normalized=levels.map((row,index)=>({
    price:Number(Array.isArray(row)?row[0]:row?.price),
    amount:Number(Array.isArray(row)?row[1]:row?.amount),
    levelIndex:index
  })).filter(row=>finitePositive(row.price)&&finitePositive(row.amount));
  normalized.sort((a,b)=>direction==="buy"?a.price-b.price:b.price-a.price);
  if(!normalized.length) return {status:"empty_book",filledQuantity:0,avgFillPrice:null,quoteNotional:0,unfilledQuantity:quantity,fills:[]};
  const best=normalized[0].price;
  const maxMove=maxSlippageBps/10_000;
  const buffer=latencyBufferBps/10_000;
  let remaining=quantity,filledQuantity=0,quoteNotional=0;
  const fills=[];
  for(const level of normalized){
    const withinLimit=direction==="buy"
      ? level.price <= best*(1+maxMove)
      : level.price >= best*(1-maxMove);
    if(!withinLimit||remaining<=0)break;
    const qty=Math.min(level.amount,remaining);
    const effectivePrice=level.price*(direction==="buy"?1+buffer:1-buffer);
    const notional=effectivePrice*qty;
    fills.push({levelIndex:level.levelIndex,price:effectivePrice,quantity:qty,quoteNotional:notional});
    filledQuantity+=qty;
    quoteNotional+=notional;
    remaining-=qty;
  }
  const avgFillPrice=filledQuantity>0?quoteNotional/filledQuantity:null;
  const status=remaining<=Math.max(1e-12,quantity*1e-9)?"filled":filledQuantity>0?"partial":"no_liquidity_within_slippage_cap";
  return {status,filledQuantity,avgFillPrice,quoteNotional,unfilledQuantity:Math.max(0,remaining),fills};
}

export function createPaperEntryPlan({
  candidate,analysis,portfolio,book,orderbookLastUpdateMs,nowMs=Date.now()
}={}){
  const block=reason=>({approved:false,action:"skip",reason,liveTradingEnabled:false,exchangeOrderCreated:false});
  if(!qualifiesForPaperWatch(candidate))return block("historical_paper_watch_gate_not_met");
  const symbol=String(candidate.symbol||"").toUpperCase();
  const quoteUnit=symbol.endsWith("IRT")?"RIAL":symbol.endsWith("USDT")?"USDT":null;
  if(!quoteUnit||String(portfolio?.quote_unit||"")!==quoteUnit)return block("quote_portfolio_mismatch");
  if(Number(portfolio?.virtual_only)!==1||Number(portfolio?.paper_enabled)!==1||Number(portfolio?.kill_switch)!==0){
    return block("paper_portfolio_disabled_or_kill_switch_active");
  }
  const strategySignal=String(candidate.strategy||"")==="donchian-breakout"
    ? analysis?.strategySignals?.breakout?.signal
    : analysis?.strategySignals?.trendFollowing?.signal;
  if(!analysis||analysis.available!==true||analysis.decision!=="RESEARCH_BUY_CANDIDATE"||
     strategySignal!=="BUY_CANDIDATE"||
     analysis.forecastAssessment?.confirmsLong!==true||
     analysis.dataQuality?.status!=="usable"||Number(analysis.dataQuality?.materialGapCount)>0||
     analysis.marketState?.volatilityRegime==="high"){
    return block("fresh_forward_buy_signal_not_confirmed");
  }
  const bookAge=nowMs-Number(orderbookLastUpdateMs);
  if(!Number.isFinite(bookAge)||bookAge< -10_000||bookAge>PAPER_LIMITS.maxOrderbookAgeMs){
    return block("orderbook_stale_or_clock_skewed");
  }
  if(!book||!Array.isArray(book.bids)||!Array.isArray(book.asks)||!book.bids.length||!book.asks.length){
    return block("orderbook_missing");
  }
  const bids=book.bids.map(x=>[Number(x[0]),Number(x[1])]).filter(x=>finitePositive(x[0])&&finitePositive(x[1])).sort((a,b)=>b[0]-a[0]);
  const asks=book.asks.map(x=>[Number(x[0]),Number(x[1])]).filter(x=>finitePositive(x[0])&&finitePositive(x[1])).sort((a,b)=>a[0]-b[0]);
  if(!bids.length||!asks.length||asks[0][0]<=bids[0][0])return block("orderbook_crossed_or_invalid");
  const mid=(bids[0][0]+asks[0][0])/2;
  const spreadBps=(asks[0][0]-bids[0][0])/mid*10_000;
  if(spreadBps>PAPER_LIMITS.spreadLimitBps[quoteUnit])return block("spread_gate_failed");
  const depth25=(levels,side)=>{
    const bound=0.0025;
    return levels.filter(([price])=>side==="bid"?price>=mid*(1-bound):price<=mid*(1+bound))
      .reduce((sum,[price,amount])=>sum+price*amount,0);
  };
  const depth=depth25(bids,"bid")+depth25(asks,"ask");
  if(depth<PAPER_LIMITS.depth25Minimum[quoteUnit])return block("depth25_gate_failed");
  const atr=Number(analysis.marketState?.atr14);
  const entryReference=asks[0][0];
  const stop=entryReference-PAPER_LIMITS.stopAtrMultiple*atr;
  const equity=Number(portfolio.starting_equity);
  const cash=Number(portfolio.cash_balance);
  if(!finitePositive(atr)||!finitePositive(stop)||!finitePositive(equity)||!finiteNonNegative(cash)){
    return block("risk_input_invalid");
  }
  const riskPlan=calculateRiskPlan({
    equity:Math.min(equity,cash),entryPrice:entryReference,stopPrice:stop,
    feeBps:Number(portfolio.fee_bps_per_side),
    slippageBps:Number(portfolio.latency_buffer_bps),
    riskFraction:Number(portfolio.risk_fraction),
    maxExposureFraction:Number(portfolio.max_exposure_fraction),
    maxDailyLossFraction:Number(portfolio.max_daily_loss_fraction),
    maxDrawdownFraction:Number(portfolio.max_drawdown_fraction),
    killSwitch:Number(portfolio.kill_switch)===1
  });
  if(!riskPlan.approved)return block("risk_plan_"+riskPlan.reason);
  const fill=walkPaperOrderbook({side:"buy",quantity:riskPlan.quantity,levels:asks,
    latencyBufferBps:Number(portfolio.latency_buffer_bps),maxSlippageBps:PAPER_LIMITS.maxSlippageBps});
  if(!["filled","partial"].includes(fill.status)||!finitePositive(fill.avgFillPrice)){
    return block("paper_fill_"+fill.status);
  }
  const notional=fill.quoteNotional;
  const fee=notional*Number(portfolio.fee_bps_per_side)/10_000;
  if(notional<Number(portfolio.min_notional)){
    return block("minimum_order_notional_not_met");
  }
  if(notional+fee>cash)return block("paper_quote_cash_insufficient");
  const stopPrice=fill.avgFillPrice-PAPER_LIMITS.stopAtrMultiple*atr;
  const takeProfitPrice=fill.avgFillPrice+PAPER_LIMITS.takeProfitRiskMultiple*(fill.avgFillPrice-stopPrice);
  if(!finitePositive(stopPrice)||!finitePositive(takeProfitPrice))return block("stop_or_target_invalid");
  return {
    approved:true,action:"buy",reason:"forward_paper_entry_approved",
    symbol,quoteUnit,strategy:candidate.strategy,resolution:String(candidate.resolution),
    candleTime:Number(analysis.lastCandle.time),requestedQuantity:riskPlan.quantity,
    filledQuantity:fill.filledQuantity,avgFillPrice:fill.avgFillPrice,
    quoteNotional:notional,feePaid:fee,spreadBps,depth25:depth,bookAgeMs:bookAge,
    stopPrice,takeProfitPrice,fillStatus:fill.status,fills:fill.fills,
    riskPlan,liveTradingEnabled:false,exchangeOrderCreated:false
  };
}

export function createPaperExitPlan({position,book,portfolio,orderbookLastUpdateMs,nowMs=Date.now(),reason="signal_exit"}={}){
  const block=why=>({approved:false,action:"skip",reason:why,liveTradingEnabled:false,exchangeOrderCreated:false});
  if(!position||position.status!=="open"||!finitePositive(position.quantity))return block("no_open_paper_position");
  const quoteUnit=String(position.quote_unit||"");
  if(String(portfolio?.quote_unit||"")!==quoteUnit||Number(portfolio?.virtual_only)!==1||
     Number(portfolio?.paper_enabled)!==1)return block("paper_portfolio_mismatch_or_disabled");
  const age=nowMs-Number(orderbookLastUpdateMs);
  if(!Number.isFinite(age)||age< -10_000||age>PAPER_LIMITS.maxOrderbookAgeMs)return block("orderbook_stale_or_clock_skewed");
  if(!book||!Array.isArray(book.bids)||!book.bids.length)return block("bid_book_missing");
  const fill=walkPaperOrderbook({side:"sell",quantity:Number(position.quantity),levels:book.bids,
    latencyBufferBps:Number(portfolio.latency_buffer_bps),maxSlippageBps:PAPER_LIMITS.maxSlippageBps});
  if(!["filled","partial"].includes(fill.status)||!finitePositive(fill.avgFillPrice))return block("paper_exit_"+fill.status);
  const notional=fill.quoteNotional;
  const fee=notional*Number(portfolio.fee_bps_per_side)/10_000;
  if(notional<Number(portfolio.min_notional)&&fill.status==="filled")return block("exit_notional_below_minimum");
  return {
    approved:true,action:"sell",reason,
    symbol:String(position.symbol),quoteUnit,
    strategy:String(position.strategy),resolution:String(position.resolution),
    candleTime:position.exitCandleTime??null,
    requestedQuantity:Number(position.quantity),filledQuantity:fill.filledQuantity,
    avgFillPrice:fill.avgFillPrice,quoteNotional:notional,feePaid:fee,
    bookAgeMs:age,fillStatus:fill.status,fills:fill.fills,
    remainingQuantity:fill.unfilledQuantity,
    liveTradingEnabled:false,exchangeOrderCreated:false
  };
}

export function calculatePaperPortfolioRisk({portfolio,openPositions=[],markPrices={}}={}){
  const cash=Number(portfolio?.cash_balance);
  const starting=Number(portfolio?.starting_equity);
  const peak=Number(portfolio?.peak_equity);
  const dayStart=Number(portfolio?.day_start_equity);
  if(!finiteNonNegative(cash)||![starting,peak,dayStart].every(finitePositive))return {valid:false,killSwitch:true,reason:"invalid_paper_portfolio"};
  const openNotional=openPositions.reduce((sum,p)=>{
    const mark=Number(markPrices[p.symbol]??p.last_mark_price);
    return sum+(finitePositive(mark)?Number(p.quantity)*mark:0);
  },0);
  const equity=cash+openNotional;
  const peakEquity=Math.max(peak,equity);
  const dailyLossFraction=Math.max(0,(dayStart-equity)/dayStart);
  const drawdownFraction=Math.max(0,(peakEquity-equity)/peakEquity);
  const triggered=Number(portfolio.kill_switch)===1||
    dailyLossFraction>=Number(portfolio.max_daily_loss_fraction)||
    drawdownFraction>=Number(portfolio.max_drawdown_fraction);
  return {valid:true,equity,cash,openNotional,peakEquity,dailyLossFraction,drawdownFraction,
    killSwitch:triggered,reason:triggered?"paper_risk_limit_or_kill_switch":"within_paper_risk_limits"};
}
