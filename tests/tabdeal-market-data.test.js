import test from "node:test";
import assert from "node:assert/strict";
import {
  runTabdealPublicMarketScout,
  TABDEAL_PUBLIC_RESEARCH_SYMBOLS
} from "../src/tabdeal-market-data.js";

function market(symbol, baseAsset, quoteAsset) {
  return {
    symbol,baseAsset,quoteAsset,status:"TRADING",
    isSpotTradingAllowed:true,permissions:["SPOT"],
    isMarginTradingAllowed:false,baseAssetPrecision:8,quoteAssetPrecision:8
  };
}

function book() {
  return {
    lastUpdateId:12345,
    bids:[["100","2"],["99","3"],["98","4"]],
    asks:[["101","1"],["102","2"],["103","3"]]
  };
}

function trades(now) {
  return [
    {id:1,price:"100",qty:"0.1",quoteQty:"10.25",time:now-2000,isBuyerMaker:false},
    {id:2,price:"101",qty:"0.2",quoteQty:"20.50",time:now-1000,isBuyerMaker:true}
  ];
}

test("collects public Tabdeal orderbook and recent-trade summaries without credentials", async () => {
  const now = Date.now();
  const calls = [];
  const report = await runTabdealPublicMarketScout({
    symbols:["BTCIRT","BTCUSDT"],
    clock:()=>now,
    spacingMs:0,
    sleepImpl:async()=>{},
    fetchImpl:async (url,options) => {
      calls.push({url:String(url),method:options.method,headers:options.headers,redirect:options.redirect});
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/exchangeInfo")) {
        return {ok:true,status:200,json:async()=>[
          market("BTCIRT","BTC","IRT"),market("BTCUSDT","BTC","USDT")
        ]};
      }
      if (parsed.pathname.endsWith("/depth")) {
        return {ok:true,status:200,json:async()=>book()};
      }
      if (parsed.pathname.endsWith("/trades")) {
        return {ok:true,status:200,json:async()=>trades(now)};
      }
      throw new Error("unexpected_url");
    }
  });

  assert.equal(report.provider,"TABDEAL");
  assert.equal(report.snapshots.length,2);
  assert.deepEqual(report.snapshots.map(x=>x.symbol),["BTCIRT","BTCUSDT"]);
  assert.equal(report.snapshots[0].quoteUnitCode,"IRT_UNVERIFIED");
  assert.equal(report.snapshots[1].quoteUnitCode,"USDT");
  assert.equal(report.snapshots[0].orderbook.status,"ok");
  assert.equal(report.snapshots[0].orderbook.bestBid,"100");
  assert.equal(report.snapshots[0].orderbook.bestAsk,"101");
  assert.equal(report.snapshots[0].orderbook.bookUpdateId,"12345");
  assert.equal(report.snapshots[0].trades.tradeCount,2);
  // Deliberately mismatched quoteQty fixtures prove we derive quote notional from price × qty.
  assert.equal(report.snapshots[0].trades.quoteVolume,"30.2");
  assert.equal(report.snapshots[0].trades.takerBuyQuoteVolume,"10");
  assert.equal(report.snapshots[0].trades.takerSellQuoteVolume,"20.2");
  assert.equal(report.snapshots[0].trades.netTakerBuyQuoteVolume,"-10.2");
  assert.match(report.methodology.quoteVolume,/price × base quantity/);
  assert.equal(report.snapshots[0].trades.coverageStatus,"recent_unpaginated_snapshot_not_proven_complete");
  assert.equal(report.safety.apiKeyUsed,false);
  assert.equal(report.safety.liveTradingEnabled,false);
  assert.ok(calls.every(call=>call.method==="GET"));
  assert.ok(calls.every(call=>call.redirect==="follow"),"Cloudflare Workers only accepts follow/manual redirect modes");
  assert.ok(calls.every(call=>!Object.keys(call.headers||{}).some(key=>key.toLowerCase().includes("api-key"))));
});

