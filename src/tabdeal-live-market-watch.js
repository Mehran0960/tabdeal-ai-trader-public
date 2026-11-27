export const TABDEAL_LIVE_WATCH_POLICY = Object.freeze({
  apiBase: "https://api1.tabdeal.org/r/api/v1",
  websocketUrl: "wss://api1.tabdeal.org/stream/",
  allowedQuoteAssets: Object.freeze(["USDT", "BTC"]),
  excludedAssets: Object.freeze(["IRT"]),
  maximumMarkets: 1000,
  subscriptionBatchSize: 25,
  maximumBookAgeMs: 8_000,
  maximumEventLagMs: 10_000,
  barIntervalMs: 60_000,
  retainedBars: 90,
  minimumBarsForCandidate: 16,
  relativeLookbackMinutes: 15,
  reversalLookbackMinutes: 5,
  minimumRelativeUnderperformanceBps: 100,
  minimumRelativeZScore: 2,
  maximumSpreadBps: 35,
  minimumTopFiveDepthUsdt: 1_000,
  provisionalFeeBpsPerOrder: 40,
  provisionalSlippageBpsPerOrder: 10,
  stateSchemaVersion: 1
});

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value) > 0;
const nonNegative = value => finite(value) && Number(value) >= 0;

function fail(code) {
  throw new Error(code);
}
function median(values) {
  const clean=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!clean.length)return null;
  const mid=Math.floor(clean.length/2);
  return clean.length%2?clean[mid]:(clean[mid-1]+clean[mid])/2;
}
function mad(values,centre=median(values)) {
  if(!finite(centre))return null;
  return median(values.filter(Number.isFinite).map(value=>Math.abs(value-centre)));
}
function parseLevels(rows,descending) {
  if(!Array.isArray(rows)||rows.length>100)return null;
  const levels=[];
  for(const row of rows){
    if(!Array.isArray(row)||row.length<2)return null;
    const price=Number(row[0]),quantity=Number(row[1]);
    if(!positive(price)||!nonNegative(quantity))return null;
    if(quantity>0)levels.push([price,quantity]);
  }
  levels.sort((a,b)=>descending?b[0]-a[0]:a[0]-b[0]);
  return levels;
}

