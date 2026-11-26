import {createHash} from "node:crypto";

const DAY_MS = 86_400_000;
const BINANCE_BASE = "https://data-api.binance.vision";
const KRAKEN_BASE = "https://api.kraken.com/0";
const TABDEAL_BASE = "https://api1.tabdeal.org/r/api/v1";

export const INTERNATIONAL_MARKET_PAIRS = Object.freeze([
  {baseAsset:"BTC", binanceSymbol:"BTCUSDT", krakenPair:"XBTUSD", tabdealSymbol:"BTCUSDT"},
  {baseAsset:"ETH", binanceSymbol:"ETHUSDT", krakenPair:"ETHUSD", tabdealSymbol:"ETHUSDT"},
  {baseAsset:"SOL", binanceSymbol:"SOLUSDT", krakenPair:"SOLUSD", tabdealSymbol:"SOLUSDT"},
  {baseAsset:"XRP", binanceSymbol:"XRPUSDT", krakenPair:"XRPUSD", tabdealSymbol:"XRPUSDT"}
]);

export const INTERNATIONAL_INTERVALS = Object.freeze([
  {interval:"15m", durationMs:900_000, krakenMinutes:15, maxBackfillDays:30, incrementalBars:100},
  {interval:"1h", durationMs:3_600_000, krakenMinutes:60, maxBackfillDays:365, incrementalBars:100},
  {interval:"4h", durationMs:14_400_000, krakenMinutes:240, maxBackfillDays:730, incrementalBars:100}
]);

const finite = value => Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value) > 0;
const nonNegative = value => finite(value) && Number(value) >= 0;
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

function fail(code) {
  throw new Error(code);
}

function decimal(value, {allowZero=false}={}) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) return null;
  return number;
}

function intervalConfig(interval, intervals=INTERNATIONAL_INTERVALS) {
  const found = intervals.find(item => item.interval === interval);
  if (!found) fail("international_interval_not_allowlisted");
  return found;
}

function candleIsValid(candle, durationMs) {
  return Number.isSafeInteger(candle.openTimeMs) &&
    Number.isSafeInteger(candle.closeTimeMs) &&
    candle.openTimeMs > 0 &&
    candle.openTimeMs % durationMs === 0 &&
    candle.closeTimeMs >= candle.openTimeMs &&
    candle.closeTimeMs < candle.openTimeMs + durationMs &&
    [candle.open,candle.high,candle.low,candle.close].every(positive) &&
    nonNegative(candle.baseVolume) &&
    (candle.quoteVolume === null || nonNegative(candle.quoteVolume)) &&
    Number.isSafeInteger(candle.tradeCount) &&
    candle.tradeCount >= 0 &&
    candle.high >= Math.max(candle.open,candle.close,candle.low) &&
    candle.low <= Math.min(candle.open,candle.close,candle.high);
}

export function normalizeBinanceKlines({symbol, interval, rows, capturedAtMs}) {
  const config = intervalConfig(interval);
  if (!Array.isArray(rows) || !Number.isSafeInteger(capturedAtMs)) {
    fail("binance_klines_payload_invalid");
  }
  const output = [];
  let previousOpenTime = -1;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 9) fail("binance_kline_row_invalid");
    const candle = {
      provider:"binance_spot",
      sourceSymbol:String(symbol).toUpperCase(),
      symbol:String(symbol).toUpperCase(),
      baseAsset:String(symbol).toUpperCase().replace(/USDT$/,""),
      quoteAsset:"USDT",
      quoteUnit:"USDT",
      interval,
      openTimeMs:Number(row[0]),
      closeTimeMs:Number(row[6]),
      open:decimal(row[1]),
      high:decimal(row[2]),
      low:decimal(row[3]),
      close:decimal(row[4]),
      baseVolume:decimal(row[5],{allowZero:true}),
      quoteVolume:decimal(row[7],{allowZero:true}),
      tradeCount:Number(row[8])
    };
    if (candle.openTimeMs <= previousOpenTime || !candleIsValid(candle,config.durationMs)) {
      fail("binance_kline_order_or_ohlc_invalid");
    }
    previousOpenTime = candle.openTimeMs;
    if (candle.closeTimeMs < capturedAtMs) output.push(candle);
  }
  return output;
}