test("does not treat an exactly 1000-row trade response as complete history", async () => {
  const now = Date.now();
  const many = Array.from({length:1000},(_,index)=>({
    id:index+1,price:"1",qty:"1",quoteQty:"1",
    time:now-1000+index,isBuyerMaker:index%2===0
  }));
  const report = await runTabdealPublicMarketScout({
    symbols:["BTCIRT"],clock:()=>now,spacingMs:0,sleepImpl:async()=>{},
    fetchImpl:async url=>{
      const parsed=new URL(String(url));
      if(parsed.pathname.endsWith("/exchangeInfo"))return {ok:true,status:200,json:async()=>[market("BTCIRT","BTC","IRT")]};
      if(parsed.pathname.endsWith("/depth"))return {ok:true,status:200,json:async()=>book()};
      if(parsed.pathname.endsWith("/trades"))return {ok:true,status:200,json:async()=>many};
      throw new Error("unexpected_url");
    }
  });
  assert.equal(report.snapshots[0].trades.tradeCount,1000);
  assert.equal(report.snapshots[0].trades.pageCapped,true);
  assert.equal(report.snapshots[0].trades.coverageStatus,"possible_truncation_at_1000_limit");
});

test("marks crossed orderbooks as unusable rather than reporting a spread", async () => {
  const now=Date.now();
  const report=await runTabdealPublicMarketScout({
    symbols:["BTCIRT"],clock:()=>now,spacingMs:0,sleepImpl:async()=>{},
    fetchImpl:async url=>{
      const parsed=new URL(String(url));
      if(parsed.pathname.endsWith("/exchangeInfo"))return {ok:true,status:200,json:async()=>[market("BTCIRT","BTC","IRT")]};
      if(parsed.pathname.endsWith("/depth"))return {ok:true,status:200,json:async()=>({
        bids:[["102","1"]],asks:[["101","1"]]
      })};
      if(parsed.pathname.endsWith("/trades"))return {ok:true,status:200,json:async()=>trades(now)};
      throw new Error("unexpected_url");
    }
  });
  assert.equal(report.snapshots[0].orderbook.status,"crossed_or_invalid");
  assert.equal(report.summary.validOrderbooks,0);
});

test("rejects symbols outside the fixed public research shortlist", async()=>{
  await assert.rejects(
    runTabdealPublicMarketScout({symbols:["BTCIRT","BTCFAKE"]}),
    /tabdeal_research_symbol_not_allowlisted/
  );
  assert.equal(TABDEAL_PUBLIC_RESEARCH_SYMBOLS.length,11);
});

test("does not add markets missing active SPOT permission metadata",async()=>{
  const now=Date.now();
  const report=await runTabdealPublicMarketScout({
    symbols:["BTCIRT"],clock:()=>now,spacingMs:0,sleepImpl:async()=>{},
    fetchImpl:async url=>{
      const parsed=new URL(String(url));
      if(parsed.pathname.endsWith("/exchangeInfo"))return {ok:true,status:200,json:async()=>[
        {...market("BTCIRT","BTC","IRT"),permissions:["MARGIN"]}
      ]};
      throw new Error("market_should_have_been_rejected");
    }
  });
  assert.equal(report.snapshots.length,0);
  assert.deepEqual(report.rejected,[{symbol:"BTCIRT",reason:"not_active_spot_market"}]);
});


test("trade freshness age is aligned to the final snapshot capture timestamp",async()=>{
  const now=Date.now();
  let tick=0;
  const report=await runTabdealPublicMarketScout({
    symbols:["BTCIRT"],
    clock:()=>now+tick++,
    spacingMs:0,
    sleepImpl:async()=>{},
    fetchImpl:async url=>{
      const parsed=new URL(String(url));
      if(parsed.pathname.endsWith("/exchangeInfo"))return {ok:true,status:200,json:async()=>[market("BTCIRT","BTC","IRT")]};
      if(parsed.pathname.endsWith("/depth"))return {ok:true,status:200,json:async()=>book()};
      if(parsed.pathname.endsWith("/trades"))return {ok:true,status:200,json:async()=>trades(now)};
      throw new Error("unexpected_url");
    }
  });
  const row=report.snapshots[0];
  assert.equal(row.trades.status,"ok");
  assert.equal(row.trades.newestTradeAgeMs,row.capturedAtMs-row.trades.newestTradeTimeMs);
});