export function discoverTabdealSpotUniverse(payload,{
  maxMarkets=TABDEAL_LIVE_WATCH_POLICY.maximumMarkets
}={}) {
  if(!Array.isArray(payload))fail("tabdeal_live_exchange_info_invalid");
  if(!Number.isSafeInteger(maxMarkets)||maxMarkets<1||maxMarkets>TABDEAL_LIVE_WATCH_POLICY.maximumMarkets){
    fail("tabdeal_live_market_cap_invalid");
  }
  const eligible=[];
  const excluded={inactive:0,nonSpot:0,unsupportedQuote:0,excludedAsset:0,invalid:0};
  const seen=new Set();
  for(const market of payload){
    if(!isRecord(market)||typeof market.symbol!=="string"||
       typeof market.baseAsset!=="string"||typeof market.quoteAsset!=="string"){
      excluded.invalid++;continue;
    }
    const symbol=market.symbol.trim().toUpperCase();
    const baseAsset=market.baseAsset.trim().toUpperCase();
    const quoteAsset=market.quoteAsset.trim().toUpperCase();
    if(market.status!=="TRADING"){excluded.inactive++;continue;}
    if(market.isSpotTradingAllowed!==true||
       !Array.isArray(market.permissions)||!market.permissions.includes("SPOT")){
      excluded.nonSpot++;continue;
    }
    if(!TABDEAL_LIVE_WATCH_POLICY.allowedQuoteAssets.includes(quoteAsset)){
      excluded.unsupportedQuote++;continue;
    }
    if(TABDEAL_LIVE_WATCH_POLICY.excludedAssets.includes(baseAsset)||
       TABDEAL_LIVE_WATCH_POLICY.excludedAssets.includes(quoteAsset)){
      excluded.excludedAsset++;continue;
    }
    if(seen.has(symbol)){excluded.invalid++;continue;}
    const filters=Array.isArray(market.filters)?market.filters:[];
    const filter=type=>filters.find(row=>isRecord(row)&&row.filterType===type)||null;
    const lot=filter("LOT_SIZE");
    const notional=filter("MIN_NOTIONAL")||filter("NOTIONAL");
    const price=filter("PRICE_FILTER");
    const metadata={
      symbol,baseAsset,quoteAsset,
      status:market.status,
      isSpotTradingAllowed:market.isSpotTradingAllowed,
      minQty:lot?.minQty??null,
      maxQty:lot?.maxQty??null,
      stepSize:lot?.stepSize??null,
      minNotional:notional?.minNotional??null,
      tickSize:price?.tickSize??null,
      marketRulesReady:Boolean(positive(lot?.minQty)&&positive(lot?.stepSize)&&
        positive(notional?.minNotional)&&positive(price?.tickSize))
    };
    eligible.push(metadata);
    seen.add(symbol);
  }
  eligible.sort((a,b)=>
    (a.quoteAsset==="USDT"?0:1)-(b.quoteAsset==="USDT"?0:1)||
    a.baseAsset.localeCompare(b.baseAsset)||a.symbol.localeCompare(b.symbol)
  );
  const selected=eligible.slice(0,maxMarkets);
  return {
    markets:selected,
    universe:{
      totalExchangeInfoMarkets:payload.length,
      activeSupportedSpotMarkets:eligible.length,
      selectedMarketCount:selected.length,
      omittedBySafetyCap:Math.max(0,eligible.length-selected.length),
      quoteAssets:[...new Set(selected.map(row=>row.quoteAsset))].sort(),
      assets:[...new Set(selected.map(row=>row.baseAsset).concat(selected.map(row=>row.quoteAsset)))].sort(),
      marketRulesReadyCount:selected.filter(row=>row.marketRulesReady).length,
      excluded
    }
  };
}

export function buildTabdealSubscriptionBatches(symbols,{
  batchSize=TABDEAL_LIVE_WATCH_POLICY.subscriptionBatchSize,
  firstId=1
}={}) {
  if(!Array.isArray(symbols)||symbols.length<1||symbols.length>TABDEAL_LIVE_WATCH_POLICY.maximumMarkets||
     !Number.isSafeInteger(batchSize)||batchSize<1||batchSize>100||
     !Number.isSafeInteger(firstId)||firstId<1){
    fail("tabdeal_live_subscription_batch_input_invalid");
  }
  const normalized=symbols.map(value=>String(value).trim().toUpperCase());
  if(normalized.some(value=>! /^[A-Z0-9]{3,30}$/.test(value))||
     new Set(normalized).size!==normalized.length){
    fail("tabdeal_live_subscription_symbols_invalid");
  }
  const batches=[];
  for(let offset=0;offset<normalized.length;offset+=batchSize){
    const items=normalized.slice(offset,offset+batchSize);
    const id=firstId+batches.length;
    batches.push({
      id,symbols:items,
      message:{method:"SUBSCRIBE",id,params:items.map(symbol=>symbol.toLowerCase()+"@depth@2000ms")}
    });
  }
  return batches;
}

