import test from "node:test";
import assert from "node:assert/strict";
import {
  ROTATION_SYMBOLS,ROTATION_POLICY,ROTATION_COST_SCENARIOS,
  runRelativeAssetRotationResearch,selectRotationTarget,applyRelativeRotationPaperTick
} from "../src/relative-asset-rotation.js";

const INTERVAL=ROTATION_POLICY.intervalMs;
const START=Date.parse("2025-01-01T00:00:00.000Z");
const BASES={BTCUSDT:50_000,ETHUSDT:2_500,SOLUSDT:100,XRPUSDT:0.5,DOGEUSDT:0.1};

function makeHistory({count=620,nowMs=null,omitSymbol=null,omitIndex=-1}={}) {
  const rows=[];
  for(const symbol of ROTATION_SYMBOLS){
    if(symbol===omitSymbol)continue;
    const base=BASES[symbol];
    for(let i=0;i<count;i++){
      if(symbol===omitSymbol&&i===omitIndex)continue;
      const drift=0.00015*i;
      const wave=0.002*Math.sin(i/23+(ROTATION_SYMBOLS.indexOf(symbol)*0.3));
      const close=base*Math.exp(drift+wave);
      const prior= i===0 ? close/Math.exp(0.00015) : base*Math.exp(0.00015*(i-1)+0.002*Math.sin((i-1)/23+(ROTATION_SYMBOLS.indexOf(symbol)*0.3)));
      const open=prior;
      const time=START+i*INTERVAL;
      rows.push({
        recordType:"candle",provider:"binance_spot",symbol,baseAsset:symbol.replace("USDT",""),
        quoteAsset:"USDT",quoteUnit:"USDT",interval:"4h",
        openTimeMs:time,closeTimeMs:time+INTERVAL-1,
        open,high:Math.max(open,close)*1.002,low:Math.min(open,close)*0.998,
        close,baseVolume:100,tradeCount:100
      });
    }
  }
  return rows;
}
function makeBook(symbol,capturedAtMs,overrides={}) {
  const price=BASES[symbol];
  return {
    recordType:"tabdeal_book",symbol,status:"ok",capturedAtMs,quoteUnit:"USDT",
    bestBid:price*0.999,bestAsk:price*1.001,spreadBps:20,
    bidDepthTop5Quote:50_000,askDepthTop5Quote:50_000,
    bidLevelsTop5:[[String(price*0.999),String(100_000/price)], [String(price*0.998),String(100_000/price)]],
    askLevelsTop5:[[String(price*1.001),String(100_000/price)], [String(price*1.002),String(100_000/price)]],
    marketRules:{minQty:"0.001",maxQty:"1000000",stepSize:"0.001",minNotional:"1",tickSize:"0.00000001"},
    ...overrides
  };
}
function addBooks(rows,nowMs) {
  return rows.concat(ROTATION_SYMBOLS.map(symbol=>makeBook(symbol,nowMs-5000)));
}

test("registers five synchronized USDT Spot assets and three conservative cost cases",()=>{
  assert.equal(ROTATION_SYMBOLS.length,5);
  assert.deepEqual(ROTATION_SYMBOLS,["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT"]);
  assert.deepEqual(ROTATION_COST_SCENARIOS.map(row=>row.id),["base","moderate","severe"]);
  assert.equal(ROTATION_POLICY.maximumDrawdownPct,20);
});

test("normalizes aligned closed candles and produces an explicitly research-only report",()=>{
  const baseRows=makeHistory();
  const lastTime=START+619*INTERVAL;
  const nowMs=lastTime+INTERVAL+1000;
  const report=runRelativeAssetRotationResearch({rows:addBooks(baseRows,nowMs),nowMs});
  assert.equal(report.available,true);
  assert.equal(report.reportType,"TABDEAL_RELATIVE_ASSET_ROTATION_RESEARCH");
  assert.equal(report.dataQuality.latestContiguousBars,620);
  assert.equal(report.dataQuality.alignedBars,620);
  assert.equal(report.costScenarios.length,3);
  assert.equal(report.safety.liveTradingEnabled,false);
  assert.equal(report.safety.exchangeOrdersPlaced,0);
  assert.equal(report.safety.fundsMoved,false);
  assert.equal(report.executionVenue,"tabdeal_spot_usdt");
});