export function normalizeKrakenOhlc({baseAsset, pairKey, interval, rows, capturedAtMs}) {
  const config = intervalConfig(interval);
  if (!Array.isArray(rows) || !Number.isSafeInteger(capturedAtMs)) {
    fail("kraken_ohlc_payload_invalid");
  }
  const output = [];
  let previousOpenTime = -1;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) fail("kraken_ohlc_row_invalid");
    const openTimeMs = Math.round(Number(row[0]) * 1000);
    const candle = {
      provider:"kraken_spot",
      sourceSymbol:String(pairKey),
      symbol:String(baseAsset).toUpperCase()+"USD",
      baseAsset:String(baseAsset).toUpperCase(),
      quoteAsset:"USD",
      quoteUnit:"USD",
      interval,
      openTimeMs,
      closeTimeMs:openTimeMs + config.durationMs - 1,
      open:decimal(row[1]),
      high:decimal(row[2]),
      low:decimal(row[3]),
      close:decimal(row[4]),
      baseVolume:decimal(row[6],{allowZero:true}),
      quoteVolume:null,
      tradeCount:Number(row[7])
    };
    if (candle.openTimeMs <= previousOpenTime || !candleIsValid(candle,config.durationMs)) {
      fail("kraken_ohlc_order_or_ohlc_invalid");
    }
    previousOpenTime = candle.openTimeMs;
    // Kraken includes the currently forming, uncommitted interval as the final row.
    if (candle.closeTimeMs < capturedAtMs) output.push(candle);
  }
  return output;
}

export function normalizeTabdealBook({symbol, market, depth, capturedAtMs}) {
  const expectedSymbol=String(symbol||"").toUpperCase();
  const expectedBase=expectedSymbol.endsWith("USDT")?expectedSymbol.slice(0,-4):"";
  const actualSymbol=String(market?.symbol||"").toUpperCase();
  const actualBase=String(market?.baseAsset||"").toUpperCase();
  const quoteAsset = String(market?.quoteAsset || "").toUpperCase();
  if (!isRecord(market) || !expectedBase || actualSymbol!==expectedSymbol ||
      actualBase!==expectedBase || quoteAsset!=="USDT") {
    return {symbol:expectedSymbol,status:"market_symbol_or_asset_mismatch",capturedAtMs,quoteUnit:"USDT"};
  }
  if (market.status !== "TRADING" ||
      market.isSpotTradingAllowed !== true ||
      !Array.isArray(market.permissions) || !market.permissions.includes("SPOT")) {
    return {symbol,status:"market_not_active_usdt_spot",capturedAtMs,quoteUnit:"USDT"};
  }
  if (!isRecord(depth) || !Array.isArray(depth.bids) || !Array.isArray(depth.asks)) {
    return {symbol,status:"invalid_orderbook_payload",capturedAtMs,quoteUnit:"USDT"};
  }
  const toLevels = rows => rows
    .filter(row => Array.isArray(row) && row.length >= 2)
    .map(row => ({price:decimal(row[0]),quantity:decimal(row[1])}))
    .filter(row => row.price !== null && row.quantity !== null && row.quantity > 0);
  const bids = toLevels(depth.bids).sort((a,b)=>b.price-a.price);
  const asks = toLevels(depth.asks).sort((a,b)=>a.price-b.price);
  if (!bids.length || !asks.length || asks[0].price <= bids[0].price) {
    return {symbol,status:"crossed_or_empty_orderbook",capturedAtMs,quoteUnit:"USDT"};
  }
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const spreadBps = ((bestAsk-bestBid)/((bestAsk+bestBid)/2))*10_000;
  const quoteDepth = levels => levels.slice(0,5).reduce((sum,row)=>sum+row.price*row.quantity,0);
  const filter = type => Array.isArray(market.filters)
    ? market.filters.find(item=>isRecord(item)&&item.filterType===type) || null
    : null;
  const lot = filter("LOT_SIZE");
  const notional = filter("MIN_NOTIONAL") || filter("NOTIONAL");
  const price = filter("PRICE_FILTER");
  return {
    symbol:String(symbol).toUpperCase(),
    status:"ok",
    capturedAtMs,
    quoteUnit:"USDT",
    bestBid,
    bestAsk,
    spreadBps,
    bidDepthTop5Quote:quoteDepth(bids),
    askDepthTop5Quote:quoteDepth(asks),
    bidLevelCount:bids.length,
    askLevelCount:asks.length,
    updateId:depth.lastUpdateId===undefined?null:String(depth.lastUpdateId),
    marketRules:{
      minQty:lot?.minQty??null,
      stepSize:lot?.stepSize??null,
      minNotional:notional?.minNotional??null,
      tickSize:price?.tickSize??null,
      baseAssetPrecision:Number.isInteger(market.baseAssetPrecision)?market.baseAssetPrecision:null,
      quoteAssetPrecision:Number.isInteger(market.quoteAssetPrecision)?market.quoteAssetPrecision:null
    }
  };
}