export function normalizeTabdealLiveDepthMessage(input,{
  expectedSymbol=null,receivedAtMs=Date.now(),quoteAsset=null
}={}) {
  if(!isRecord(input)||!Number.isSafeInteger(receivedAtMs))return null;
  const message=isRecord(input.data)?input.data:input;
  const stream=String(input.stream||"").toLowerCase();
  const symbol=String(expectedSymbol||message.s||stream.split("@")[0]||"").toUpperCase();
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||String(message.s||"").toUpperCase()!==symbol||
     message.e!=="depthUpdate")return null;
  const eventTimeMs=Number(message.E);
  if(!Number.isSafeInteger(eventTimeMs)||eventTimeMs<=0)return null;
  const bids=parseLevels(message.b,true),asks=parseLevels(message.a,false);
  if(!bids?.length||!asks?.length)return null;
  const bestBid=bids[0][0],bestAsk=asks[0][0];
  if(bestAsk<=bestBid)return null;
  const midPrice=(bestBid+bestAsk)/2;
  const spreadBps=(bestAsk-bestBid)/midPrice*10_000;
  const bidDepthTop5Quote=bids.slice(0,5).reduce((sum,[price,qty])=>sum+price*qty,0);
  const askDepthTop5Quote=asks.slice(0,5).reduce((sum,[price,qty])=>sum+price*qty,0);
  const totalDepth=bidDepthTop5Quote+askDepthTop5Quote;
  const imbalance=totalDepth>0?(bidDepthTop5Quote-askDepthTop5Quote)/totalDepth:0;
  if(![midPrice,spreadBps,bidDepthTop5Quote,askDepthTop5Quote,imbalance].every(Number.isFinite))return null;
  const eventLagMs=receivedAtMs-eventTimeMs;
  const sequenceFields=["U","u","lastUpdateId","firstUpdateId","finalUpdateId"]
    .filter(key=>Object.hasOwn(message,key));
  return {
    symbol,quoteAsset:String(quoteAsset||"").toUpperCase(),
    eventTimeMs,receivedAtMs,eventLagMs,
    bestBid,bestAsk,midPrice,spreadBps,
    bidDepthTop5Quote,askDepthTop5Quote,imbalance,
    bidLevelCount:bids.length,askLevelCount:asks.length,
    sequenceFields,
    bookSemantics:"snapshot_vs_delta_not_confirmed_by_exchange"
  };
}

export function createTabdealLiveWatchState(input=null,{nowMs=Date.now()}={}) {
  if(!Number.isSafeInteger(nowMs))fail("tabdeal_live_state_clock_invalid");
  const source=isRecord(input)&&input.schemaVersion===TABDEAL_LIVE_WATCH_POLICY.stateSchemaVersion?input:{};
  const barsBySymbol={};
  if(isRecord(source.barsBySymbol)){
    for(const [symbol,rawBars] of Object.entries(source.barsBySymbol)){
      if(!Array.isArray(rawBars))continue;
      const clean=rawBars.filter(row=>isRecord(row)&&Number.isSafeInteger(Number(row.time))&&
        Number(row.time)>=nowMs-2*60*60*1000&&Number(row.time)<=nowMs+60_000&&
        [row.open,row.high,row.low,row.close].every(positive)&&
        Number(row.high)>=Math.max(Number(row.open),Number(row.close),Number(row.low))&&
        Number(row.low)<=Math.min(Number(row.open),Number(row.close),Number(row.high)))
        .map(row=>({time:Number(row.time),open:Number(row.open),high:Number(row.high),
          low:Number(row.low),close:Number(row.close),updateCount:Number(row.updateCount)||0}))
        .sort((a,b)=>a.time-b.time)
        .slice(-TABDEAL_LIVE_WATCH_POLICY.retainedBars);
      if(clean.length)barsBySymbol[String(symbol).toUpperCase()]=clean;
    }
  }
  return {
    schemaVersion:TABDEAL_LIVE_WATCH_POLICY.stateSchemaVersion,
    updatedAt:new Date(nowMs).toISOString(),
    barsBySymbol,
    latestBooks:{},
    historyRestoredSymbols:Object.keys(barsBySymbol).length
  };
}

