import test from "node:test";
import assert from "node:assert/strict";
import {
  computeTabdealLocalIndicators,
  emaSeries,
  rsiWilder,
  assessTabdealLocalPaperBook,
  calculateLocalPaperMarkout,
  TABDEAL_LOCAL_PAPER_STRATEGY,
  TABDEAL_LOCAL_PAPER_NOTIONAL_USDT
} from "../src/tabdeal-local-indicators.js";

const minuteMs=60_000;
const start=Date.parse("2026-11-27T00:00:00.000Z");

function sampleCandles(count=240,{trend=0.0002,epoch=0,noTradeEvery=5,gapAt=-1}={}) {
  const rows=[];
  let previous=60_000;
  for(let i=0;i<count;i++){
    const time=start+i*minuteMs+(i>=gapAt?0:0);
    const change=trend + 0.00045*Math.sin(i*0.73) + 0.00018*Math.sin(i*0.19);
    let close=previous*(1+change);
    const noTrade=noTradeEvery>0 && i%noTradeEvery===0;
    if(noTrade) close=previous;
    const open=previous;
    rows.push({
      minute_open_ms:time,open_price:String(open),
      high_price:String(Math.max(open,close)*(1+0.00015)),
      low_price:String(Math.min(open,close)*(1-0.00015)),
      close_price:String(close),
      quote_volume:noTrade?"0":"100",
      trade_count:noTrade?0:2,
      continuity_epoch:epoch,coverage_status:noTrade?"no_trade":"complete",
      is_closed:1
    });
    previous=close;
  }
  if(gapAt>=0 && gapAt<count) rows[gapAt].minute_open_ms+=minuteMs;
  return rows;
}

test("EMA seed and Wilder RSI behave as expected",()=>{
  assert.deepEqual(emaSeries([1,2,3,4],3).slice(0,3),[null,null,2]);
  assert.equal(emaSeries([1,2,3,4],3).at(-1),3);
  assert.equal(rsiWilder(Array.from({length:16},(_,i)=>100+i),14),100);
});

test("local indicator engine accepts a complete 240-minute window with explicit no-trade bars",()=>{
  const rows=sampleCandles();
  const nowMs=Number(rows.at(-1).minute_open_ms)+minuteMs+5_000;
  const result=computeTabdealLocalIndicators(rows,{
    nowMs,pollAgeMs:5_000,lastTradeAgeMs:20_000,expectedBars:240
  });
  assert.equal(result.status,"ready");
  assert.equal(result.dataQuality.actualBars,240);
  assert.equal(result.dataQuality.noTradeMinutes240m,48);
  assert.equal(result.dataQuality.materialGapCount,0);
  assert.equal(result.indicators.fiveMinuteBars,48);
  assert.equal(TABDEAL_LOCAL_PAPER_STRATEGY,"ema9-21-50-rsi14-macd-5m-v1");
  assert.equal(TABDEAL_LOCAL_PAPER_NOTIONAL_USDT,50);
});

test("local indicator engine fails closed on a minute gap",()=>{
  const rows=sampleCandles(240,{gapAt:100});
  const result=computeTabdealLocalIndicators(rows,{
    nowMs:Number(rows.at(-1).minute_open_ms)+minuteMs+5_000,
    pollAgeMs:5_000,lastTradeAgeMs:20_000
  });
  assert.equal(result.status,"blocked");
  assert.equal(result.reason,"minute_candle_gap_or_order_error");
  assert.equal(result.signal,"WAIT");
});

test("local indicator engine fails closed on mixed continuity epochs and stale source",()=>{
  const rows=sampleCandles();
  rows[120].continuity_epoch=1;
  const mixed=computeTabdealLocalIndicators(rows,{
    nowMs:Number(rows.at(-1).minute_open_ms)+minuteMs+5_000,
    pollAgeMs:5_000,lastTradeAgeMs:20_000
  });
  assert.equal(mixed.reason,"continuity_epoch_mismatch");
  const clean=sampleCandles();
  const stale=computeTabdealLocalIndicators(clean,{
    nowMs:Number(clean.at(-1).minute_open_ms)+minuteMs+180_000,
    pollAgeMs:180_000,lastTradeAgeMs:400_000
  });
  assert.equal(stale.status,"blocked");
  assert.equal(stale.reason,"latest_closed_candle_stale_or_future");
});

test("paper book gate requires a valid two-sided book and sufficient depth",()=>{
  const book={
    bids:[[99.99,"20"],[99.90,"20"]],
    asks:[[100.01,"20"],[100.10,"20"]]
  };
  const good=assessTabdealLocalPaperBook(book);
  assert.equal(good.usable,true);
  assert.ok(good.spreadBps<30);
  const thin=assessTabdealLocalPaperBook({
    bids:[[99.99,"0.01"]],asks:[[100.01,"0.01"]]
  });
  assert.equal(thin.usable,false);
  assert.equal(thin.reason,"two_sided_depth_gate_failed");
  const crossed=assessTabdealLocalPaperBook({
    bids:[[100.02,"20"]],asks:[[100.01,"20"]]
  });
  assert.equal(crossed.reason,"orderbook_crossed_or_invalid");
});

test("paper markout subtracts round-trip fees and conservative exit costs",()=>{
  const low=calculateLocalPaperMarkout({
    entryPrice:100,exitClose:102,entrySpreadBps:10,feeBpsPerSide:10
  });
  const high=calculateLocalPaperMarkout({
    entryPrice:100,exitClose:102,entrySpreadBps:10,feeBpsPerSide:40
  });
  assert.equal(low.notionalUsdt,50);
  assert.ok(low.netReturnBps>high.netReturnBps);
  assert.ok(low.netReturnBps<low.grossReturnBps);
  assert.ok(low.modeledExitPrice<102);
});
