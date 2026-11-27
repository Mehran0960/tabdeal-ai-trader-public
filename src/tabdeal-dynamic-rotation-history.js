import {createHash} from "node:crypto";
import {
  buildTabdealRotationUniverse,
  TABDEAL_ROTATION_UNIVERSE_POLICY
} from "./tabdeal-rotation-universe.js";
import {
  normalizeBinanceKlines,
  normalizeTabdealBook
} from "./international-market-history.js";

export const TABDEAL_DYNAMIC_HISTORY_POLICY=Object.freeze({
  interval:"4h",
  intervalMs:14_400_000,
  maximumBackfillDays:730,
  minimumHistoryBarsForTournament:2_000,
  defaultMarkets:TABDEAL_ROTATION_UNIVERSE_POLICY.maximumResearchMarkets,
  requestSpacingMs:100,
  timeoutMs:12_000,
  maximumPagesPerSymbol:12,
  depthLimit:20,
  provisionalDataOnly:true
});
const DAY_MS=86_400_000;
const BINANCE_BASE="https://data-api.binance.vision";
const TABDEAL_BASE="https://api1.tabdeal.org/r/api/v1";
const isRecord=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const positive=value=>Number.isFinite(Number(value))&&Number(value)>0;
function fail(code){throw new Error(code);}
function sha256(value){return createHash("sha256").update(value).digest("hex");}
function buildUrl(base,path,params={}){
  const root=String(base).endsWith("/")?String(base):String(base)+"/";
  let relative=String(path);
  while(relative.startsWith("/"))relative=relative.slice(1);
  const url=new URL(relative,root);
  for(const [key,value] of Object.entries(params)){
    if(value!==undefined&&value!==null)url.searchParams.set(key,String(value));
  }
  return url;
}
function retryDelay(response,attempt){
  const header=Number(response?.headers?.get?.("retry-after"));
  if(Number.isFinite(header)&&header>0)return Math.min(120_000,Math.max(1_000,header*1_000));
  return Math.min(30_000,1_000*(2**attempt));
}
async function getJson(url,{
  fetchImpl=fetch,sleepImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  timeoutMs=TABDEAL_DYNAMIC_HISTORY_POLICY.timeoutMs,
  maxRetries=3,requestSpacingMs=0
}={}){
  let lastError=null;
  for(let attempt=0;attempt<=maxRetries;attempt++){
    if(requestSpacingMs>0)await sleepImpl(requestSpacingMs);
    let response;
    try{
      response=await fetchImpl(url,{
        method:"GET",headers:{accept:"application/json"},redirect:"follow",
        signal:AbortSignal.timeout(timeoutMs)
      });
    }catch(error){
      lastError=new Error("market_data_network_error");
      if(attempt<maxRetries){await sleepImpl(retryDelay(null,attempt));continue;}
      break;
    }
    const status=Number(response?.status)||0;
    if(status===429||status===418||status>=500){
      lastError=new Error(status===429?"binance_or_tabdeal_rate_limited":
        status===418?"market_data_ip_banned":"market_data_server_error_"+status);
      if(attempt<maxRetries){await sleepImpl(retryDelay(response,attempt));continue;}
      break;
    }
    if(!response?.ok)throw new Error("market_data_http_"+status);
    try{return await response.json();}
    catch{throw new Error("market_data_invalid_json");}
  }
  throw lastError||new Error("market_data_request_failed");
}
function normalizedLatestIndex(input){
  if(!isRecord(input))return {};
  const output={};
  for(const [symbol,time] of Object.entries(input)){
    const normalized=String(symbol).trim().toUpperCase();
    const value=Number(time);
    if(/^[A-Z0-9]{2,30}$/.test(normalized)&&Number.isSafeInteger(value)&&value>0){
      output[normalized]=value;
    }
  }
  return output;
}
function buildSnapshotId(snapshot){
  const copy={...snapshot};
  delete copy.snapshotId;
  return sha256(JSON.stringify(copy));
}