export function updateTabdealLiveMinuteBar(state,message) {
  if(!isRecord(state)||state.schemaVersion!==TABDEAL_LIVE_WATCH_POLICY.stateSchemaVersion||
     !isRecord(message)||!positive(message.midPrice)||!Number.isSafeInteger(message.eventTimeMs)){
    return {accepted:false,reason:"live_minute_bar_input_invalid"};
  }
  const symbol=String(message.symbol||"").toUpperCase();
  if(!/^[A-Z0-9]{3,30}$/.test(symbol))return {accepted:false,reason:"live_minute_bar_symbol_invalid"};
  const time=Math.floor(message.eventTimeMs/TABDEAL_LIVE_WATCH_POLICY.barIntervalMs)*
    TABDEAL_LIVE_WATCH_POLICY.barIntervalMs;
  if(!state.barsBySymbol[symbol])state.barsBySymbol[symbol]=[];
  const bars=state.barsBySymbol[symbol];
  const last=bars.at(-1);
  if(last&&time<last.time)return {accepted:false,reason:"live_minute_bar_out_of_order"};
  if(last&&time===last.time){
    last.high=Math.max(last.high,Number(message.midPrice));
    last.low=Math.min(last.low,Number(message.midPrice));
    last.close=Number(message.midPrice);
    last.updateCount=(Number(last.updateCount)||0)+1;
  }else{
    bars.push({time,open:Number(message.midPrice),high:Number(message.midPrice),
      low:Number(message.midPrice),close:Number(message.midPrice),updateCount:1});
    while(bars.length>TABDEAL_LIVE_WATCH_POLICY.retainedBars)bars.shift();
  }
  state.latestBooks[symbol]={
    receivedAtMs:Number(message.receivedAtMs),
    eventTimeMs:Number(message.eventTimeMs),
    bestBid:Number(message.bestBid),bestAsk:Number(message.bestAsk),
    midPrice:Number(message.midPrice),spreadBps:Number(message.spreadBps),
    bidDepthTop5Quote:Number(message.bidDepthTop5Quote),
    askDepthTop5Quote:Number(message.askDepthTop5Quote),
    imbalance:Number(message.imbalance),
    bidLevelCount:Number(message.bidLevelCount),
    askLevelCount:Number(message.askLevelCount),
    eventLagMs:Number(message.eventLagMs),
    bookSemantics:message.bookSemantics
  };
  return {accepted:true,symbol,time};
}

function alignedPriceRows(symbol,market,marketBySymbol,barsBySymbol,btcUsdtBars) {
  const direct=barsBySymbol[symbol]||[];
  if(market.quoteAsset==="USDT"){
    return direct.map(row=>({time:row.time,price:row.close}));
  }
  if(market.quoteAsset==="BTC"){
    const btcByTime=new Map((btcUsdtBars||[]).map(row=>[row.time,row.close]));
    return direct.flatMap(row=>{
      const btc=btcByTime.get(row.time);
      return positive(btc)?[{time:row.time,price:row.close*btc}]:[];
    });
  }
  return [];
}

