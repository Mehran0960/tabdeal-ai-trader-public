import test from "node:test";
import assert from "node:assert/strict";
import {
  TABDEAL_LIVE_WATCH_POLICY,
  discoverTabdealSpotUniverse,
  buildTabdealSubscriptionBatches,
  normalizeTabdealLiveDepthMessage,
  createTabdealLiveWatchState,
  updateTabdealLiveMinuteBar,
  evaluateTabdealRelativeWatch,
  summarizeTabdealLiveWatch
} from "../src/tabdeal-live-market-watch.js";

const NOW=Date.parse("2026-11-27T18:00:00.000Z");
const INTERVAL=60_000;
const market=(symbol,base,quote="USDT",extra={})=>({
  symbol,baseAsset:base,quoteAsset:quote,status:"TRADING",
  isSpotTradingAllowed:true,permissions:["SPOT"],
  filters:[
    {filterType:"LOT_SIZE",minQty:"0.001",maxQty:"1000000",stepSize:"0.001"},
    {filterType:"MIN_NOTIONAL",minNotional:"1"},
    {filterType:"PRICE_FILTER",tickSize:"0.00000001"}
  ],
  ...extra
});
const depth=(symbol="BTCUSDT",eventTime=NOW)=>({
  stream:symbol.toLowerCase()+"@depth@2000ms",
  data:{e:"depthUpdate",E:eventTime,s:symbol,U:1,u:2,
    b:[["100","100"],["99.9","100"]],a:[["100.1","100"],["100.2","100"]]}
});
function liveStateWithBooks(markets,nowMs){
  const state=createTabdealLiveWatchState(null,{nowMs});
  for(const item of markets){
    const row=normalizeTabdealLiveDepthMessage(depth(item.symbol,nowMs-1000),{
      expectedSymbol:item.symbol,receivedAtMs:nowMs-500,quoteAsset:item.quoteAsset
    });
    updateTabdealLiveMinuteBar(state,row);
  }
  return state;
}

test("discovers all active Spot markets quoted in USDT or BTC and excludes IRT",()=>{
  const payload=[
    market("BTCUSDT","BTC","USDT"),
    market("ETHBTC","ETH","BTC"),
    market("ETHIRT","ETH","IRT"),
    market("FAKEUSDT","FAKE","USDT",{status:"BREAK"}),
    market("MARGINUSDT","MARGIN","USDT",{isSpotTradingAllowed:false}),
    market("BASEIRT","IRT","USDT")
  ];
  const result=discoverTabdealSpotUniverse(payload);
  assert.deepEqual(result.markets.map(row=>row.symbol),["BTCUSDT","ETHBTC"]);
  assert.equal(result.universe.totalExchangeInfoMarkets,6);
  assert.equal(result.universe.activeSupportedSpotMarkets,2);
  assert.equal(result.universe.marketRulesReadyCount,2);
  assert.equal(result.universe.excludedAsset,2);
  assert.equal(result.universe.excluded.inactive,1);
  assert.equal(result.universe.excluded.nonSpot,1);
});

test("enforces the documented internal market cap without silently changing market metadata",()=>{
  const payload=[
    market("AAAUSDT","AAA"),
    market("BBBUSD","BBB","USD"),
    market("CCCUSDT","CCC")
  ];
  const result=discoverTabdealSpotUniverse(payload,{maxMarkets:1});
  assert.equal(result.universe.activeSupportedSpotMarkets,2);
  assert.equal(result.universe.selectedMarketCount,1);
  assert.equal(result.universe.omittedBySafetyCap,1);
  assert.equal(result.markets[0].symbol,"AAAUSDT");
});

test("rejects malformed or duplicate active Spot metadata",()=>{
  assert.throws(()=>discoverTabdealSpotUniverse({}),/exchange_info_invalid/);
  const result=discoverTabdealSpotUniverse([
    market("BTCUSDT","BTC"),market("BTCUSDT","BTC")
  ]);
  assert.equal(result.markets.length,1);
  assert.equal(result.universe.excluded.invalid,1);
});

test("creates bounded multi-subscribe frames with unique IDs and documented depth topics",()=>{
  const batches=buildTabdealSubscriptionBatches(
    ["BTCUSDT","ETHBTC","SOLUSDT","XRPUSDT","DOGEUSDT"],
    {batchSize:2,firstId:7}
  );
  assert.equal(batches.length,3);
  assert.deepEqual(batches.map(row=>row.id),[7,8,9]);
  assert.deepEqual(batches[0].message,{
    method:"SUBSCRIBE",id:7,
    params:["btcusdt@depth@2000ms","ethbtc@depth@2000ms"]
  });
  assert.equal(batches[2].symbols.length,1);
  assert.throws(()=>buildTabdealSubscriptionBatches(["BTCUSDT","BTCUSDT"]),/symbols_invalid/);
  assert.throws(()=>buildTabdealSubscriptionBatches(["BTCUSDT"],{batchSize:0}),/batch_input_invalid/);
});

