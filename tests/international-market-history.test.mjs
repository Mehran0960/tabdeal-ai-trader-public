import test from "node:test";
import assert from "node:assert/strict";
import {
  INTERNATIONAL_MARKET_PAIRS,
  normalizeBinanceKlines,
  normalizeKrakenOhlc,
  normalizeTabdealBook,
  indexActiveTabdealSpotMarkets,
  compareCrossVenueCandleReturns,
  runInternationalMarketCollection
} from "../src/international-market-history.js";

const NOW=Date.parse("2026-11-26T12:00:00.000Z");

test("normalizes only fully closed Binance 4h candles",()=>{
  const rows=[
    [NOW-8*3600000,"100","110","95","105","10",NOW-4*3600000-1,"1050",20],
    [NOW,"105","115","100","110","12",NOW+4*3600000-1,"1320",25]
  ];
  const candles=normalizeBinanceKlines({symbol:"BTCUSDT",interval:"4h",rows,capturedAtMs:NOW});
  assert.equal(candles.length,1);
  assert.equal(candles[0].close,105);
  assert.equal(candles[0].quoteAsset,"USDT");
});

test("rejects duplicate, unordered or structurally invalid Binance candles",()=>{
  const row=[NOW-8*3600000,"100","110","95","105","10",NOW-4*3600000-1,"1050",20];
  assert.throws(()=>normalizeBinanceKlines({
    symbol:"BTCUSDT",interval:"4h",rows:[row,row],capturedAtMs:NOW
  }),/order_or_ohlc_invalid/);
  const bad=[NOW-8*3600000,"100","90","95","105","10",NOW-4*3600000-1,"1050",20];
  assert.throws(()=>normalizeBinanceKlines({
    symbol:"BTCUSDT",interval:"4h",rows:[bad],capturedAtMs:NOW
  }),/order_or_ohlc_invalid/);
});

test("excludes Kraken's current uncommitted candle",()=>{
  const rows=[
    [Math.floor((NOW-8*3600000)/1000),"100","110","95","105","102","10",20],
    [Math.floor((NOW-4*3600000)/1000),"105","115","100","110","108","12",25],
    [Math.floor(NOW/1000),"110","120","105","115","112","4",8]
  ];
  const candles=normalizeKrakenOhlc({
    baseAsset:"BTC",pairKey:"XBTUSD",interval:"4h",rows,capturedAtMs:NOW
  });
  assert.equal(candles.length,2);
  assert.equal(candles[0].quoteAsset,"USD");
  assert.equal(candles[1].close,110);
});

test("cross venue comparison uses percentage returns, never raw USD/USDT price joins",()=>{
  const binance={
    provider:"binance_spot",baseAsset:"BTC",symbol:"BTCUSDT",quoteAsset:"USDT",
    interval:"4h",openTimeMs:1000,open:100,close:110
  };
  const kraken={
    provider:"kraken_spot",baseAsset:"BTC",symbol:"BTCUSD",quoteAsset:"USD",
    interval:"4h",openTimeMs:1000,open:200,close:220
  };
  const [check]=compareCrossVenueCandleReturns([binance,kraken]);
  assert.equal(check.comparison,"same_asset_same_interval_return_only_different_quote_units");
  assert.equal(check.absoluteDifferenceBps,0);
  assert.equal(check.binanceQuote,"USDT");
  assert.equal(check.krakenQuote,"USD");
});

test("normalizes Tabdeal USDT Spot depth and its public execution filters",()=>{
  const market={
    symbol:"BTCUSDT",baseAsset:"BTC",status:"TRADING",isSpotTradingAllowed:true,
    permissions:["SPOT"],quoteAsset:"USDT",
    filters:[
      {filterType:"LOT_SIZE",minQty:"0.0001",maxQty:"100",stepSize:"0.0001"},
      {filterType:"MIN_NOTIONAL",minNotional:"10"},
      {filterType:"PRICE_FILTER",tickSize:"0.01"}
    ]
  };
  const depth={
    lastUpdateId:42,
    bids:[["100","2"],["99","3"]],
    asks:[["101","1"],["102","2"]]
  };
  const book=normalizeTabdealBook({symbol:"BTCUSDT",market,depth,capturedAtMs:NOW});
  assert.equal(book.status,"ok");
  assert.equal(book.bestBid,100);
  assert.equal(book.bestAsk,101);
  assert.equal(book.marketRules.minNotional,"10");
  assert.equal(book.marketRules.maxQty,"100");
  assert.deepEqual(book.bidLevelsTop5,[["100","2"],["99","3"]]);
  assert.deepEqual(book.askLevelsTop5,[["101","1"],["102","2"]]);
  assert.equal(book.quoteUnit,"USDT");
});

test("rejects mismatched Tabdeal symbol metadata and duplicate active markets",()=>{
  const market={symbol:"ETHUSDT",baseAsset:"ETH",status:"TRADING",isSpotTradingAllowed:true,
    permissions:["SPOT"],quoteAsset:"USDT"};
  const depth={bids:[["100","1"]],asks:[["101","1"]]};
  const mismatched=normalizeTabdealBook({symbol:"BTCUSDT",market,depth,capturedAtMs:NOW});
  assert.equal(mismatched.status,"market_symbol_or_asset_mismatch");
  const duplicate=indexActiveTabdealSpotMarkets([
    {...market,symbol:"BTCUSDT",baseAsset:"BTC"},
    {...market,symbol:"BTCUSDT",baseAsset:"BTC"}
  ]);
  assert.deepEqual(duplicate.duplicateSymbols,["BTCUSDT"]);
  assert.equal(duplicate.activeBySymbol.has("BTCUSDT"),true);
});

