import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInternationalResearchRows,exactBinomialUpperTail,
  benjaminiHochbergAdjust,runInternationalStrategyResearch
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
    {...candle("BTCUSDT",2),recordType:"tabdeal_book",provider:"tabdeal_spot"},candle("DOGEUSDT",0)];
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