export function evaluateTabdealRelativeWatch({
  state,markets,nowMs=Date.now(),feeBpsPerOrder=TABDEAL_LIVE_WATCH_POLICY.provisionalFeeBpsPerOrder,
  slippageBpsPerOrder=TABDEAL_LIVE_WATCH_POLICY.provisionalSlippageBpsPerOrder
}={}) {
  if(!isRecord(state)||!Array.isArray(markets)||!Number.isSafeInteger(nowMs)||
     !nonNegative(feeBpsPerOrder)||!nonNegative(slippageBpsPerOrder)){
    fail("tabdeal_live_watch_evaluation_input_invalid");
  }
  const marketBySymbol=new Map(markets.map(row=>[String(row.symbol).toUpperCase(),row]));
  const btcMarket=marketBySymbol.get("BTCUSDT");
  const btcBars=state.barsBySymbol?.BTCUSDT||[];
  const assets=new Map();
  const currentBooks=state.latestBooks||{};
  for(const market of markets){
    const symbol=String(market.symbol).toUpperCase();
    const base=String(market.baseAsset).toUpperCase();
    if(base==="USDT")continue;
    const bars=state.barsBySymbol?.[symbol]||[];
    if(bars.length<TABDEAL_LIVE_WATCH_POLICY.minimumBarsForCandidate)continue;
    let selected=assets.get(base);
    // Prefer a directly USDT-quoted market; use BTC-quoted markets only where
    // no direct USDT pair exists and BTCUSDT has aligned minute candles.
    if(!selected||market.quoteAsset==="USDT"&&selected.quoteAsset!=="USDT"){
      const priceRows=alignedPriceRows(symbol,market,marketBySymbol,state.barsBySymbol,btcBars);
      if(priceRows.length<TABDEAL_LIVE_WATCH_POLICY.minimumBarsForCandidate){
        if(!selected)assets.set(base,{available:false,reason:"btc_usdt_alignment_missing",symbol,quoteAsset:market.quoteAsset});
        continue;
      }
      const book=currentBooks[symbol];
      assets.set(base,{
        available:true,asset:base,symbol,quoteAsset:market.quoteAsset,
        priceRows,book,
        latestPriceUsdt:priceRows.at(-1)?.price??null
      });
    }
  }
  const latestRows=[];
  for(const item of assets.values()){
    if(!item.available)continue;
    const last=item.priceRows.at(-1),at15=item.priceRows.at(-1-TABDEAL_LIVE_WATCH_POLICY.relativeLookbackMinutes),
      at5=item.priceRows.at(-1-TABDEAL_LIVE_WATCH_POLICY.reversalLookbackMinutes),at1=item.priceRows.at(-2);
    if(!last||!at15||!at5||!at1||last.time-at15.time!==
       TABDEAL_LIVE_WATCH_POLICY.relativeLookbackMinutes*TABDEAL_LIVE_WATCH_POLICY.barIntervalMs||
       last.time-at5.time!==TABDEAL_LIVE_WATCH_POLICY.reversalLookbackMinutes*TABDEAL_LIVE_WATCH_POLICY.barIntervalMs||
       last.time-at1.time!==TABDEAL_LIVE_WATCH_POLICY.barIntervalMs)continue;
    const latestBook=item.book;
    const bookAge=nowMs-Number(latestBook?.receivedAtMs);
    if(!latestBook||bookAge<0||bookAge>TABDEAL_LIVE_WATCH_POLICY.maximumBookAgeMs)continue;
    let depthMultiplier=item.quoteAsset==="BTC"?Number(btcMarket?currentBooks.BTCUSDT?.midPrice:NaN):1;
    if(item.quoteAsset==="BTC"&&!positive(depthMultiplier))continue;
    const spreadBps=Number(latestBook.spreadBps);
    const bidDepth=Number(latestBook.bidDepthTop5Quote)*depthMultiplier;
    const askDepth=Number(latestBook.askDepthTop5Quote)*depthMultiplier;
    const oneMinuteReturnBps=(last.price/at1.price-1)*10_000;
    const fiveMinuteReturnBps=(last.price/at5.price-1)*10_000;
    const fifteenMinuteReturnBps=(last.price/at15.price-1)*10_000;
    if(![spreadBps,bidDepth,askDepth,oneMinuteReturnBps,fiveMinuteReturnBps,fifteenMinuteReturnBps].every(Number.isFinite))continue;
    latestRows.push({
      asset:item.asset,symbol:item.symbol,quoteAsset:item.quoteAsset,
      latestPriceUsdt:last.price,bookAgeMs:bookAge,spreadBps,
      bidDepthTop5Usdt:bidDepth,askDepthTop5Usdt:askDepth,
      oneMinuteReturnBps,fiveMinuteReturnBps,fifteenMinuteReturnBps
    });
  }
  if(latestRows.length<5){
    return {status:"warming_up",availableAssets:latestRows.length,
      requiredAssets:5,assets:latestRows.slice(0,10),candidate:null,
      tradeAuthorized:false,reason:"insufficient_fresh_aligned_minute_history"};
  }
  const crossMedian=median(latestRows.map(row=>row.fifteenMinuteReturnBps));
  const crossMad=mad(latestRows.map(row=>row.fifteenMinuteReturnBps),crossMedian);
  const robustScale=Math.max(1,1.4826*(crossMad||0));
  for(const row of latestRows){
    row.relativeUnderperformanceBps=row.fifteenMinuteReturnBps-crossMedian;
    row.relativeZScore=row.relativeUnderperformanceBps/robustScale;
  }
  const strongest=[...latestRows].sort((a,b)=>b.fifteenMinuteReturnBps-a.fifteenMinuteReturnBps)[0];
  const candidates=latestRows.filter(row=>
    row.asset!==strongest.asset&&
    row.relativeUnderperformanceBps<=-TABDEAL_LIVE_WATCH_POLICY.minimumRelativeUnderperformanceBps&&
    row.relativeZScore<=-TABDEAL_LIVE_WATCH_POLICY.minimumRelativeZScore&&
    row.oneMinuteReturnBps>0&&row.fiveMinuteReturnBps>0&&
    row.spreadBps<=TABDEAL_LIVE_WATCH_POLICY.maximumSpreadBps&&
    row.bidDepthTop5Usdt>=TABDEAL_LIVE_WATCH_POLICY.minimumTopFiveDepthUsdt&&
    row.askDepthTop5Usdt>=TABDEAL_LIVE_WATCH_POLICY.minimumTopFiveDepthUsdt
  ).sort((a,b)=>a.relativeUnderperformanceBps-b.relativeUnderperformanceBps);
  const target=candidates[0]||null;
  if(!target){
    return {status:"no_provisional_relative_value_candidate",availableAssets:latestRows.length,
      crossSectionMedianReturnBps:crossMedian,assets:latestRows.sort((a,b)=>a.relativeUnderperformanceBps-b.relativeUnderperformanceBps).slice(0,10),
      strongestIllustrativeSource:strongest.asset,candidate:null,
      feeAssumptionBpsPerOrder:Number(feeBpsPerOrder),
      slippageAssumptionBpsPerOrder:Number(slippageBpsPerOrder),
      tradeAuthorized:false,reason:"no_laggard_with_reversal_and_liquidity_confirmation"};
  }
  const sourceBook=currentBooks[strongest.symbol];
  const costBps=2*(Number(feeBpsPerOrder)+Number(slippageBpsPerOrder))+
    Number(strongest.spreadBps)/2+Number(target.spreadBps)/2;
  return {
    status:"provisional_relative_value_watch_candidate",
    availableAssets:latestRows.length,
    crossSectionMedianReturnBps:crossMedian,
    strongestIllustrativeSource:strongest.asset,
    candidate:{
      sourceAsset:strongest.asset,sourceSymbol:strongest.symbol,
      targetAsset:target.asset,targetSymbol:target.symbol,
      relativeUnderperformanceBps:target.relativeUnderperformanceBps,
      relativeZScore:target.relativeZScore,
      oneMinuteReturnBps:target.oneMinuteReturnBps,
      fiveMinuteReturnBps:target.fiveMinuteReturnBps,
      fifteenMinuteReturnBps:target.fifteenMinuteReturnBps,
      estimatedSwitchFrictionBps:costBps,
      grossRelativeGapToMedianBps:Math.abs(target.relativeUnderperformanceBps),
      grossGapToFrictionMultiple:Math.abs(target.relativeUnderperformanceBps)/Math.max(costBps,1),
      spreadBps:{source:strongest.spreadBps,target:target.spreadBps},
      topFiveDepthUsdt:{
        sourceBid:strongest.bidDepthTop5Usdt,sourceAsk:strongest.askDepthTop5Usdt,
        targetBid:target.bidDepthTop5Usdt,targetAsk:target.askDepthTop5Usdt
      }
    },
    feeAssumptionBpsPerOrder:Number(feeBpsPerOrder),
    slippageAssumptionBpsPerOrder:Number(slippageBpsPerOrder),
    strongestAndTarget: [strongest,...candidates.slice(0,5)],
    tradeAuthorized:false,
    statusLimitations:[
      "This is a watch candidate, not an expected-profit forecast.",
      "The Spot depth stream snapshot/delta semantics have not been independently confirmed by Tabdeal.",
      "Fees and slippage are provisional assumptions, not account-specific verified costs.",
      "A live switch requires a separate two-leg execution preflight and order reconciliation."
    ]
  };
}

