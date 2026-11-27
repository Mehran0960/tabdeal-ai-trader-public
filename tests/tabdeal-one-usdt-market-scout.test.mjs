import test from "node:test";
import assert from "node:assert/strict";
import {sizeWithinOneUsdt} from "../scripts/tabdeal-one-usdt-market-scout.mjs";

function market({minNotional="1.00000000",stepSize="0.0000000001",minQty="0.0000000001",tickSize="0.0001"}={}) {
  return {
    symbol:"TESTUSDT",baseAsset:"TEST",quoteAsset:"USDT",
    status:"TRADING",isSpotTradingAllowed:true,permissions:["SPOT"],
    orderTypes:["LIMIT"],
    filters:[
      {filterType:"PRICE_FILTER",minPrice:"0.0001",maxPrice:"1000000",tickSize},
      {filterType:"LOT_SIZE",minQty,maxQty:"100000000",stepSize},
      {filterType:"MIN_NOTIONAL",minNotional,applyToMarket:false}
    ]
  };
}
function depth({bid="0.4999",ask="0.5000",askQty="10"}={}) {
  return {bids:[[bid,"10"]],asks:[[ask,askQty]]};
}

test("accepts a precise limit quantity whose rounded quote notional is exactly 1 USDT",()=>{
  const result=sizeWithinOneUsdt(market(),depth());
  assert.equal(result.ok,true);
  assert.equal(result.estimatedQuoteNotional,"1.00000000");
  assert.ok(Number(result.estimatedQuoteNotional)<=1);
  assert.ok(Number(result.spreadBps)<=30);
});

test("rejects BTC-style coarse quantity steps when the next valid lot would exceed 1 USDT",()=>{
  const result=sizeWithinOneUsdt(
    market({stepSize:"0.00000100",minQty:"0.00000100"}),
    depth({bid:"61417.3",ask:"61487.8",askQty:"1"})
  );
  assert.equal(result.ok,false);
  assert.equal(result.reason,"min_notional_after_step_rounding");
  assert.equal(result.roundedNotional,"0.98380480");
  assert.equal(result.minNotional,"1.00000000");
  assert.equal(result.stepSize,"0.00000100");
});

test("rejects a pair whose exchange minimum exceeds the one-USDT cap",()=>{
  const result=sizeWithinOneUsdt(market({minNotional:"1.01"}),depth());
  assert.equal(result.ok,false);
  assert.equal(result.reason,"min_notional_after_step_rounding");
});

test("rejects a wide-spread pair before considering its lot size",()=>{
  const result=sizeWithinOneUsdt(
    market(),
    depth({bid:"0.49",ask:"0.50",askQty:"10"})
  );
  assert.equal(result.ok,false);
  assert.equal(result.reason,"spread_above_30bps");
});

test("rejects insufficient visible ask depth",()=>{
  const result=sizeWithinOneUsdt(
    market(),
    depth({askQty:"0.1"})
  );
  assert.equal(result.ok,false);
  assert.equal(result.reason,"visible_ask_depth");
});
