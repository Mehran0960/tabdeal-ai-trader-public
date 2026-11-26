import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInternationalResearchRows,exactBinomialUpperTail,
  benjaminiHochbergAdjust,calculateContiguousOosBenchmark,runInternationalStrategyResearch
} from "../src/international-strategy-research.js";
const interval=14_400_000,now=Date.parse("2026-11-26T12:00:00.000Z");
function candle(symbol,index,close=100){
  const openTimeMs=Date.UTC(2026,0,1)+index*interval;
  return {recordType:"candle",provider:"binance_spot",symbol,baseAsset:symbol.slice(0,-4),
    quoteAsset:"USDT",quoteUnit:"USDT",interval:"4h",openTimeMs,
    closeTimeMs:openTimeMs+interval-1,open:close,high:close*1.01,low:close*0.99,
    close,baseVolume:10,quoteVolume:close*10,tradeCount:100};
}
test("normalizes only allowlisted, valid Binance Spot 4h USDT candles",()=>{
  const rows=[candle("BTCUSDT",0),candle("BTCUSDT",1),
    {...candle("BTCUSDT",2),recordType:"tabdeal_book",provider:"tabdeal_spot"},candle("ADAUSDT",0)];
  const result=normalizeInternationalResearchRows(rows,{nowMs:Date.UTC(2026,11,1)});
  assert.equal(result.candlesBySymbol.BTCUSDT.length,2);
  assert.equal(result.selectedRecordCount,2);
  assert.equal(result.ignoredRecordCount,2);
});
test("rejects conflicting duplicate bars and invalid quote-unit mapping",()=>{
  const first=candle("BTCUSDT",0);
  assert.throws(()=>normalizeInternationalResearchRows([first,{...first,baseVolume:first.baseVolume+1}],
    {nowMs:Date.UTC(2026,11,1)}),/conflicting_duplicate/);
  assert.throws(()=>normalizeInternationalResearchRows([{...first,quoteUnit:"TOMAN"}],
    {nowMs:Date.UTC(2026,11,1)}),/candle_invalid/);
});
test("deduplicates identical candle observations",()=>{
  const row=candle("ETHUSDT",0);
  const result=normalizeInternationalResearchRows([row,{...row}],{nowMs:Date.UTC(2026,11,1)});
  assert.equal(result.candlesBySymbol.ETHUSDT.length,1);
  assert.equal(result.duplicateCount,1);
});
test("calculates the exact one-sided binomial tail used by the OOS sign test",()=>{
  assert.equal(exactBinomialUpperTail(4,4),0.0625);
  assert.equal(exactBinomialUpperTail(3,4),0.3125);
  assert.equal(exactBinomialUpperTail(2,4),0.6875);
  assert.equal(exactBinomialUpperTail(0,4),1);
});
test("applies monotone Benjamini-Hochberg q-value correction",()=>{
  const result=benjaminiHochbergAdjust([{id:"a",pValue:0.001},{id:"b",pValue:0.01},{id:"c",pValue:0.03}]);
  assert.deepEqual(result.map(x=>Number(x.qValue.toFixed(6))),[0.003,0.015,0.03]);
});
test("fails closed with no promotion when history is too short or stale",()=>{
  const report=runInternationalStrategyResearch({rows:[candle("BTCUSDT",0),candle("BTCUSDT",1)],nowMs:now});
  assert.equal(report.status,"data_not_ready");
  assert.equal(report.researchCandidates.length,0);
  assert.equal(report.paperGate.passed,false);
  assert.equal(report.safety.exchangeOrdersPlaced,0);
  assert.equal(report.safety.liveTradingEnabled,false);
});


test("compounds buy-and-hold once per contiguous OOS segment, not once per fold",()=>{
  const candles=Array.from({length:8},(_,index)=>({
    time:1000+index*14_400,open:100,high:140,low:90,close:index===6?130:100,volume:1
  }));
  const windows=[
    {segmentIndex:1,startIndex:1,endIndex:3},
    {segmentIndex:1,startIndex:4,endIndex:6}
  ];
  const result=calculateContiguousOosBenchmark(candles,windows,{
    feeBpsPerSide:10,slippageBpsPerSide:10
  });
  const expected=((130*0.998)/(100*1.002)-1)*100;
  assert.equal(result.segmentCount,1);
  assert.equal(result.roundTrips,1);
  assert.ok(Math.abs(result.benchmarkReturnPct-expected)<1e-10);
});



