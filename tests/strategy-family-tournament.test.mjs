import test from "node:test";
import assert from "node:assert/strict";
import {
  STRATEGY_FAMILIES, STRATEGY_TOURNAMENT_COSTS, STRATEGY_TOURNAMENT_POLICY,
  normalizeStrategyTournamentHistory, runStrategyFamilyTournament,
  strategyTournamentInternals
} from "../src/strategy-family-tournament.js";
const INTERVAL=STRATEGY_TOURNAMENT_POLICY.intervalMs;
const START=Date.parse("2020-01-01T00:00:00.000Z");
const SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT"];
const BASES={BTCUSDT:30000,ETHUSDT:1000,SOLUSDT:40,XRPUSDT:0.3,DOGEUSDT:0.05};
function makeRows({count=900,omitSymbol=null,omitIndex=-1}={}){
  const rows=[];
  for(let s=0;s<SYMBOLS.length;s++){
    const symbol=SYMBOLS[s];
    for(let i=0;i<count;i++){
      if(symbol===omitSymbol&&i===omitIndex)continue;
      const trend=0.00012*i,wave=0.018*Math.sin(i/35+s*0.7),cycle=0.008*Math.sin(i/9+s*0.5);
      const close=BASES[symbol]*Math.exp(trend+wave+cycle);
      const previousClose=i===0?close/Math.exp(0.00012):
        BASES[symbol]*Math.exp(0.00012*(i-1)+0.018*Math.sin((i-1)/35+s*0.7)+
          0.008*Math.sin((i-1)/9+s*0.5));
      const open=previousClose,time=START+i*INTERVAL;
      rows.push({recordType:"candle",provider:"binance_spot",symbol,baseAsset:symbol.replace("USDT",""),
        quoteAsset:"USDT",quoteUnit:"USDT",interval:"4h",openTimeMs:time,
        closeTimeMs:time+INTERVAL-1,open,high:Math.max(open,close)*1.002,
        low:Math.min(open,close)*0.998,close,baseVolume:1000,tradeCount:1000});
    }
  }
  return rows;
}
const TEST_NOW=START+900*INTERVAL+1000;

test("pre-registers three Spot-only strategy families and three escalating cost cases",()=>{
  assert.deepEqual(STRATEGY_FAMILIES.map(row=>row.id),["relative_value","momentum","hybrid"]);
  assert.deepEqual(STRATEGY_TOURNAMENT_COSTS.map(row=>row.id),["base","moderate","severe"]);
  assert.equal(STRATEGY_TOURNAMENT_POLICY.maximumDrawdownPct,20);
  assert.equal(STRATEGY_TOURNAMENT_POLICY.discoveryFraction,0.70);
});
test("normalizes synchronized closed Binance USDT candles and keeps one contiguous segment",()=>{
  const history=normalizeStrategyTournamentHistory(makeRows(),{nowMs:TEST_NOW});
  assert.equal(history.available,true);
  assert.equal(history.symbols.length,5);
  assert.equal(history.latestContiguousBars,900);
  assert.equal(history.candlesBySymbol.BTCUSDT.length,900);
});
test("does not forward-fill a gap in the latest common contiguous segment",()=>{
  const rows=makeRows({omitSymbol:"DOGEUSDT",omitIndex:800});
  const history=normalizeStrategyTournamentHistory(rows,{nowMs:TEST_NOW});
  assert.equal(history.available,false);
  assert.equal(history.reason,"tournament_aligned_contiguous_history_below_minimum");
});
test("rejects conflicting duplicate candles",()=>{
  const rows=makeRows(),duplicate={...rows[0],close:rows[0].close*1.01,high:rows[0].high*1.02};
  assert.throws(()=>normalizeStrategyTournamentHistory([...rows,duplicate],{nowMs:TEST_NOW}),
    /tournament_conflicting_duplicate/);
});
test("excludes stablecoin and leveraged-token base assets",()=>{
  const rows=makeRows(),excluded=[
    {...rows[0],symbol:"USDCUSDT",baseAsset:"USDC"},
    {...rows[1],symbol:"BTCUPUSDT",baseAsset:"BTCUP"}
  ];
  const history=normalizeStrategyTournamentHistory([...rows,...excluded],{nowMs:TEST_NOW});
  assert.equal(history.available,true);
  assert.equal(history.symbols.includes("USDCUSDT"),false);
  assert.equal(history.symbols.includes("BTCUPUSDT"),false);
});
test("compares all families on identical OOS dates and costs without activating trading",()=>{
  const report=runStrategyFamilyTournament({rows:makeRows(),nowMs:TEST_NOW});
  assert.equal(report.available,true);
  assert.equal(report.reportType,"TABDEAL_STRATEGY_FAMILY_TOURNAMENT");
  assert.equal(report.results.length,9);
  assert.equal(report.gates.length,3);
  assert.equal(report.history.symbolCount,5);
  assert.equal(report.history.oosBars,270);
  for(const row of report.results){
    assert.equal(row.initialCapitalUsdt,1000);
    assert.ok(Number.isFinite(row.totalReturnPct));
    assert.ok(Number.isFinite(row.maxDrawdownPct));
    assert.equal(row.liveTradingEnabled,false);
  }
  assert.equal(report.safety.exchangeOrdersPlaced,0);
  assert.equal(report.safety.leverageUsed,false);
  assert.equal(report.paperTradingEnabled,false);
});
test("a strategy failing any risk, return or statistical gate is not promoted",()=>{
  const report=runStrategyFamilyTournament({rows:makeRows(),nowMs:TEST_NOW});
  const failing=report.results.find(row=>row.maxDrawdownPct>20||row.fdrQValue>0.05||
    row.totalReturnPct<=0||row.switchCount<6);
  if(failing){
    const gate=report.gates.find(row=>row.strategyId===failing.strategyId);
    assert.equal(gate.passedAllCostScenarios,false);
  }
});
test("BH adjustment is monotonic and bounds q-values",()=>{
  const q=strategyTournamentInternals.benjaminiHochberg([
    {pValue:0.001},{pValue:0.02},{pValue:0.03},{pValue:0.5}
  ]);
  assert.equal(q.length,4);
  assert.ok(q.every(value=>value>=0&&value<=1));
  assert.ok(q[0]<=q[1]&&q[1]<=q[2]&&q[2]<=q[3]);
});
test("separately prices the sell and buy legs of a rotation",()=>{
  const soldBought=strategyTournamentInternals.executeOrder({
    cash:0,position:{symbol:"BTCUSDT",quantity:1},target:"ETHUSDT",
    sellPrice:100,buyPrice:10,feeRate:0.001,slippageRate:0.001
  });
  assert.equal(soldBought.orderCount,2);
  assert.equal(soldBought.position.symbol,"ETHUSDT");
  assert.ok(Math.abs(soldBought.position.quantity-9.96)<0.02);
});
test("uses a next-bar execution price and charges each order",()=>{
  const result=strategyTournamentInternals.executeOrder({
    cash:1000,position:null,target:"BTCUSDT",buyPrice:110,feeRate:0.004,slippageRate:0.001
  });
  assert.equal(result.position.symbol,"BTCUSDT");
  assert.ok(result.position.quantity<1000/110);
});