export function compareCrossVenueCandleReturns(candles) {
  const grouped = new Map();
  for (const candle of candles) {
    const key = [candle.baseAsset,candle.interval,candle.openTimeMs].join("|");
    const bucket = grouped.get(key) || {};
    bucket[candle.provider] = candle;
    grouped.set(key,bucket);
  }
  const results = [];
  for (const [key,bucket] of grouped) {
    const binance = bucket.binance_spot;
    const kraken = bucket.kraken_spot;
    if (!binance || !kraken) continue;
    const binanceReturnBps = (binance.close/binance.open-1)*10_000;
    const krakenReturnBps = (kraken.close/kraken.open-1)*10_000;
    results.push({
      baseAsset:binance.baseAsset,
      interval:binance.interval,
      openTimeMs:binance.openTimeMs,
      binanceQuote:binance.quoteAsset,
      krakenQuote:kraken.quoteAsset,
      comparison:"same_asset_same_interval_return_only_different_quote_units",
      binanceReturnBps,
      krakenReturnBps,
      absoluteDifferenceBps:Math.abs(binanceReturnBps-krakenReturnBps)
    });
  }
  return results.sort((a,b)=>a.openTimeMs-b.openTimeMs || a.baseAsset.localeCompare(b.baseAsset));
}

async function getJson(url,{fetchImpl,timeoutMs}) {
  const response = await fetchImpl(url,{
    method:"GET",
    headers:{accept:"application/json"},
    redirect:"follow",
    signal:AbortSignal.timeout(timeoutMs)
  });
  if (!response?.ok) {
    const status = Number(response?.status)||0;
    throw new Error(status===429 ? "http_429_rate_limited" : "http_"+status);
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("invalid_json_response"); }
  return payload;
}

function buildUrl(base,path,params={}) {
  const normalizedBase=String(base).endsWith("/")?String(base):String(base)+"/";
  let relativePath=String(path);
  while(relativePath.startsWith("/")) relativePath=relativePath.slice(1);
  const url = new URL(relativePath,normalizedBase);
  for (const [key,value] of Object.entries(params)) {
    if (value!==undefined && value!==null) url.searchParams.set(key,String(value));
  }
  return url;
}

function validateKrakenResponse(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.error)) fail("kraken_response_invalid");
  if (payload.error.length) fail("kraken_api_error");
  if (!isRecord(payload.result)) fail("kraken_result_missing");
  return payload.result;
}

function findKrakenPair(assetPairs,pairName) {
  if (!isRecord(assetPairs)) return null;
  const normalized = String(pairName).toUpperCase();
  for (const [key,value] of Object.entries(assetPairs)) {
    if (!isRecord(value)) continue;
    const altname = String(value.altname||"").toUpperCase();
    const wsname = String(value.wsname||"").replace("/","").toUpperCase();
    if (altname===normalized || wsname===normalized) return {key,altname,wsname};
  }
  return null;
}

function isActiveTabdealSpot(market) {
  return isRecord(market) && typeof market.symbol==="string" &&
    typeof market.baseAsset==="string" && typeof market.quoteAsset==="string" &&
    market.status==="TRADING" && market.isSpotTradingAllowed===true &&
    Array.isArray(market.permissions) && market.permissions.includes("SPOT") &&
    String(market.quoteAsset).toUpperCase()==="USDT";
}