test("supports independently validated 15m, 1h and 4h research profiles",()=>{
  const rows=[];
  for(const interval of ["15m","1h","4h","1d"]){
    const duration=({"15m":900_000,"1h":3_600_000,"4h":14_400_000,"1d":86_400_000})[interval];
    for(let index=0;index<3;index++){
      const openTimeMs=Date.UTC(2026,0,1)+index*duration;
      const price=100+index;
      rows.push({
        recordType:"candle",provider:"binance_spot",symbol:"BTCUSDT",
        baseAsset:"BTC",quoteAsset:"USDT",quoteUnit:"USDT",interval,
        openTimeMs,closeTimeMs:openTimeMs+duration-1,
        open:price,high:price*1.01,low:price*0.99,close:price,
        baseVolume:10,quoteVolume:price*10,tradeCount:100
      });
    }
  }
  for(const interval of ["15m","1h","4h"]){
    const result=normalizeInternationalResearchRows(rows,{nowMs:now,interval});
    assert.equal(result.candlesBySymbol.BTCUSDT.length,3);
    assert.equal(result.qualityBySymbol.BTCUSDT.candleCount,3);
  }
});

test("applies global multiple-testing correction across all interval profiles",()=>{
  const report=runInternationalStrategyResearch({
    rows:[candle("BTCUSDT",0),candle("BTCUSDT",1)],
    nowMs:now,
    intervals:["15m","1h","4h"]
  });
  assert.equal(report.methodology.hypothesisCount,180);
  assert.deepEqual(report.source.intervals,["15m","1h","4h","1d"]);
  assert.deepEqual(report.source.symbols,["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT"]);
  assert.equal(report.results.length,180);
  assert.equal(report.dataQuality.profiles.length,4);
  assert.ok(report.results.every(row=>Number(row.qValue)===1));
  assert.equal(report.researchCandidates.length,0);
  assert.equal(report.paperGate.passed,false);
  assert.equal(report.safety.liveTradingEnabled,false);
});

test("does not mix quote units or execute external market prices",()=>{
  const report=runInternationalStrategyResearch({rows:[],nowMs:now,intervals:["1h"]});
  assert.equal(report.source.quoteAsset,"USDT");
  assert.equal(report.source.internationalQuotesNotUsedAsTabdealExecutionPrices,true);
  assert.equal(report.paperGate.passed,false);
  assert.equal(report.safety.accountDataRead,false);
  assert.equal(report.safety.exchangeOrdersPlaced,0);
});


test("accepts DOGEUSDT as a pre-registered Binance Spot research asset",()=>{
  const row=candle("DOGEUSDT",0);
  const result=normalizeInternationalResearchRows([row],{nowMs:Date.UTC(2026,11,1)});
  assert.equal(result.candlesBySymbol.DOGEUSDT.length,1);
  assert.equal(result.selectedRecordCount,1);
  assert.equal(result.qualityBySymbol.DOGEUSDT.candleCount,1);
});


test("pre-registers a daily horizon with 60 disjoint 30-day OOS windows and a full 80/20 split",()=>{
  const rows=[];
  const duration=86_400_000;
  for(const symbol of ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT"]){
    for(let index=0;index<3;index++){
      const openTimeMs=Date.UTC(2026,0,1)+index*duration;
      const price=100+index;
      rows.push({
        recordType:"candle",provider:"binance_spot",symbol,
        baseAsset:symbol.slice(0,-4),quoteAsset:"USDT",quoteUnit:"USDT",interval:"1d",
        openTimeMs,closeTimeMs:openTimeMs+duration-1,
        open:price,high:price*1.01,low:price*0.99,close:price,
        baseVolume:10,quoteVolume:price*10,tradeCount:100
      });
    }
  }
  const report=runInternationalStrategyResearch({rows,nowMs:now,intervals:["1d"]});
  assert.equal(report.methodology.hypothesisCount,45);
  const daily=report.methodology.profiles[0];
  assert.equal(daily.interval,"1d");
  assert.equal(daily.resolutionSeconds,86_400);
  assert.equal(daily.trainBars,250);
  assert.equal(daily.testBars,30);
  assert.equal(daily.stepBars,30);
  assert.equal(daily.minimumOutOfSampleWindows,60);
  assert.equal(report.researchCandidates.length,0);
  assert.equal(report.paperGate.passed,false);
});