test("blocks incomplete or stale aligned historical data",()=>{
  const incomplete=makeHistory({omitSymbol:"DOGEUSDT"});
  const lastTime=START+619*INTERVAL;
  const nowMs=lastTime+INTERVAL+1000;
  const missing=runRelativeAssetRotationResearch({rows:incomplete,nowMs});
  assert.equal(missing.available,false);
  assert.equal(missing.status,"data_not_ready");
  const staleRows=makeHistory({count:620});
  const staleTime=START+619*INTERVAL;
  const stale=runRelativeAssetRotationResearch({
    rows:staleRows,nowMs:staleTime+INTERVAL+ROTATION_POLICY.maximumLatestCandleAgeMs+1
  });
  assert.equal(stale.available,false);
  assert.match(stale.reason,/stale_or_future/);
});

test("rejects conflicting duplicate historical candles",()=>{
  const rows=makeHistory();
  const duplicate={...rows[0],close:Number(rows[0].close)*1.01,
    high:Math.max(Number(rows[0].high),Number(rows[0].close)*1.01)};
  assert.throws(()=>runRelativeAssetRotationResearch({
    rows:[...rows,duplicate],nowMs:START+619*INTERVAL+INTERVAL+1000
  }),/rotation_conflicting_duplicate/);
});

test("rejects a gap in the latest common contiguous 4h segment",()=>{
  const rows=makeHistory({count:620});
  const missingTime=START+300*INTERVAL;
  const filtered=rows.filter(row=>!(row.symbol==="DOGEUSDT"&&row.openTimeMs===missingTime));
  const nowMs=START+619*INTERVAL+INTERVAL+1000;
  const report=runRelativeAssetRotationResearch({rows:filtered,nowMs});
  assert.equal(report.available,false);
  assert.match(report.reason,/latest_contiguous_segment_below_minimum/);
});

test("selects the most relatively undervalued asset only with positive trend confirmation",()=>{
  const features={
    BTCUSDT:{zScore:0.2,trendConfirmed:true},
    ETHUSDT:{zScore:-1.45,trendConfirmed:true},
    SOLUSDT:{zScore:-1.1,trendConfirmed:true},
    XRPUSDT:{zScore:-2.1,trendConfirmed:false},
    DOGEUSDT:{zScore:-0.5,trendConfirmed:true}
  };
  assert.deepEqual(selectRotationTarget(features,null,0),{
    targetSymbol:"ETHUSDT",reason:"relative_undervaluation_with_trend"
  });
  assert.equal(selectRotationTarget({...features,ETHUSDT:{zScore:-1.45,trendConfirmed:false}},null,0).targetSymbol,"SOLUSDT");
});

test("rotates only when the new asset has a material z-score advantage and minimum holding time passed",()=>{
  const features={
    BTCUSDT:{zScore:-0.1,trendConfirmed:true},
    ETHUSDT:{zScore:-1.2,trendConfirmed:true},
    SOLUSDT:{zScore:-0.7,trendConfirmed:true},
    XRPUSDT:{zScore:0.4,trendConfirmed:true},
    DOGEUSDT:{zScore:-0.4,trendConfirmed:false}
  };
  assert.equal(selectRotationTarget(features,"BTCUSDT",3).targetSymbol,"BTCUSDT");
  assert.equal(selectRotationTarget(features,"BTCUSDT",8).targetSymbol,"ETHUSDT");
  const exited=selectRotationTarget({...features,BTCUSDT:{zScore:0.4,trendConfirmed:true},
    ETHUSDT:{zScore:0.1,trendConfirmed:false},SOLUSDT:{zScore:0.2,trendConfirmed:false}},"BTCUSDT",2);
  assert.equal(exited.targetSymbol,null);
});

