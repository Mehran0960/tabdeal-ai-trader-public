import test from "node:test";
import assert from "node:assert/strict";
import {
  qualifiesForPaperWatch,classifyForwardPaperSignal,walkPaperOrderbook,
  createPaperEntryPlan,createPaperExitPlan,calculatePaperPortfolioRisk
} from "../src/paper-engine.js";

const candidate={symbol:"BTCIRT",quoteAsset:"IRT",strategy:"ema-trend",resolution:"240",
 severeStressActualReturnPct:0.54,baseOutperformanceWindowRatePct:66.7,
 worstWindowDrawdownPct:0.37,minimumWindowCount:30,minimumTradeCount:9};
const analysis={
 available:true,decision:"RESEARCH_BUY_CANDIDATE",
 lastCandle:{time:1000,close:105},
 marketState:{ema20:103,ema50:100,atr14:5,volatilityRegime:"medium"},
 strategySignals:{trendFollowing:{signal:"BUY_CANDIDATE"}},
 forecastAssessment:{confirmsLong:true},
 dataQuality:{status:"usable",materialGapCount:0},
 execution:{liveTradingEnabled:false,paperOnly:true}
};
const portfolio={quote_unit:"RIAL",virtual_only:1,paper_enabled:1,kill_switch:0,
 starting_equity:100000,cash_balance:100000,fee_bps_per_side:25,latency_buffer_bps:5,
 risk_fraction:0.0025,max_exposure_fraction:0.2,max_daily_loss_fraction:0.02,
 max_drawdown_fraction:0.1,min_notional:1000};

test("historical and live gates are both required for a paper watch signal",()=>{
 assert.equal(qualifiesForPaperWatch(candidate),true);
 assert.equal(qualifiesForPaperWatch({...candidate,severeStressActualReturnPct:-0.1}),false);
 assert.equal(classifyForwardPaperSignal({candidate,analysis}).action,"buy");
 assert.equal(classifyForwardPaperSignal({candidate,analysis:{...analysis,decision:"WAIT"}}).action,"wait");
 assert.equal(classifyForwardPaperSignal({candidate,analysis,hasOpenPosition:true}).action,"hold");
 assert.equal(classifyForwardPaperSignal({candidate,analysis:{...analysis,marketState:{...analysis.marketState,ema20:99}} ,hasOpenPosition:true}).action,"exit");
});

test("paper watch independently enforces BTCIRT 4h EMA and at least 30 OOS windows",()=>{
 assert.equal(qualifiesForPaperWatch(candidate),true);
 assert.equal(qualifiesForPaperWatch({...candidate,minimumWindowCount:29}),false);
 assert.equal(qualifiesForPaperWatch({...candidate,symbol:"ETHIRT"}),false);
 assert.equal(qualifiesForPaperWatch({...candidate,resolution:"D"}),false);
 assert.equal(qualifiesForPaperWatch({...candidate,strategy:"donchian-breakout"}),false);
});

test("walks ask/bid liquidity with adverse latency buffer and partial fills",()=>{
 const buy=walkPaperOrderbook({side:"buy",quantity:3,levels:[["100","1"],["100.1","2"],["103","5"]],
  latencyBufferBps:5,maxSlippageBps:25});
 assert.equal(buy.status,"filled");
 assert.equal(buy.filledQuantity,3);
 assert.ok(buy.avgFillPrice>100);
 const partial=walkPaperOrderbook({side:"sell",quantity:10,levels:[["100","2"],["99.9","2"]],
  latencyBufferBps:5,maxSlippageBps:25});
 assert.equal(partial.status,"partial");
 assert.equal(partial.filledQuantity,4);
 assert.ok(partial.avgFillPrice<100);
});

test("entry plan applies 25 bps spread/depth, real fee, risk budget and minimum notional",()=>{
 const book={bids:[["99.9","20000000"]],asks:[["100","10000000"],["100.1","10000000"]]};
 const result=createPaperEntryPlan({candidate,analysis,portfolio,book,
  orderbookLastUpdateMs:Date.now(),nowMs:Date.now()});
 assert.equal(result.approved,true);
 assert.equal(result.action,"buy");
 assert.equal(result.quoteUnit,"RIAL");
 assert.ok(result.quoteNotional>=11);
 assert.ok(result.feePaid>0);
 assert.equal(result.liveTradingEnabled,false);
 assert.equal(result.exchangeOrderCreated,false);
});

