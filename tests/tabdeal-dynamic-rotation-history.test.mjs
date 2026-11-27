import test from "node:test";
import assert from "node:assert/strict";
import {
  runTabdealDynamicRotationHistoryCapture,
  tabdealDynamicHistoryInternals
} from "../src/tabdeal-dynamic-rotation-history.js";

const INTERVAL=14_400_000;
const NOW=Date.parse("2026-11-27T20:00:00.000Z");
const SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT"];
function market(symbol,baseAsset){
  return {
    symbol,baseAsset,quoteAsset:"USDT",status:"TRADING",
    isSpotTradingAllowed:true,permissions:["SPOT"],
    filters:[
      {filterType:"LOT_SIZE",minQty:"0.001",maxQty:"1000000",stepSize:"0.001"},
      {filterType:"MIN_NOTIONAL",minNotional:"5"},
      {filterType:"PRICE_FILTER",tickSize:"0.0001"}
    ]
  };
}
function kline(openTime,price){
  return [openTime,String(price),String(price*1.01),String(price*0.99),
    String(price*1.005),"100",openTime+INTERVAL-1,"1000000",100];
}
function depth(price){
  return {
    lastUpdateId:123,
    bids:[[String(price*0.999),"1000"],[String(price*0.998),"1000"]],
    asks:[[String(price*1.001),"1000"],[String(price*1.002),"1000"]]
  };
}
function response(data,status=200){
  return {ok:status>=200&&status<300,status,
    headers:{get:()=>null},json:async()=>data};
}
function fakeFetch(){
  const tabdeal=SYMBOLS.map((symbol,i)=>market(symbol,symbol.replace("USDT","")));
  const binance={symbols:tabdeal};
  const tickers=SYMBOLS.map((symbol,i)=>({
    symbol,quoteVolume:String(1_000_000_000/(i+1)),count:10000,lastPrice:String(100/(i+1))
  }));
  const prices={BTCUSDT:100,ETHUSDT:50,SOLUSDT:25};
  const calls=[];
  const fetchImpl=async input=>{
    const url=new URL(String(input));calls.push(url);
    if(url.pathname.endsWith("/exchangeInfo")&&url.hostname==="api1.tabdeal.org")return response(tabdeal);
    if(url.pathname.endsWith("/api/v3/exchangeInfo"))return response(binance);
    if(url.pathname.endsWith("/api/v3/ticker/24hr"))return response(tickers);
    if(url.pathname.endsWith("/api/v3/klines")){
      const symbol=url.searchParams.get("symbol");
      const start=Number(url.searchParams.get("startTime"));
      return response([kline(start,prices[symbol]),kline(start+INTERVAL,prices[symbol]*1.01)]);
    }
    if(url.pathname.endsWith("/depth")){
      const symbol=url.searchParams.get("symbol");
      return response(depth(prices[symbol]));
    }
    return response({error:"not_found"},404);
  };
  return {fetchImpl,calls};
}

test("collects dynamic cross-listed Spot USDT 4h history and Tabdeal local books",async()=>{
  const {fetchImpl,calls}=fakeFetch();
  const report=await runTabdealDynamicRotationHistoryCapture({
    fetchImpl,now:()=>NOW,sleepImpl:async()=>{},requestSpacingMs:0,
    backfillDays:1,maxMarkets:3
  });
  assert.equal(report.universe.coverageComplete,true);
  assert.equal(report.universe.selectedMarketCount,3);
  assert.equal(report.snapshot.candles.length,6);
  assert.equal(report.snapshot.tabdealBooks.length,3);
  assert.equal(report.summary.validTabdealBooks,3);
  assert.equal(report.snapshot.safety.privateEndpointsUsed,false);
  assert.equal(report.snapshot.safety.exchangeOrdersPlaced,0);
  assert.equal(report.snapshot.safety.liveTradingEnabled,false);
  assert.equal(calls.filter(url=>url.pathname.endsWith("/api/v3/klines")).length,3);
  assert.equal(calls.filter(url=>url.pathname.endsWith("/depth")).length,3);
  assert.match(report.snapshot.snapshotId,/^[a-f0-9]{64}$/);
});

test("incremental capture starts after each symbol's last confirmed closed candle",async()=>{
  const {fetchImpl,calls}=fakeFetch();
  const previous=NOW-2*INTERVAL;
  const report=await runTabdealDynamicRotationHistoryCapture({
    fetchImpl,now:()=>NOW,sleepImpl:async()=>{},requestSpacingMs:0,
    latestOpenTimeBySymbol:Object.fromEntries(SYMBOLS.map(symbol=>[symbol,previous])),
    backfillDays:1,maxMarkets:3
  });
  const firstKline=calls.find(url=>url.pathname.endsWith("/api/v3/klines"));
  assert.equal(Number(firstKline.searchParams.get("startTime")),previous+INTERVAL);
  assert.equal(report.snapshot.candles.length,6);
});

test("validates the latest-candle index and rate-limit retry delay",()=>{
  assert.deepEqual(tabdealDynamicHistoryInternals.normalizedLatestIndex({
    BTCUSDT:123456,ETHUSDT:"234567",BAD:-1,INVALID:"nope"
  }),{BTCUSDT:123456,ETHUSDT:234567});
  assert.equal(tabdealDynamicHistoryInternals.retryDelay({
    headers:{get:()=> "3"}
  },0),3000);
  assert.equal(tabdealDynamicHistoryInternals.retryDelay(null,2),4000);
});

test("rejects unsafe collection bounds",async()=>{
  const {fetchImpl}=fakeFetch();
  await assert.rejects(runTabdealDynamicRotationHistoryCapture({
    fetchImpl,now:()=>NOW,backfillDays:731
  }),/policy_invalid/);
});