export function indexActiveTabdealSpotMarkets(payload) {
  if (!Array.isArray(payload)) fail("tabdeal_exchange_info_invalid");
  const activeBySymbol=new Map();
  const duplicateSymbols=new Set();
  for (const market of payload) {
    if (!isActiveTabdealSpot(market)) continue;
    const symbol=market.symbol.trim().toUpperCase();
    if (activeBySymbol.has(symbol)) duplicateSymbols.add(symbol);
    else activeBySymbol.set(symbol,market);
  }
  return {activeBySymbol,duplicateSymbols:[...duplicateSymbols].sort()};
}

function isoMonth(timeMs) {
  return new Date(timeMs).toISOString().slice(0,7);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function runInternationalMarketCollection({
  fetchImpl=fetch,
  now=()=>Date.now(),
  sleepImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  timeoutMs=12_000,
  mode="auto",
  historyPresent=false,
  backfillDays=730,
  pairs=INTERNATIONAL_MARKET_PAIRS,
  intervals=INTERNATIONAL_INTERVALS,
  requestSpacingMs=100,
  binanceBase=BINANCE_BASE,
  krakenBase=KRAKEN_BASE,
  tabdealBase=TABDEAL_BASE
}={}) {
  if (!["auto","incremental","backfill"].includes(mode)) fail("international_collection_mode_invalid");
  if (!Number.isSafeInteger(Number(backfillDays)) || Number(backfillDays)<1 || Number(backfillDays)>730) {
    fail("international_backfill_days_invalid");
  }
  const effectiveMode=mode==="auto"?(historyPresent?"incremental":"backfill"):mode;
  const startedAtMs=now();
  if (!Number.isSafeInteger(startedAtMs)||startedAtMs<=0) fail("international_clock_invalid");
  const startedAt=new Date(startedAtMs).toISOString();
  const candles=[];
  const books=[];
  const errors=[];
  const providerCounts={
    binance:{requests:0,closedCandles:0,failedSeries:0},
    kraken:{requests:0,closedCandles:0,failedSeries:0},
    tabdeal:{requests:0,validBooks:0,failedBooks:0}
  };
  const pause=async()=>{if(requestSpacingMs>0)await sleepImpl(requestSpacingMs);};

  // Binance public Market Data Only endpoints; no account key or signature.
  for (const pair of pairs) {
    for (const interval of intervals) {
      const durationMs=interval.durationMs;
      const endTimeMs=now()-1;
      const seriesStartMs=effectiveMode==="backfill"
        ? endTimeMs-Math.min(Number(backfillDays),interval.maxBackfillDays)*DAY_MS
        : endTimeMs-durationMs*interval.incrementalBars;
      let cursor=seriesStartMs;
      let pages=0;
      let seriesRows=[];
      try {
        while(cursor<=endTimeMs && pages<12) {
          await pause();
          const pageLimit=1000;
          const url=buildUrl(binanceBase,"/api/v3/klines",{
            symbol:pair.binanceSymbol,interval:interval.interval,
            startTime:Math.floor(cursor),endTime:Math.floor(endTimeMs),limit:pageLimit
          });
          const raw=await getJson(url,{fetchImpl,timeoutMs});
          providerCounts.binance.requests++;
          const normalized=normalizeBinanceKlines({
            symbol:pair.binanceSymbol,interval:interval.interval,
            rows:raw,capturedAtMs:now()
          });
          seriesRows.push(...normalized);
          pages++;
          if (!raw.length || raw.length<pageLimit) break;
          const lastOpen=Number(raw.at(-1)?.[0]);
          const nextCursor=lastOpen+durationMs;
          if (!Number.isSafeInteger(lastOpen)||nextCursor<=cursor) {
            fail("binance_pagination_did_not_advance");
          }
          cursor=nextCursor;
        }
        const seen=new Set();
        for (const row of seriesRows) {
          if (seen.has(row.openTimeMs)) fail("binance_pagination_duplicate_candle");
          seen.add(row.openTimeMs);
        }
        seriesRows.sort((a,b)=>a.openTimeMs-b.openTimeMs);
        candles.push(...seriesRows);
        providerCounts.binance.closedCandles+=seriesRows.length;
        if (!seriesRows.length) {
          providerCounts.binance.failedSeries++;
          errors.push({provider:"binance",symbol:pair.binanceSymbol,interval:interval.interval,code:"no_closed_candles"});
        }
      } catch (error) {
        providerCounts.binance.failedSeries++;
        errors.push({provider:"binance",symbol:pair.binanceSymbol,interval:interval.interval,code:String(error?.message||error).slice(0,100)});
      }
    }
  }

  // Kraken's public OHLC is an independent reference. Its last row is the
  // current uncommitted candle; normalizeKrakenOhlc excludes it.
  let krakenPairs={};
  try {
    await pause();
    const payload=await getJson(buildUrl(krakenBase,"/public/AssetPairs"),{fetchImpl,timeoutMs});
    providerCounts.kraken.requests++;
    krakenPairs=validateKrakenResponse(payload);
  } catch (error) {
    errors.push({provider:"kraken",code:String(error?.message||error).slice(0,100)});
  }
  for (const pair of pairs) {
    const resolved=findKrakenPair(krakenPairs,pair.krakenPair);
    if (!resolved) {
      providerCounts.kraken.failedSeries++;
      errors.push({provider:"kraken",symbol:pair.krakenPair,code:"pair_not_available"});
      continue;
    }
    for (const interval of intervals) {
      try {
        await pause();
        const payload=await getJson(buildUrl(krakenBase,"/public/OHLC",{
          pair:resolved.altname,interval:interval.krakenMinutes
        }),{fetchImpl,timeoutMs});
        providerCounts.kraken.requests++;
        const result=validateKrakenResponse(payload);
        const rows=result[resolved.key] || result[resolved.altname] ||
          Object.entries(result).find(([key,value])=>key!=="last"&&Array.isArray(value))?.[1];
        const normalized=normalizeKrakenOhlc({
          baseAsset:pair.baseAsset,pairKey:resolved.altname,
          interval:interval.interval,rows,capturedAtMs:now()
        });
        const recent=effectiveMode==="backfill" ? normalized : normalized.slice(-100);
        candles.push(...recent);
        providerCounts.kraken.closedCandles+=recent.length;
        if (!recent.length) {
          providerCounts.kraken.failedSeries++;
          errors.push({provider:"kraken",symbol:resolved.altname,interval:interval.interval,code:"no_closed_candles"});
        }
      } catch (error) {
        providerCounts.kraken.failedSeries++;
        errors.push({provider:"kraken",symbol:resolved.altname,interval:interval.interval,code:String(error?.message||error).slice(0,100)});
      }
    }
  }

  // Tabdeal is the intended execution venue. Only same-quote USDT Spot pairs
  // are admitted here; IRT is deliberately excluded until denomination is verified.
  let tabdealMarkets=[];
  try {
    await pause();
    const marketPayload=await getJson(buildUrl(tabdealBase,"/exchangeInfo"),{fetchImpl,timeoutMs});
    providerCounts.tabdeal.requests++;
    if (!Array.isArray(marketPayload)) fail("tabdeal_exchange_info_invalid");
    tabdealMarkets=marketPayload;
  } catch (error) {
    errors.push({provider:"tabdeal",code:String(error?.message||error).slice(0,100)});
  }
  const {activeBySymbol,duplicateSymbols}=indexActiveTabdealSpotMarkets(tabdealMarkets);
  for (const pair of pairs) {
    const requestedSymbol=String(pair.tabdealSymbol).toUpperCase();
    const market=activeBySymbol.get(requestedSymbol);
    if (duplicateSymbols.includes(requestedSymbol)) {
      providerCounts.tabdeal.failedBooks++;
      books.push({symbol:requestedSymbol,status:"duplicate_market_metadata",quoteUnit:"USDT",capturedAtMs:now()});
      continue;
    }
    if (!market) {
      providerCounts.tabdeal.failedBooks++;
      books.push({symbol:pair.tabdealSymbol,status:"not_active_usdt_spot",quoteUnit:"USDT",capturedAtMs:now()});
      continue;
    }
    try {
      await pause();
      const url=buildUrl(tabdealBase,"/depth",{symbol:pair.tabdealSymbol,limit:20});
      const depth=await getJson(url,{fetchImpl,timeoutMs});
      providerCounts.tabdeal.requests++;
      const book=normalizeTabdealBook({
        symbol:pair.tabdealSymbol,market,depth,capturedAtMs:now()
      });
      books.push(book);
      if (book.status==="ok") providerCounts.tabdeal.validBooks++;
      else providerCounts.tabdeal.failedBooks++;
    } catch (error) {
      providerCounts.tabdeal.failedBooks++;
      books.push({
        symbol:pair.tabdealSymbol,status:"fetch_error",
        errorCode:String(error?.message||error).slice(0,80),
        quoteUnit:"USDT",capturedAtMs:now()
      });
    }
  }

  const crossChecks=compareCrossVenueCandleReturns(candles);
  const completedAtMs=now();
  const result={
    schemaVersion:1,
    provider:"INTERNATIONAL_MARKET_HISTORY",
    mode:effectiveMode,
    startedAt,
    capturedAt:new Date(completedAtMs).toISOString(),
    backfillPlan:effectiveMode==="backfill"
      ? {requestedDays:Number(backfillDays),intervalCaps:Object.fromEntries(intervals.map(item=>[item.interval,item.maxBackfillDays]))}
      : {incrementalBars:Object.fromEntries(intervals.map(item=>[item.interval,item.incrementalBars]))},
    pairs:pairs.map(item=>({
      baseAsset:item.baseAsset,
      binanceSymbol:item.binanceSymbol,
      krakenPair:item.krakenPair,
      tabdealSymbol:item.tabdealSymbol
    })),
    intervals:intervals.map(item=>({interval:item.interval,durationMs:item.durationMs})),
    providerCounts,
    sourceErrors:errors,
    candles:candles.sort((a,b)=>a.provider.localeCompare(b.provider)||
      a.symbol.localeCompare(b.symbol)||a.interval.localeCompare(b.interval)||a.openTimeMs-b.openTimeMs),
    tabdealBooks:books.sort((a,b)=>a.symbol.localeCompare(b.symbol)),
    crossChecks,
    safety:{
      unauthenticatedPublicGetOnly:true,
      apiKeysUsed:false,
      apiSecretsUsed:false,
      privateEndpointsUsed:false,
      accountDataRead:false,
      orderSubmissionAttempted:false,
      exchangeOrdersPlaced:0,
      fundsMoved:false,
      liveTradingEnabled:false,
      leverageUsed:false,
      shortSellingUsed:false
    },
    limitations:[
      "Binance candles use USDT quotes; Kraken candles use USD quotes. Cross-venue comparisons are based on within-candle percentage returns, not raw price joins.",
      "Tabdeal local book snapshots are executable-venue context only; external candle prices are never treated as Tabdeal fills.",
      "The collector captures closed candles only and does not forward-fill gaps or fabricate OHLC bars.",
      "Kraken OHLC provides a bounded recent window; Binance is the longer-history backfill source.",
      "No strategy is approved or promoted by this collector. Live trading remains disabled."
    ]
  };
  if (providerCounts.binance.closedCandles===0) fail("international_binance_history_unavailable");
  const hashInput=JSON.stringify(result);
  result.snapshotId=sha256(hashInput);
  result.summary={
    totalCandles:result.candles.length,
    binanceCandles:providerCounts.binance.closedCandles,
    krakenCandles:providerCounts.kraken.closedCandles,
    tabdealBooksOk:providerCounts.tabdeal.validBooks,
    crossVenueMatches:crossChecks.length,
    failedSeries:providerCounts.binance.failedSeries+providerCounts.kraken.failedSeries
  };
  return result;
}

export const internationalMarketHistoryInternals=Object.freeze({
  intervalConfig,findKrakenPair,isActiveTabdealSpot,sha256,isoMonth
});