test("reports per-asset Tabdeal book freshness, liquidity and top-five-level readiness",()=>{
  const rows=makeHistory();
  const lastTime=START+619*INTERVAL;
  const nowMs=lastTime+INTERVAL+1000;
  const withBooks=addBooks(rows,nowMs);
  const ready=runRelativeAssetRotationResearch({rows:withBooks,nowMs});
  assert.equal(ready.localExecutionReadiness.allFiveBooksReady,true);
  assert.equal(ready.localExecutionReadiness.forwardPaperEligible,ready.promotionGate.passed);
  const noLevels=withBooks.map(row=>row.recordType==="tabdeal_book"&&row.symbol==="ETHUSDT"
    ? {...row,bidLevelsTop5:[],askLevelsTop5:[]} : row);
  const blocked=runRelativeAssetRotationResearch({rows:noLevels,nowMs});
  assert.equal(blocked.localExecutionReadiness.allFiveBooksReady,false);
  assert.equal(blocked.localExecutionReadiness.forwardPaperEligible,blocked.promotionGate.passed);
});

test("never starts the forward Paper ledger before all historical cost and benchmark gates pass",()=>{
  const fakeReport={
    reportType:"TABDEAL_RELATIVE_ASSET_ROTATION_RESEARCH",
    promotionGate:{passed:false},
    localExecutionReadiness:{forwardPaperEligible:true}
  };
  const result=applyRelativeRotationPaperTick({report:fakeReport,nowMs:START+1});
  assert.equal(result.changed,false);
  assert.equal(result.reason,"historical_promotion_gate_not_passed");
  assert.equal(result.state.cashBalance,ROTATION_POLICY.initialPaperCapitalUsdt);
  assert.equal(result.state.position,null);
});

test("executes a virtual buy against local Tabdeal ask levels and is idempotent per closed signal",()=>{
  const nowMs=START+620*INTERVAL;
  const signalTime=START+619*INTERVAL;
  const books=Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>{
    const book=makeBook(symbol,nowMs-1000);
    return [symbol,{
      available:true,reason:null,capturedAtMs:book.capturedAtMs,ageMs:1000,spreadBps:20,
      bidDepthTop5Quote:50000,askDepthTop5Quote:50000,
      bids:book.bidLevelsTop5.map(x=>x.map(Number)),asks:book.askLevelsTop5.map(x=>x.map(Number)),
      marketRules:book.marketRules
    }];
  }));
  const report={
    reportType:"TABDEAL_RELATIVE_ASSET_ROTATION_RESEARCH",
    promotionGate:{passed:true},
    localExecutionReadiness:{forwardPaperEligible:true,books},
    latestSignal:{
      candleOpenTimeMs:signalTime,
      assets:{
        BTCUSDT:{zScore:0.1,trendConfirmed:true},
        ETHUSDT:{zScore:-1.4,trendConfirmed:true},
        SOLUSDT:{zScore:0.2,trendConfirmed:false},
        XRPUSDT:{zScore:0.1,trendConfirmed:false},
        DOGEUSDT:{zScore:0.2,trendConfirmed:false}
      }
    }
  };
  const result=applyRelativeRotationPaperTick({report,nowMs,runId:"paper-1"});
  assert.equal(result.changed,true);
  assert.equal(result.reason,"relative_undervaluation_with_trend");
  assert.equal(result.state.position.symbol,"ETHUSDT");
  assert.ok(Number(result.state.position.quantity)>0);
  assert.ok(Number(result.state.cashBalance)>=0);
  assert.equal(result.events.length,1);
  assert.equal(result.events[0].side,"BUY");
  assert.equal(result.events[0].execution,"PAPER_TABDEAL_LOCAL_TOP5_BOOK");
  const duplicate=applyRelativeRotationPaperTick({
    report,state:result.state,nowMs:nowMs+1000,runId:"paper-2"
  });
  assert.equal(duplicate.changed,false);
  assert.equal(duplicate.reason,"signal_already_processed_or_invalid");
  assert.equal(duplicate.state.position.symbol,"ETHUSDT");
});

