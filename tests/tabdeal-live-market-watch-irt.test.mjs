import test from "node:test";
import assert from "node:assert/strict";
import {evaluateTabdealRelativeWatch,createTabdealLiveWatchState,updateTabdealLiveMinuteBar} from "../src/tabdeal-live-market-watch.js";
const NOW=Date.parse("2026-11-27T18:00:00.000Z");
const INTERVAL=60_000;
const market=(symbol,base,quote)=>({symbol,baseAsset:base,quoteAsset:quote,marketRulesReady:true,quoteUnitVerified:quote!=="IRT",minNotional:"1"});
test("scans USDT and IRT markets independently and keeps IRT candidates observation-only",()=>{
  const assets=[
    ["BTCUSDT","BTC","USDT",50_000],["ETHUSDT","ETH","USDT",2_500],
    ["SOLUSDT","SOL","USDT",100],["XRPUSDT","XRP","USDT",0.5],
    ["DOGEUSDT","DOGE","USDT",0.1],
    ["BTCIRT","BTC","IRT",1_500_000_000],["ETHIRT","ETH","IRT",75_000_000],
    ["SOLIRT","SOL","IRT",3_000_000],["XRPIRT","XRP","IRT",15_000],
    ["DOGEIRT","DOGE","IRT",3_000]
  ];
  const markets=assets.map(([symbol,base,quote])=>market(symbol,base,quote));
  const state=createTabdealLiveWatchState(null,{nowMs:NOW});
  for(const [symbol,base,quote,start] of assets){
    for(let i=0;i<20;i++){
      let close=start*(1+0.0004*i);
      if(base==="ETH"){
        if(i<=14)close=start*(1-0.0012*i);
        else close=start*(1-0.0012*14)*(1+0.001*(i-14));
      }
      const time=NOW-19*INTERVAL+i*INTERVAL;
      updateTabdealLiveMinuteBar(state,{
        symbol,quoteAsset:quote,eventTimeMs:time+30_000,receivedAtMs:NOW-500,
        eventLagMs:0,midPrice:close,bestBid:close*0.9995,bestAsk:close*1.0005,
        spreadBps:10,bidDepthTop5Quote:50_000,askDepthTop5Quote:50_000,
        imbalance:0,bidLevelCount:5,askLevelCount:5,sequenceFields:["U","u"],
        bookSemantics:"snapshot_vs_delta_not_confirmed_by_exchange"
      });
    }
    const last=state.barsBySymbol[symbol].at(-1);
    state.latestBooks[symbol]={
      receivedAtMs:NOW-500,eventTimeMs:NOW-1000,
      bestBid:last.close*0.9995,bestAsk:last.close*1.0005,
      midPrice:last.close,spreadBps:10,
      bidDepthTop5Quote:50_000,askDepthTop5Quote:50_000,
      imbalance:0,bidLevelCount:5,askLevelCount:5,eventLagMs:0,
      bookSemantics:"snapshot_vs_delta_not_confirmed_by_exchange"
    };
  }
  const result=evaluateTabdealRelativeWatch({state,markets,nowMs:NOW});
  assert.equal(result.status,"provisional_relative_value_watch_candidate");
  assert.deepEqual(new Set(result.candidates.map(row=>row.quoteUnit)),new Set(["USDT","IRT"]));
  const irt=result.candidates.find(row=>row.quoteUnit==="IRT");
  assert.ok(irt);
  assert.equal(irt.targetAsset,"ETH");
  assert.equal(irt.quoteUnitVerified,false);
  assert.equal(result.tradeAuthorized,false);
  assert.equal(result.candidate.quoteUnitVerified,false);
  assert.ok(result.statusLimitations.some(row=>row.includes("IRT")));
});