test("respects a smaller requested trade limit and flags a capped response",async()=>{
  const now=Date.now();
  const calls=[];
  const report=await runTabdealPublicMarketScout({
    symbols:["BTCUSDT"],tradeLimit:2,clock:()=>now,spacingMs:0,sleepImpl:async()=>{},
    fetchImpl:async (url,options)=>{
      const parsed=new URL(String(url));
      calls.push({url:String(url),method:options.method});
      if(parsed.pathname.endsWith("/exchangeInfo"))return {ok:true,status:200,json:async()=>[market("BTCUSDT","BTC","USDT")]};
      if(parsed.pathname.endsWith("/depth"))return {ok:true,status:200,json:async()=>book()};
      if(parsed.pathname.endsWith("/trades"))return {ok:true,status:200,json:async()=>trades(now)};
      throw new Error("unexpected_url");
    }
  });
  const tradeCall=calls.find(row=>new URL(row.url).pathname.endsWith("/trades"));
  assert.equal(new URL(tradeCall.url).searchParams.get("limit"),"2");
  assert.equal(report.snapshots[0].trades.requestedTradeLimit,2);
  assert.equal(report.snapshots[0].trades.pageCapped,true);
  assert.equal(report.snapshots[0].trades.coverageStatus,"possible_truncation_at_2_limit");
});

test("rejects a non-integer or excessive requested trade limit",async()=>{
  await assert.rejects(runTabdealPublicMarketScout({symbols:["BTCIRT"],tradeLimit:0}),/tabdeal_research_trade_limit_invalid/);
  await assert.rejects(runTabdealPublicMarketScout({symbols:["BTCIRT"],tradeLimit:1001}),/tabdeal_research_trade_limit_invalid/);
});


test("separates parse-valid trade snapshots from freshness diagnostics",async()=>{
  const now=Date.now();
  const report=await runTabdealPublicMarketScout({
    symbols:["BTCUSDT","ETHUSDT"],
    clock:()=>now,
    spacingMs:0,
    sleepImpl:async()=>{},
    fetchImpl:async url=>{
      const parsed=new URL(String(url));
      const symbol=parsed.searchParams.get("symbol");
      if(parsed.pathname.endsWith("/exchangeInfo"))return {ok:true,status:200,json:async()=>[
        market("BTCUSDT","BTC","USDT"),market("ETHUSDT","ETH","USDT")
      ]};
      if(parsed.pathname.endsWith("/depth"))return {ok:true,status:200,json:async()=>book()};
      if(parsed.pathname.endsWith("/trades")) {
        return {ok:true,status:200,json:async()=>symbol==="BTCUSDT"?trades(now):trades(now-120_000)};
      }
      throw new Error("unexpected_url");
    }
  });
  assert.equal(report.summary.validTradeSnapshots,2);
  assert.equal(report.summary.tradeSnapshotsWithin60s,1);
  assert.equal(report.summary.tradeSnapshotsOlderThan60s,1);
  assert.equal(report.summary.tradeSnapshotsWithFutureTimestamp,0);
  assert.equal(report.summary.tradeFreshnessDiagnosticThresholdMs,60_000);
  assert.equal(report.summary.cappedTradePages,0);
});


test("discovers and snapshots the direct ETHBTC Spot pair using BTC as quote asset", async()=>{
  const now=Date.now();
  const report=await runTabdealPublicMarketScout({
    symbols:["ETHBTC"],clock:()=>now,spacingMs:0,sleepImpl:async()=>{},
    fetchImpl:async url=>{
      const parsed=new URL(String(url));
      if(parsed.pathname.endsWith("/exchangeInfo"))return {ok:true,status:200,json:async()=>[
        market("ETHBTC","ETH","BTC")
      ]};
      if(parsed.pathname.endsWith("/depth"))return {ok:true,status:200,json:async()=>book()};
      if(parsed.pathname.endsWith("/trades"))return {ok:true,status:200,json:async()=>trades(now)};
      throw new Error("unexpected_url");
    }
  });
  assert.equal(report.snapshots.length,1);
  assert.equal(report.snapshots[0].symbol,"ETHBTC");
  assert.equal(report.snapshots[0].baseAsset,"ETH");
  assert.equal(report.snapshots[0].quoteAsset,"BTC");
  assert.equal(report.snapshots[0].quoteUnitCode,"BTC");
  assert.equal(report.snapshots[0].orderbook.status,"ok");
  assert.equal(report.snapshots[0].trades.status,"ok");
  assert.equal(report.safety.liveTradingEnabled,false);
  assert.equal(report.safety.exchangeOrdersPlaced,0);
});