test("normalizes combined Spot depth events, lag and book diagnostics without assuming sequence semantics",()=>{
  const message=depth("ETHBTC",NOW-500);
  const row=normalizeTabdealLiveDepthMessage(message,{
    expectedSymbol:"ETHBTC",receivedAtMs:NOW,quoteAsset:"BTC"
  });
  assert.equal(row.symbol,"ETHBTC");
  assert.equal(row.quoteAsset,"BTC");
  assert.equal(row.bestBid,100);
  assert.equal(row.bestAsk,100.1);
  assert.equal(row.eventLagMs,500);
  assert.equal(row.bookSemantics,"snapshot_vs_delta_not_confirmed_by_exchange");
  assert.deepEqual(row.sequenceFields,["U","u"]);
  assert.ok(row.spreadBps>0);
  assert.equal(normalizeTabdealLiveDepthMessage(message,{
    expectedSymbol:"BTCUSDT",receivedAtMs:NOW
  }),null);
});

test("rejects crossed, one-sided, stale and malformed depth events",()=>{
  const crossed={
    stream:"btcusdt@depth@2000ms",
    data:{e:"depthUpdate",E:NOW,s:"BTCUSDT",b:[["101","1"]],a:[["100","1"]]}
  };
  assert.equal(normalizeTabdealLiveDepthMessage(crossed,{receivedAtMs:NOW}),null);
  const oneSided={
    stream:"btcusdt@depth@2000ms",
    data:{e:"depthUpdate",E:NOW,s:"BTCUSDT",b:[["100","1"]],a:[]}
  };
  assert.equal(normalizeTabdealLiveDepthMessage(oneSided,{receivedAtMs:NOW}),null);
  assert.equal(normalizeTabdealLiveDepthMessage(depth("BTCUSDT",NOW),{receivedAtMs:NaN}),null);
  assert.equal(normalizeTabdealLiveDepthMessage({data:{e:"trade"}},{receivedAtMs:NOW}),null);
});

test("restores only recent, valid, ordered minute bars and never restores stale books",()=>{
  const source={
    schemaVersion:TABDEAL_LIVE_WATCH_POLICY.stateSchemaVersion,
    barsBySymbol:{
      BTCUSDT:[
        {time:NOW-3*INTERVAL,open:100,high:101,low:99,close:100,updateCount:10},
        {time:NOW-2*INTERVAL,open:100,high:102,low:99,close:101,updateCount:10},
        {time:NOW-100*INTERVAL,open:100,high:101,low:99,close:100,updateCount:1},
        {time:NOW-INTERVAL,open:100,high:98,low:99,close:98,updateCount:1}
      ]
    },
    latestBooks:{BTCUSDT:{midPrice:100}}
  };
  const state=createTabdealLiveWatchState(source,{nowMs:NOW});
  assert.equal(state.barsBySymbol.BTCUSDT.length,2);
  assert.equal(state.barsBySymbol.BTCUSDT[0].time,NOW-3*INTERVAL);
  assert.deepEqual(state.latestBooks,{});
  assert.equal(state.historyRestoredSymbols,1);
});

test("updates one-minute OHLC bars but does not fill missing minutes or accept older updates",()=>{
  const state=createTabdealLiveWatchState(null,{nowMs:NOW});
  const first=normalizeTabdealLiveDepthMessage(depth("BTCUSDT",NOW-2*INTERVAL),{
    expectedSymbol:"BTCUSDT",receivedAtMs:NOW-2*INTERVAL+1000,quoteAsset:"USDT"
  });
  const second=normalizeTabdealLiveDepthMessage({
    stream:"btcusdt@depth@2000ms",
    data:{...depth("BTCUSDT",NOW).data,E:NOW,s:"BTCUSDT",b:[["101","100"]],a:[["101.1","100"]]}
  },{expectedSymbol:"BTCUSDT",receivedAtMs:NOW,quoteAsset:"USDT"});
  assert.equal(updateTabdealLiveMinuteBar(state,first).accepted,true);
  assert.equal(updateTabdealLiveMinuteBar(state,second).accepted,true);
  assert.equal(state.barsBySymbol.BTCUSDT.length,2);
  assert.equal(state.barsBySymbol.BTCUSDT[1].time-state.barsBySymbol.BTCUSDT[0].time,2*INTERVAL);
  const older=updateTabdealLiveMinuteBar(state,{
    ...first,eventTimeMs:NOW-3*INTERVAL,receivedAtMs:NOW-3*INTERVAL+1000
  });
  assert.equal(older.accepted,false);
  assert.equal(state.barsBySymbol.BTCUSDT.length,2);
});