test("fails closed on crossed Tabdeal books",()=>{
  const market={symbol:"BTCUSDT",baseAsset:"BTC",status:"TRADING",isSpotTradingAllowed:true,permissions:["SPOT"],quoteAsset:"USDT"};
  const depth={bids:[["101","1"]],asks:[["100","1"]]};
  const book=normalizeTabdealBook({symbol:"BTCUSDT",market,depth,capturedAtMs:NOW});
  assert.equal(book.status,"crossed_or_empty_orderbook");
});

test("collector uses only public GETs and returns no account or order capability",async()=>{
  const urls=[];
  const fetchImpl=async(input,options)=>{
    const url=new URL(input);
    urls.push({url:url.toString(),method:options?.method});
    let body;
    if(url.pathname.endsWith("/AssetPairs")){
      body={error:[],result:{XXBTZUSD:{altname:"XBTUSD",wsname:"XBT/USD"}}};
    }else if(url.pathname.endsWith("/OHLC")){
      body={error:[],result:{XXBTZUSD:[
        [Math.floor((NOW-8*3600000)/1000),"100","110","95","105","102","10",20],
        [Math.floor((NOW-4*3600000)/1000),"105","115","100","110","108","12",25],
        [Math.floor(NOW/1000),"110","120","105","115","112","4",8]
      ],last:0}};
    }else if(url.hostname==="data-api.binance.vision"){
      body=[[NOW-8*3600000,"100","110","95","105","10",NOW-4*3600000-1,"1050",20]];
    }else if(url.pathname.endsWith("/exchangeInfo")){
      body=[{
        symbol:"BTCUSDT",baseAsset:"BTC",quoteAsset:"USDT",status:"TRADING",
        isSpotTradingAllowed:true,permissions:["SPOT"],filters:[]
      }];
    }else if(url.pathname.endsWith("/depth")){
      body={lastUpdateId:1,bids:[["100","2"]],asks:[["101","1"]]};
    }else{
      return {ok:false,status:404,json:async()=>({})};
    }
    return {ok:true,status:200,json:async()=>body};
  };
  const report=await runInternationalMarketCollection({
    fetchImpl,
    now:()=>NOW,
    sleepImpl:async()=>{},
    requestSpacingMs:0,
    mode:"incremental",
    pairs:[{baseAsset:"BTC",binanceSymbol:"BTCUSDT",krakenPair:"XBTUSD",tabdealSymbol:"BTCUSDT"}],
    intervals:[{interval:"4h",durationMs:14_400_000,krakenMinutes:240,maxBackfillDays:365,incrementalBars:100}]
  });
  assert.equal(report.provider,"INTERNATIONAL_MARKET_HISTORY");
  assert.equal(report.summary.binanceCandles,1);
  assert.equal(report.summary.krakenCandles,2);
  assert.equal(report.summary.tabdealBooksOk,1);
  assert.equal(report.safety.apiKeysUsed,false);
  assert.equal(report.safety.orderSubmissionAttempted,false);
  assert.equal(report.safety.exchangeOrdersPlaced,0);
  assert.ok(urls.every(item=>item.method==="GET"));
  const requestPaths=urls.map(item=>new URL(item.url).pathname);
  assert.ok(requestPaths.includes("/0/public/AssetPairs"));
  assert.ok(requestPaths.includes("/0/public/OHLC"));
  assert.ok(requestPaths.includes("/r/api/v1/exchangeInfo"));
  assert.ok(requestPaths.includes("/r/api/v1/depth"));
  assert.ok(urls.every(item=>!/signature|apiKey|secret/i.test(item.url)));
});


test("pre-registers Dogecoin across Binance Spot, Kraken Spot and Tabdeal Spot",()=>{
  const doge=INTERNATIONAL_MARKET_PAIRS.find(pair=>pair.baseAsset==="DOGE");
  assert.deepEqual(doge,{
    baseAsset:"DOGE",binanceSymbol:"DOGEUSDT",krakenPair:"XDGUSD",tabdealSymbol:"DOGEUSDT"
  });
});


test("supports closed Binance daily candles with exact UTC boundaries",()=>{
  const currentDayOpen=Math.floor(NOW/86_400_000)*86_400_000;
  const lastClosedOpen=currentDayOpen-86_400_000;
  const row=[lastClosedOpen,"100","110","95","105","10",lastClosedOpen+86_400_000-1,"1050",20];
  const candles=normalizeBinanceKlines({symbol:"BTCUSDT",interval:"1d",rows:[row],capturedAtMs:NOW});
  assert.equal(candles.length,1);
  assert.equal(candles[0].interval,"1d");
  assert.equal(candles[0].close,105);
});

test("normalizes Kraken daily OHLC as a separate USD reference",()=>{
  const currentDayOpen=Math.floor(NOW/86_400_000)*86_400_000;
  const rows=[
    [Math.floor((currentDayOpen-2*86_400_000)/1000),"100","110","95","105","102","10",20],
    [Math.floor((currentDayOpen-86_400_000)/1000),"105","115","100","110","108","12",25],
    [Math.floor(currentDayOpen/1000),"110","120","105","115","112","4",8]
  ];
  const candles=normalizeKrakenOhlc({baseAsset:"BTC",pairKey:"XBTUSD",interval:"1d",rows,capturedAtMs:NOW});
  assert.equal(candles.length,2);
  assert.equal(candles[0].quoteAsset,"USD");
  assert.equal(candles[0].interval,"1d");
});