export function summarizeTabdealLiveWatch({
  universe,stats,state,nowMs=Date.now(),durationMs=0,mode="probe"
}={}) {
  if(!isRecord(universe)||!isRecord(stats)||!isRecord(state)||!Number.isSafeInteger(nowMs)) {
    fail("tabdeal_live_watch_summary_input_invalid");
  }
  const symbolStats=universe.markets.map(market=>{
    const row=stats.bySymbol?.[market.symbol]||{};
    const book=state.latestBooks?.[market.symbol]||null;
    return {
      symbol:market.symbol,baseAsset:market.baseAsset,quoteAsset:market.quoteAsset,
      updateCount:Number(row.updateCount)||0,
      lastEventAt:row.lastEventAtMs?new Date(row.lastEventAtMs).toISOString():null,
      meanEventLagMs:Number(row.eventLagMsCount)?Number(row.eventLagMsSum)/Number(row.eventLagMsCount):null,
      latestSpreadBps:book?.spreadBps??null,
      latestBidDepthTop5Quote:book?.bidDepthTop5Quote??null,
      latestAskDepthTop5Quote:book?.askDepthTop5Quote??null,
      sequenceFieldsObserved:[...new Set(row.sequenceFields||[])].sort()
    };
  });
  const active=symbolStats.filter(row=>row.updateCount>0);
  return {
    schemaVersion:1,reportType:"TABDEAL_CONTINUOUS_SPOT_MARKET_WATCH",
    mode,generatedAt:new Date(nowMs).toISOString(),durationMs,
    source:{websocketUrl:TABDEAL_LIVE_WATCH_POLICY.websocketUrl,
      topic:"symbol@depth@2000ms",updateCadenceMs:2000,
      quoteAssets:TABDEAL_LIVE_WATCH_POLICY.allowedQuoteAssets,
      bookSemantics:"unverified_snapshot_or_delta"},
    universe:universe.universe,
    connectionStats:{
      connectionsOpened:Number(stats.connectionsOpened)||0,
      reconnects:Number(stats.reconnects)||0,
      subscriptionAcks:Number(stats.subscriptionAcks)||0,
      subscriptionRejections:Number(stats.subscriptionRejections)||0,
      receivedMessages:Number(stats.receivedMessages)||0,
      invalidMessages:Number(stats.invalidMessages)||0,
      ignoredMessages:Number(stats.ignoredMessages)||0,
      distinctSymbolsWithUpdates:active.length,
      symbolsWithoutUpdates:symbolStats.filter(row=>row.updateCount===0).map(row=>row.symbol),
      averageEventLagMs:Number(stats.eventLagCount)?Number(stats.eventLagSum)/Number(stats.eventLagCount):null,
      maxAbsoluteEventLagMs:Number(stats.maxAbsoluteEventLagMs)||0
    },
    symbolStats,
    history:{
      retainedBarsPerSymbol:TABDEAL_LIVE_WATCH_POLICY.retainedBars,
      symbolsWithMinuteHistory:Object.keys(state.barsBySymbol||{}).length,
      restoredSymbols:Number(state.historyRestoredSymbols)||0
    },
    safety:{publicWebsocketOnly:true,privateCredentialsUsed:false,accountDataRead:false,
      privateEndpointsUsed:false,exchangeOrdersPlaced:0,fundsMoved:false,
      liveTradingEnabled:false,leverageUsed:false,shortSellingUsed:false}
  };
}

export const tabdealLiveWatchInternals=Object.freeze({
  median,mad,parseLevels
});