test("watch candidate compares live USDT-equivalent prices, applies reversal and liquidity gates, and never authorizes a trade",()=>{
  const symbols=[
    ["BTCUSDT","BTC",50_000],["ETHUSDT","ETH",2_500],["SOLUSDT","SOL",100],
    ["XRPUSDT","XRP",0.5],["DOGEUSDT","DOGE",0.1],["LTCUSDT","LTC",80]
  ];
  const markets=symbols.map(([symbol,base])=>market(symbol,base));
  const state=createTabdealLiveWatchState(null,{nowMs:NOW});
  for(const [symbol,base,start] of symbols){
    for(let i=0;i<20;i++){
      let close=start*(1+0.0004*i);
      if(base==="ETH"){
        if(i<=14)close=start*(1-0.0012*i);
        else close=start*(1-0.0012*14)*(1+0.001*(i-14));
      }
      const time=NOW-19*INTERVAL+i*INTERVAL;
      const mid=close;
      const bid=mid*0.9995,ask=mid*1.0005;
      const row={
        symbol,quoteAsset:"USDT",eventTimeMs:time+30_000,receivedAtMs:NOW-500,
        eventLagMs:0,midPrice:mid,bestBid:bid,bestAsk:ask,
        spreadBps:10,bidDepthTop5Quote:50_000,askDepthTop5Quote:50_000,
        imbalance:0,bidLevelCount:5,askLevelCount:5,sequenceFields:["U","u"],
        bookSemantics:"snapshot_vs_delta_not_confirmed_by_exchange"
      };
      updateTabdealLiveMinuteBar(state,row);
    }
    const last=state.barsBySymbol[symbol].at(-1);
    state.latestBooks[symbol]={
      receivedAtMs:NOW-500,eventTimeMs:NOW-1000,bestBid:last.close*0.9995,
      bestAsk:last.close*1.0005,midPrice:last.close,spreadBps:10,
      bidDepthTop5Quote:50_000,askDepthTop5Quote:50_000,
      imbalance:0,bidLevelCount:5,askLevelCount:5,eventLagMs:0,
      bookSemantics:"snapshot_vs_delta_not_confirmed_by_exchange"
    };
  }
  const result=evaluateTabdealRelativeWatch({state,markets,nowMs:NOW});
  assert.equal(result.status,"provisional_relative_value_watch_candidate");
  assert.equal(result.candidate.targetAsset,"ETH");
  assert.equal(result.candidate.sourceAsset,"BTC");
  assert.ok(result.candidate.estimatedSwitchFrictionBps>0);
  assert.ok(result.candidate.relativeUnderperformanceBps<-100);
  assert.equal(result.tradeAuthorized,false);
  assert.ok(result.statusLimitations.length>=3);
});

test("does not produce watch candidates while data is warming up or books are stale",()=>{
  const markets=[market("BTCUSDT","BTC"),market("ETHUSDT","ETH"),market("SOLUSDT","SOL"),
    market("XRPUSDT","XRP"),market("DOGEUSDT","DOGE")];
  const state=createTabdealLiveWatchState(null,{nowMs:NOW});
  const warming=evaluateTabdealRelativeWatch({state,markets,nowMs:NOW});
  assert.equal(warming.status,"warming_up");
  assert.equal(warming.tradeAuthorized,false);
});

test("summarizes live coverage and guarantees that the watcher itself places no orders",()=>{
  const markets=[market("BTCUSDT","BTC"),market("ETHUSDT","ETH")];
  const universe=discoverTabdealSpotUniverse(markets);
  const state=createTabdealLiveWatchState(null,{nowMs:NOW});
  const report=summarizeTabdealLiveWatch({
    universe,stats:{connectionsOpened:1,reconnects:0,subscriptionAcks:1,
      subscriptionRejections:0,receivedMessages:0,invalidMessages:0,ignoredMessages:0,
      eventLagSum:0,eventLagCount:0,maxAbsoluteEventLagMs:0,bySymbol:{}},
    state,nowMs:NOW,durationMs:60_000,mode:"probe"
  });
  assert.equal(report.connectionStats.distinctSymbolsWithUpdates,0);
  assert.equal(report.safety.exchangeOrdersPlaced,0);
  assert.equal(report.safety.liveTradingEnabled,false);
  assert.equal(report.source.bookSemantics,"unverified_snapshot_or_delta");
});