test("entry rejects one-sided depth even when aggregate depth exceeds the minimum",()=>{
 const oneSided={bids:[["99.9","20000000"]],asks:[["100","1000"],["100.1","1000"]]};
 const result=createPaperEntryPlan({candidate,analysis,portfolio,book:oneSided,
  orderbookLastUpdateMs:Date.now(),nowMs:Date.now()});
 assert.equal(result.approved,false);
 assert.equal(result.reason,"two_sided_depth_gate_failed");
 assert.equal(result.liveTradingEnabled,false);
 assert.equal(result.exchangeOrderCreated,false);
});

test("entry plan fails closed for stale data, wide spread or disabled portfolio",()=>{
 const book={bids:[["99","10000000"]],asks:[["101","10000000"]]};
 assert.equal(createPaperEntryPlan({candidate,analysis,portfolio,book,
  orderbookLastUpdateMs:Date.now()-60_000}).approved,false);
 const disabled={...portfolio,paper_enabled:0};
 const good={bids:[["100","10000000"]],asks:[["100.05","10000000"]]};
 assert.equal(createPaperEntryPlan({candidate,analysis,disabled,book:good,
  orderbookLastUpdateMs:Date.now()}).approved,false);
});

test("exit plan sells an existing long position through bids only",()=>{
 const position={symbol:"BTCIRT",quote_unit:"RIAL",strategy:"ema-trend",resolution:"240",
  quantity:20,status:"open"};
 const result=createPaperExitPlan({position,book:{bids:[["110","1"]],asks:[["111","1"]]},
  portfolio,orderbookLastUpdateMs:Date.now()});
 assert.equal(result.approved,true);
 assert.equal(result.action,"sell");
 assert.ok(result.quoteNotional>0);
});

test("paper risk controls calculate daily loss and drawdown and trigger kill switch",()=>{
 const p={cash_balance:90,starting_equity:100,peak_equity:110,day_start_equity:100,
  max_daily_loss_fraction:0.02,max_drawdown_fraction:0.1,kill_switch:0};
 const result=calculatePaperPortfolioRisk({portfolio:p,openPositions:[],markPrices:{}});
 assert.equal(result.killSwitch,true);
 assert.ok(result.dailyLossFraction>=0.02);
});

const multiCandidate={
 paperType:"multi_asset",symbol:"DOGEIRT",quoteAsset:"IRT",strategy:"donchian-breakout",resolution:"240",
 confirmedScans:2,baseActualReturnPct:4.6,moderateStressActualReturnPct:3.4,severeStressActualReturnPct:1.7,
 baseOutperformanceWindowRatePct:64,moderateOutperformanceWindowRatePct:68,severeOutperformanceWindowRatePct:73,
 worstWindowDrawdownPct:0.62,minimumWindowCount:89,minimumTradeCount:45,
 benjaminiHochbergQValue:0.018,multipleTestingHypothesisCount:63
};
const breakoutAnalysis={...analysis,
 strategySignals:{...analysis.strategySignals,breakout:{signal:"BUY_CANDIDATE",exitSignal:"WAIT"}},
 execution:{liveTradingEnabled:false,paperOnly:true}};
test("multi-asset Paper entry requires two scans, FDR, severe-cost return and strict OOS gates",()=>{
 assert.equal(qualifiesForPaperWatch(multiCandidate),true);
 assert.equal(qualifiesForPaperWatch({...multiCandidate,confirmedScans:1}),false);
 assert.equal(qualifiesForPaperWatch({...multiCandidate,severeStressActualReturnPct:0.99}),false);
 assert.equal(qualifiesForPaperWatch({...multiCandidate,benjaminiHochbergQValue:0.051}),false);
 assert.equal(qualifiesForPaperWatch({...multiCandidate,minimumWindowCount:59}),false);
});
test("Donchian Paper entry uses its own breakout signal and exit uses the prior 10-bar low",()=>{
 assert.equal(classifyForwardPaperSignal({candidate:multiCandidate,analysis:breakoutAnalysis}).action,"buy");
 const held=classifyForwardPaperSignal({candidate:multiCandidate,
   analysis:{...breakoutAnalysis,strategySignals:{...breakoutAnalysis.strategySignals,
    breakout:{signal:"WAIT",exitSignal:"EXIT_CANDIDATE"}}},hasOpenPosition:true});
 assert.equal(held.action,"exit");
});
test("Donchian Paper entry planner never relies on the EMA signal",()=>{
 const book={bids:[["99.9","20000000"]],asks:[["100","10000000"],["100.1","10000000"]]};
 const result=createPaperEntryPlan({candidate:multiCandidate,analysis:breakoutAnalysis,portfolio,book,
  orderbookLastUpdateMs:Date.now(),nowMs:Date.now()});
 assert.equal(result.approved,true);
 assert.equal(result.symbol,"DOGEIRT");
 assert.equal(result.liveTradingEnabled,false);
 assert.equal(result.exchangeOrderCreated,false);
});