export async function runTabdealDynamicRotationHistoryCapture({
  fetchImpl=fetch,
  now=()=>Date.now(),
  sleepImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  latestOpenTimeBySymbol={},
  maxMarkets=TABDEAL_DYNAMIC_HISTORY_POLICY.defaultMarkets,
  backfillDays=TABDEAL_DYNAMIC_HISTORY_POLICY.maximumBackfillDays,
  minimumQuoteVolumeUsdt=TABDEAL_ROTATION_UNIVERSE_POLICY.minimumBinanceQuoteVolumeUsdt,
  minimumTradeCount24h=TABDEAL_ROTATION_UNIVERSE_POLICY.minimumBinanceTradeCount24h,
  requestSpacingMs=TABDEAL_DYNAMIC_HISTORY_POLICY.requestSpacingMs,
  timeoutMs=TABDEAL_DYNAMIC_HISTORY_POLICY.timeoutMs,
  maximumPagesPerSymbol=TABDEAL_DYNAMIC_HISTORY_POLICY.maximumPagesPerSymbol,
  binanceBase=BINANCE_BASE,
  tabdealBase=TABDEAL_BASE
}={}){
  if(!Number.isSafeInteger(Number(maxMarkets))||Number(maxMarkets)<1||
     Number(maxMarkets)>TABDEAL_ROTATION_UNIVERSE_POLICY.maximumResearchMarkets||
     !Number.isSafeInteger(Number(backfillDays))||Number(backfillDays)<1||
     Number(backfillDays)>TABDEAL_DYNAMIC_HISTORY_POLICY.maximumBackfillDays||
     !Number.isSafeInteger(Number(maximumPagesPerSymbol))||Number(maximumPagesPerSymbol)<1||
     Number(maximumPagesPerSymbol)>20||
     !Number.isSafeInteger(Number(requestSpacingMs))||Number(requestSpacingMs)<0||
     !positive(minimumQuoteVolumeUsdt)||
     !Number.isSafeInteger(Number(minimumTradeCount24h))||Number(minimumTradeCount24h)<0){
    fail("tabdeal_dynamic_history_policy_invalid");
  }
  const startedAtMs=now();
  if(!Number.isSafeInteger(startedAtMs)||startedAtMs<=0)fail("tabdeal_dynamic_history_clock_invalid");
  const latestIndex=normalizedLatestIndex(latestOpenTimeBySymbol);
  const fetchOptions={fetchImpl,sleepImpl,timeoutMs,requestSpacingMs};

  // All data requests are public GETs. No user account endpoints or credentials.
  const [tabdealInfo,binanceInfo,binanceTickers]=await Promise.all([
    getJson(buildUrl(tabdealBase,"/exchangeInfo"),fetchOptions),
    getJson(buildUrl(binanceBase,"/api/v3/exchangeInfo"),fetchOptions),
    getJson(buildUrl(binanceBase,"/api/v3/ticker/24hr"),fetchOptions)
  ]);
  if(!Array.isArray(tabdealInfo)||!isRecord(binanceInfo)||!Array.isArray(binanceInfo.symbols)||
     !Array.isArray(binanceTickers)){
    fail("tabdeal_dynamic_history_market_discovery_payload_invalid");
  }
  const universe=buildTabdealRotationUniverse({
    tabdealExchangeInfo:tabdealInfo,
    binanceExchangeInfo:binanceInfo,
    binanceTickers24h:binanceTickers,
    minimumQuoteVolumeUsdt:Number(minimumQuoteVolumeUsdt),
    minimumTradeCount24h:Number(minimumTradeCount24h),
    maximumMarkets:Number(maxMarkets)
  });
  if(!Array.isArray(universe.markets)||!universe.markets.length){
    fail("tabdeal_dynamic_history_universe_empty");
  }

  const candles=[];
  const books=[];
  const sourceErrors=[];
  const latestBySymbol={...latestIndex};
  const counts={
    binanceKlineRequests:0,binanceClosedCandles:0,
    symbolsWithNewCandles:0,symbolsWithHistoryErrors:0,
    tabdealDepthRequests:0,validTabdealBooks:0,failedTabdealBooks:0,
    paginationCapHits:0
  };
  const capturedAtMs=now();
  const endTimeMs=capturedAtMs-1;

  for(const market of universe.markets){
    const symbol=market.symbol;
    const knownLatest=Number(latestBySymbol[symbol]);
    const initialStart=Math.floor((capturedAtMs-Number(backfillDays)*DAY_MS)/
      TABDEAL_DYNAMIC_HISTORY_POLICY.intervalMs)*TABDEAL_DYNAMIC_HISTORY_POLICY.intervalMs;
    let cursor=Number.isSafeInteger(knownLatest)&&knownLatest>0
      ?knownLatest+TABDEAL_DYNAMIC_HISTORY_POLICY.intervalMs
      :initialStart;
    let pages=0,seriesRows=0,lastFetchedOpen=null;
    try{
      while(cursor<=endTimeMs&&pages<Number(maximumPagesPerSymbol)){
        const raw=await getJson(buildUrl(binanceBase,"/api/v3/klines",{
          symbol,interval:TABDEAL_DYNAMIC_HISTORY_POLICY.interval,
          startTime:Math.floor(cursor),endTime:Math.floor(endTimeMs),limit:1000
        }),fetchOptions);
        counts.binanceKlineRequests++;
        if(!Array.isArray(raw))fail("binance_dynamic_klines_payload_invalid_"+symbol);
        if(!raw.length)break;
        const normalized=normalizeBinanceKlines({
          symbol,interval:TABDEAL_DYNAMIC_HISTORY_POLICY.interval,
          rows:raw,capturedAtMs:now()
        });
        candles.push(...normalized);
        seriesRows+=normalized.length;
        for(const row of normalized){
          latestBySymbol[symbol]=Math.max(Number(latestBySymbol[symbol])||0,row.openTimeMs);
        }
        const lastOpen=Number(raw.at(-1)?.[0]);
        if(!Number.isSafeInteger(lastOpen)||lastOpen<cursor||
           (lastFetchedOpen!==null&&lastOpen<=lastFetchedOpen)){
          fail("binance_dynamic_pagination_did_not_advance_"+symbol);
        }
        lastFetchedOpen=lastOpen;
        pages++;
        if(raw.length<1000)break;
        const next=lastOpen+TABDEAL_DYNAMIC_HISTORY_POLICY.intervalMs;
        if(next<=cursor)fail("binance_dynamic_pagination_cursor_invalid_"+symbol);
        cursor=next;
      }
      if(pages>=Number(maximumPagesPerSymbol)&&cursor<=endTimeMs){
        counts.paginationCapHits++;
        sourceErrors.push({provider:"binance_spot",symbol,code:"pagination_page_cap_reached"});
      }
      if(seriesRows>0){
        counts.symbolsWithNewCandles++;
        counts.binanceClosedCandles+=seriesRows;
      }
    }catch(error){
      counts.symbolsWithHistoryErrors++;
      sourceErrors.push({provider:"binance_spot",symbol,
        code:String(error?.message||error).slice(0,100)});
    }
  }

  for(const market of universe.markets){
    const symbol=market.symbol;
    try{
      const depth=await getJson(buildUrl(tabdealBase,"/depth",{
        symbol,limit:TABDEAL_DYNAMIC_HISTORY_POLICY.depthLimit
      }),fetchOptions);
      counts.tabdealDepthRequests++;
      const book=normalizeTabdealBook({
        symbol,market,depth,capturedAtMs:now()
      });
      books.push(book);
      if(book.status==="ok")counts.validTabdealBooks++;
      else{
        counts.failedTabdealBooks++;
        sourceErrors.push({provider:"tabdeal_spot",symbol,code:book.status});
      }
    }catch(error){
      counts.failedTabdealBooks++;
      books.push({symbol,status:"fetch_error",errorCode:String(error?.message||error).slice(0,80),
        capturedAtMs:now(),quoteUnit:"USDT"});
      sourceErrors.push({provider:"tabdeal_spot",symbol,
        code:String(error?.message||error).slice(0,100)});
    }
  }

  candles.sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.openTimeMs-b.openTimeMs);
  books.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  const snapshot={
    schemaVersion:1,
    provider:"INTERNATIONAL_MARKET_HISTORY",
    mode:"dynamic_tabdeal_binance_spot_4h",
    startedAt:new Date(startedAtMs).toISOString(),
    capturedAt:new Date(now()).toISOString(),
    pairs:universe.markets.map(row=>({
      baseAsset:row.baseAsset,binanceSymbol:row.symbol,tabdealSymbol:row.symbol
    })),
    intervals:[{interval:"4h",durationMs:TABDEAL_DYNAMIC_HISTORY_POLICY.intervalMs}],
    marketUniverse:{
      status:universe.status,coverageComplete:universe.coverageComplete,
      eligibleBeforeCap:universe.eligibleBeforeCap,
      selectedMarketCount:universe.selectedMarketCount,
      omittedBySafetyCap:universe.omittedBySafetyCap,
      minimumQuoteVolumeUsdt:universe.minimumQuoteVolumeUsdt,
      minimumTradeCount24h:universe.minimumTradeCount24h,
      excluded:universe.excluded
    },
    candles,tabdealBooks:books,crossChecks:[],
    sourceErrors,
    safety:{
      unauthenticatedPublicGetOnly:true,apiKeysUsed:false,apiSecretsUsed:false,
      privateEndpointsUsed:false,accountDataRead:false,orderSubmissionAttempted:false,
      exchangeOrdersPlaced:0,fundsMoved:false,liveTradingEnabled:false,
      leverageUsed:false,shortSellingUsed:false
    }
  };
  snapshot.snapshotId=buildSnapshotId(snapshot);
  const summary={
    universeStatus:universe.status,coverageComplete:universe.coverageComplete,
    eligibleBeforeCap:universe.eligibleBeforeCap,selectedMarketCount:universe.selectedMarketCount,
    omittedBySafetyCap:universe.omittedBySafetyCap,
    totalBinanceClosedCandles:candles.length,
    symbolsWithNewCandles:counts.symbolsWithNewCandles,
    validTabdealBooks:counts.validTabdealBooks,
    failedTabdealBooks:counts.failedTabdealBooks,
    sourceErrorCount:sourceErrors.length,
    paginationCapHits:counts.paginationCapHits
  };
  if(!candles.length&&counts.symbolsWithNewCandles===0&&
     universe.markets.every(row=>latestIndex[row.symbol])){
    // A no-new-candle incremental run remains valid; fresh local books are still useful.
  }else if(!candles.length){
    fail("tabdeal_dynamic_history_no_closed_candles_captured");
  }
  return {
    snapshot,universe,latestOpenTimeBySymbol:latestBySymbol,
    counts,summary,sourceErrors,
    safety:{...snapshot.safety}
  };
}

export const tabdealDynamicHistoryInternals=Object.freeze({
  buildUrl,getJson,normalizedLatestIndex,buildSnapshotId,retryDelay
});
