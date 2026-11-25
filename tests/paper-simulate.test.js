import test from "node:test";
import assert from "node:assert/strict";
import {validatePaperRunPayload} from "../src/paper-simulate.js";

const NOW=Date.now();
const runId="44830000123",sha="b".repeat(40);
const claims={run_id:runId,run_attempt:"1",sha};
const interval=14_400;
const latestStart=Math.floor(NOW/1000/interval)*interval-interval;
const candles=Array.from({length:220},(_,i)=>{
 const close=100+i*0.01;
 return {time:latestStart-(219-i)*interval,open:close-0.1,high:close+0.5,low:close-0.5,close,volume:100+i};
});
const base={
 schemaVersion:1,githubRunId:runId,githubRunAttempt:1,commitSha:sha,
 generatedAt:new Date(NOW).toISOString(),
 pairs:[{
  symbol:"BTCIRT",resolution:"240",strategy:"ema-trend",paperType:"legacy_btcirt",
  sourcePriceUnit:"TOMAN",canonicalPriceUnit:"RIAL",multiplier:10,
  unitAudit:{status:"udf_toman_likely",tradeRatio:10,midRatio:10.001,ratioSpreadPct:0.01,
   observedAt:new Date(NOW-1000).toISOString(),bookAgeMs:500,candleAgeSeconds:25},
  orderbook:{bids:[["999","1000"],["998","1000"]],asks:[["1001","1000"],["1002","1000"]]},
  orderbookLastUpdateMs:NOW-500,candles
 }]
};

test("accepts one individually audited IRT market with fresh book and completed bars",()=>{
 const clean=validatePaperRunPayload(base,claims,{nowMs:NOW});
 assert.equal(clean.pairs.length,1);
 assert.equal(clean.pairs[0].symbol,"BTCIRT");
 assert.equal(clean.pairs[0].multiplier,10);
 assert.equal(clean.pairs[0].candles.length,220);
});

test("accepts RIAL and USDT quote-separated pairs while requiring 4h and unique symbols",()=>{
 const usdtPair={...base.pairs[0],symbol:"ETHUSDT",strategy:"donchian-breakout",paperType:"multi_asset",
  sourcePriceUnit:"USDT",canonicalPriceUnit:"USDT",multiplier:1,
  unitAudit:{...base.pairs[0].unitAudit,status:"udf_usdt_likely",tradeRatio:1,midRatio:1.001}};
 const clean=validatePaperRunPayload({...base,pairs:[base.pairs[0],usdtPair]},claims,{nowMs:NOW});
 assert.equal(clean.pairs.length,2);
 assert.equal(clean.pairs[1].quoteAsset,"USDT");
 assert.equal(clean.pairs[1].strategy,"donchian-breakout");
 assert.throws(()=>validatePaperRunPayload({...base,pairs:[base.pairs[0],base.pairs[0]]},claims,{nowMs:NOW}),
  /paper_run_symbol_resolution_strategy_invalid/);
 assert.throws(()=>validatePaperRunPayload({...base,pairs:[{...base.pairs[0],resolution:"D"}]},claims,{nowMs:NOW}),
  /paper_run_symbol_resolution_strategy_invalid/);
});

test("rejects mismatched workflow claims and stale one-minute unit evidence",()=>{
 assert.throws(()=>validatePaperRunPayload(base,{...claims,run_id:"1"},{nowMs:NOW}),/identity_mismatch/);
 assert.throws(()=>validatePaperRunPayload({...base,pairs:[{...base.pairs[0],
  unitAudit:{...base.pairs[0].unitAudit,observedAt:new Date(NOW-120000).toISOString()}}]},claims,{nowMs:NOW}),
 /same_pair_unit_audit_invalid/);
});

test("rejects unknown unit mapping, stale books, wide payload and unclosed candles",()=>{
 assert.throws(()=>validatePaperRunPayload({...base,pairs:[{...base.pairs[0],multiplier:1}]},claims,{nowMs:NOW}),/unit_mapping_invalid/);
 assert.throws(()=>validatePaperRunPayload({...base,pairs:[{...base.pairs[0],
  unitAudit:{...base.pairs[0].unitAudit,bookAgeMs:90000}}]},claims,{nowMs:NOW}),/same_pair_unit_audit_invalid/);
 assert.throws(()=>validatePaperRunPayload({...base,pairs:[{...base.pairs[0],
  candles:[...candles,{...candles.at(-1),time:candles.at(-1).time+interval}]}]},claims,{nowMs:NOW}),
 /historical_candle_invalid/);
});

test("rejects duplicate pairs and payloads larger than eight markets",()=>{
 assert.throws(()=>validatePaperRunPayload({...base,pairs:[base.pairs[0],base.pairs[0]]},claims,{nowMs:NOW}),
  /paper_run_symbol_resolution_strategy_invalid/);
 const pairs=Array.from({length:9},(_,i)=>({...base.pairs[0],symbol:"COIN"+i+"IRT"}));
 assert.throws(()=>validatePaperRunPayload({...base,pairs},claims,{nowMs:NOW}),
  /paper_run_payload_shape_invalid/);
});