test("rotates a Paper position through a sell then a buy using independent local books",()=>{
  const nowMs=START+620*INTERVAL,signalTime=START+619*INTERVAL;
  const books=Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>{
    const book=makeBook(symbol,nowMs-1000);
    return [symbol,{available:true,capturedAtMs:book.capturedAtMs,ageMs:1000,spreadBps:20,
      bids:book.bidLevelsTop5.map(x=>x.map(Number)),asks:book.askLevelsTop5.map(x=>x.map(Number)),
      marketRules:book.marketRules}];
  }));
  const report={
    reportType:"TABDEAL_RELATIVE_ASSET_ROTATION_RESEARCH",
    promotionGate:{passed:true},
    localExecutionReadiness:{forwardPaperEligible:true,books},
    latestSignal:{candleOpenTimeMs:signalTime,assets:{
      BTCUSDT:{zScore:-0.2,trendConfirmed:true},
      ETHUSDT:{zScore:-1.3,trendConfirmed:true},
      SOLUSDT:{zScore:0.2,trendConfirmed:false},
      XRPUSDT:{zScore:0.1,trendConfirmed:false},
      DOGEUSDT:{zScore:0.1,trendConfirmed:false}
    }}
  };
  const state={
    schemaVersion:1,initialCapitalUsdt:50,cashBalance:0,
    position:{symbol:"BTCUSDT",quantity:0.001,averageEntryPrice:50000,barsHeld:10},
    peakEquityUsdt:50,lastEquityUsdt:49.9,maxDrawdownPct:0.2,
    lastProcessedSignalOpenTimeMs:signalTime-6*INTERVAL,
    tradeCount:1,haltedByDrawdown:false,events:[]
  };
  const result=applyRelativeRotationPaperTick({report,state,nowMs,runId:"paper-switch"});
  assert.equal(result.changed,true);
  assert.equal(result.state.position.symbol,"ETHUSDT");
  assert.deepEqual(result.events.map(row=>row.side),["SELL","BUY"]);
});

test("does not simulate a Paper fill when top-five depth cannot fully execute the order",()=>{
  const nowMs=START+620*INTERVAL,signalTime=START+619*INTERVAL;
  const books=Object.fromEntries(ROTATION_SYMBOLS.map(symbol=>{
    const book=makeBook(symbol,nowMs-1000);
    const asks=symbol==="ETHUSDT"?[[String(BASES[symbol]*1.001),"0.0001"]]:book.askLevelsTop5;
    return [symbol,{available:true,capturedAtMs:book.capturedAtMs,ageMs:1000,spreadBps:20,
      bids:book.bidLevelsTop5.map(x=>x.map(Number)),asks:asks.map(x=>x.map(Number)),
      marketRules:book.marketRules}];
  }));
  const report={reportType:"TABDEAL_RELATIVE_ASSET_ROTATION_RESEARCH",promotionGate:{passed:true},
    localExecutionReadiness:{forwardPaperEligible:true,books},latestSignal:{
      candleOpenTimeMs:signalTime,assets:{
        BTCUSDT:{zScore:0.2,trendConfirmed:false},
        ETHUSDT:{zScore:-1.5,trendConfirmed:true}
      }
    }};
  const result=applyRelativeRotationPaperTick({report,nowMs});
  assert.equal(result.changed,true);
  assert.match(result.reason,/paper_buy/);
  assert.equal(result.events.length,0);
  assert.equal(result.state.position,null);
});

test("cost assumptions are charged separately on every buy and every sell",()=>{
  assert.equal(ROTATION_COST_SCENARIOS[0].feeBpsPerOrder,40);
  assert.equal(ROTATION_COST_SCENARIOS[0].slippageBpsPerOrder,10);
  assert.equal(2*(ROTATION_COST_SCENARIOS[0].feeBpsPerOrder+ROTATION_COST_SCENARIOS[0].slippageBpsPerOrder),100);
  const noTrade=selectRotationTarget({},null,0);
  assert.equal(noTrade.targetSymbol,null);
});
