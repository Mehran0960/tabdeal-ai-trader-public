export const TABDEAL_LIVE_WATCH_POLICY = Object.freeze({
  apiBase: "https://api1.tabdeal.org/r/api/v1",
  websocketUrl: "wss://api1.tabdeal.org/stream/",
  allowedQuoteAssets: Object.freeze(["USDT", "BTC", "IRT"]),
  unverifiedQuoteAssets: Object.freeze(["IRT"]),
  excludedBaseAssets: Object.freeze(["IRT"]),
  maximumMarkets: 1200,
  subscriptionBatchSize: 25,
  maximumBookAgeMs: 8_000,
  maximumEventLagMs: 10_000,
  barIntervalMs: 60_000,
  retainedBars: 30,
  minimumBarsForCandidate: 16,
  maximumLatestBarAgeMs: 120_000,
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
  const allQuoteAssetCounts={};
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
    allQuoteAssetCounts[quoteAsset]=(allQuoteAssetCounts[quoteAsset]||0)+1;
    if(market.status!=="TRADING"){excluded.inactive++;continue;}
    if(market.isSpotTradingAllowed!==true||
       !Array.isArray(market.permissions)||!market.permissions.includes("SPOT")){
      excluded.nonSpot++;continue;
    }
    if(!TABDEAL_LIVE_WATCH_POLICY.allowedQuoteAssets.includes(quoteAsset)){
      excluded.unsupportedQuote++;continue;
    }
    if(TABDEAL_LIVE_WATCH_POLICY.excludedBaseAssets.includes(baseAsset)){
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
      quoteUnitVerified:!TABDEAL_LIVE_WATCH_POLICY.unverifiedQuoteAssets.includes(quoteAsset),
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
      unverifiedQuoteAssets:[...new Set(selected.map(row=>row.quoteAsset)
        .filter(asset=>TABDEAL_LIVE_WATCH_POLICY.unverifiedQuoteAssets.includes(asset)))].sort(),
      assets:[...new Set(selected.map(row=>row.baseAsset).concat(selected.map(row=>row.quoteAsset)))].sort(),
      marketRulesReadyCount:selected.filter(row=>row.marketRulesReady).length,
      quoteAssetCounts:allQuoteAssetCounts,
      excluded
    }
  };
}


export function resolveTabdealSocketAckWaiters(waiters,socket,reason="websocket_disconnected"){
  if(!(waiters instanceof Map)||!socket)return 0;
  let resolved=0;
  for(const [id,waiter] of [...waiters.entries()]){
    if(waiter?.ws!==socket||typeof waiter.resolve!=="function")continue;
    waiter.resolve({ok:false,error:{id,code:String(reason)}});
    resolved++;
  }
  return resolved;
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

function alignedPriceRows(symbol,market,barsBySymbol,btcUsdtBars) {
  const direct=barsBySymbol[symbol]||[];
  if(market.quoteAsset==="USDT"||market.quoteAsset==="IRT"){
    return {
      comparisonQuoteAsset:market.quoteAsset,
      priceRows:direct.map(row=>({time:row.time,price:row.close}))
    };
  }
  if(market.quoteAsset==="BTC"){
    const btcByTime=new Map((btcUsdtBars||[]).map(row=>[row.time,row.close]));
    return {
      comparisonQuoteAsset:"USDT",
      priceRows:direct.flatMap(row=>{
        const btc=btcByTime.get(row.time);
        return positive(btc)?[{time:row.time,price:row.close*btc}]:[];
      })
    };
  }
  return {comparisonQuoteAsset:null,priceRows:[]};
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
    if(base==="USDT"||TABDEAL_LIVE_WATCH_POLICY.excludedBaseAssets.includes(base))continue;
    const bars=state.barsBySymbol?.[symbol]||[];
    if(bars.length<TABDEAL_LIVE_WATCH_POLICY.minimumBarsForCandidate)continue;
    const aligned=alignedPriceRows(symbol,market,state.barsBySymbol,btcBars);
    const comparisonQuoteAsset=aligned.comparisonQuoteAsset;
    const priceRows=aligned.priceRows;
    if(!comparisonQuoteAsset||priceRows.length<TABDEAL_LIVE_WATCH_POLICY.minimumBarsForCandidate)continue;
    const key=comparisonQuoteAsset+":"+base;
    const selected=assets.get(key);
    // Compare each base asset only inside the same quote-unit group. Prefer
    // direct USDT over BTC-converted for a USDT-equivalent comparison.
    if(!selected||(comparisonQuoteAsset==="USDT"&&market.quoteAsset==="USDT"&&selected.quoteAsset==="BTC")){
      const book=currentBooks[symbol];
      assets.set(key,{
        available:true,asset:base,symbol,quoteAsset:market.quoteAsset,
        comparisonQuoteAsset,priceRows,book,
        marketRulesReady:market.marketRulesReady===true,
        quoteUnitVerified:market.quoteUnitVerified===true,
        minNotional:Number(market.minNotional),
        latestPrice:priceRows.at(-1)?.price??null
      });
    }
  }

  const latestRows=[];
  for(const item of assets.values()){
    const lastIndex=item.priceRows.length-1;
    const last=item.priceRows[lastIndex],at15=item.priceRows[lastIndex-TABDEAL_LIVE_WATCH_POLICY.relativeLookbackMinutes],
      at5=item.priceRows[lastIndex-TABDEAL_LIVE_WATCH_POLICY.reversalLookbackMinutes],at1=item.priceRows[lastIndex-1];
    if(!last||!at15||!at5||!at1||
       item.priceRows.slice(lastIndex-TABDEAL_LIVE_WATCH_POLICY.relativeLookbackMinutes,lastIndex+1)
         .some((row,index,rows)=>index>0&&row.time-rows[index-1].time!==TABDEAL_LIVE_WATCH_POLICY.barIntervalMs)||
       last.time-at15.time!==TABDEAL_LIVE_WATCH_POLICY.relativeLookbackMinutes*TABDEAL_LIVE_WATCH_POLICY.barIntervalMs||
       last.time-at5.time!==TABDEAL_LIVE_WATCH_POLICY.reversalLookbackMinutes*TABDEAL_LIVE_WATCH_POLICY.barIntervalMs||
       last.time-at1.time!==TABDEAL_LIVE_WATCH_POLICY.barIntervalMs)continue;
    const latestBook=item.book;
    const bookAge=nowMs-Number(latestBook?.receivedAtMs);
    const latestBarAge=nowMs-(Number(last.time)+TABDEAL_LIVE_WATCH_POLICY.barIntervalMs);
    if(!latestBook||bookAge<0||bookAge>TABDEAL_LIVE_WATCH_POLICY.maximumBookAgeMs||
       latestBarAge< -TABDEAL_LIVE_WATCH_POLICY.barIntervalMs||
       latestBarAge>TABDEAL_LIVE_WATCH_POLICY.maximumLatestBarAgeMs||
       item.marketRulesReady!==true||!positive(item.minNotional))continue;
    let quoteScale=1;
    if(item.quoteAsset==="BTC"){
      const btcBook=currentBooks.BTCUSDT;
      const btcBookAge=nowMs-Number(btcBook?.receivedAtMs);
      quoteScale=Number(btcBook?.midPrice);
      if(!btcMarket||!positive(quoteScale)||btcBookAge<0||
         btcBookAge>TABDEAL_LIVE_WATCH_POLICY.maximumBookAgeMs)continue;
    }
    const spreadBps=Number(latestBook.spreadBps);
    const bidDepth=Number(latestBook.bidDepthTop5Quote)*quoteScale;
    const askDepth=Number(latestBook.askDepthTop5Quote)*quoteScale;
    const minNotional=item.minNotional*quoteScale;
    const minimumDepth=item.comparisonQuoteAsset==="IRT"
      ?minNotional*10
      :TABDEAL_LIVE_WATCH_POLICY.minimumTopFiveDepthUsdt;
    const oneMinuteReturnBps=(last.price/at1.price-1)*10_000;
    const fiveMinuteReturnBps=(last.price/at5.price-1)*10_000;
    const fifteenMinuteReturnBps=(last.price/at15.price-1)*10_000;
    if(![spreadBps,bidDepth,askDepth,minNotional,minimumDepth,
      oneMinuteReturnBps,fiveMinuteReturnBps,fifteenMinuteReturnBps].every(Number.isFinite))continue;
    latestRows.push({
      asset:item.asset,symbol:item.symbol,quoteAsset:item.quoteAsset,
      comparisonQuoteAsset:item.comparisonQuoteAsset,
      quoteUnitVerified:item.quoteUnitVerified,
      latestPrice:last.price,bookAgeMs:bookAge,latestBarAgeMs:latestBarAge,
      marketRulesReady:item.marketRulesReady,spreadBps,
      bidDepthTop5Quote:bidDepth,askDepthTop5Quote:askDepth,
      minimumDepthTop5Quote:minimumDepth,
      oneMinuteReturnBps,fiveMinuteReturnBps,fifteenMinuteReturnBps
    });
  }

  const grouped=new Map();
  for(const row of latestRows){
    const group=row.comparisonQuoteAsset;
    if(!grouped.has(group))grouped.set(group,[]);
    grouped.get(group).push(row);
  }
  const groupResults=[];
  const candidates=[];
  const warmingGroups=[];
  for(const [quoteUnit,rows] of grouped){
    if(rows.length<5){
      warmingGroups.push({quoteUnit,availableAssets:rows.length,requiredAssets:5,
        status:"warming_up",reason:"insufficient_fresh_aligned_minute_history"});
      continue;
    }
    const crossMedian=median(rows.map(row=>row.fifteenMinuteReturnBps));
    const crossMad=mad(rows.map(row=>row.fifteenMinuteReturnBps),crossMedian);
    const robustScale=Math.max(1,1.4826*(crossMad||0));
    for(const row of rows){
      row.relativeUnderperformanceBps=row.fifteenMinuteReturnBps-crossMedian;
      row.relativeZScore=row.relativeUnderperformanceBps/robustScale;
    }
    const liquidRows=rows.filter(row=>
      row.spreadBps<=TABDEAL_LIVE_WATCH_POLICY.maximumSpreadBps&&
      row.bidDepthTop5Quote>=row.minimumDepthTop5Quote&&
      row.askDepthTop5Quote>=row.minimumDepthTop5Quote
    );
    if(liquidRows.length<2){
      groupResults.push({quoteUnit,availableAssets:rows.length,liquidAssets:liquidRows.length,
        crossSectionMedianReturnBps:crossMedian,candidate:null,
        status:"no_liquid_source_and_target_pair"});
      continue;
    }
    const strongest=[...liquidRows].sort((a,b)=>b.fifteenMinuteReturnBps-a.fifteenMinuteReturnBps)[0];
    const targets=liquidRows.filter(row=>
      row.asset!==strongest.asset&&
      row.relativeUnderperformanceBps<=-TABDEAL_LIVE_WATCH_POLICY.minimumRelativeUnderperformanceBps&&
      row.relativeZScore<=-TABDEAL_LIVE_WATCH_POLICY.minimumRelativeZScore&&
      row.oneMinuteReturnBps>0&&row.fiveMinuteReturnBps>0
    ).sort((a,b)=>a.relativeUnderperformanceBps-b.relativeUnderperformanceBps);
    const target=targets[0]||null;
    const groupSummary={
      quoteUnit,availableAssets:rows.length,liquidAssets:liquidRows.length,
      crossSectionMedianReturnBps:crossMedian,
      strongestIllustrativeSource:strongest.asset,
      status:target?"provisional_relative_value_watch_candidate":"no_provisional_relative_value_candidate",
      candidate:null
    };
    if(target){
      const costBps=2*(Number(feeBpsPerOrder)+Number(slippageBpsPerOrder))+
        Number(strongest.spreadBps)/2+Number(target.spreadBps)/2;
      const candidate={
        sourceAsset:strongest.asset,sourceSymbol:strongest.symbol,
        targetAsset:target.asset,targetSymbol:target.symbol,
        quoteUnit,quoteUnitVerified:strongest.quoteUnitVerified&&target.quoteUnitVerified,
        relativeUnderperformanceBps:target.relativeUnderperformanceBps,
        relativeZScore:target.relativeZScore,
        oneMinuteReturnBps:target.oneMinuteReturnBps,
        fiveMinuteReturnBps:target.fiveMinuteReturnBps,
        fifteenMinuteReturnBps:target.fifteenMinuteReturnBps,
        estimatedSwitchFrictionBps:costBps,
        recentReturnGapBps:Number(strongest.fifteenMinuteReturnBps)-Number(target.fifteenMinuteReturnBps),
        recentRelativeGapIsHistoricalOnly:true,
        spreadBps:{source:strongest.spreadBps,target:target.spreadBps},
        topFiveDepth:{
          quoteUnit,
          sourceBid:strongest.bidDepthTop5Quote,sourceAsk:strongest.askDepthTop5Quote,
          targetBid:target.bidDepthTop5Quote,targetAsk:target.askDepthTop5Quote,
          minimumPerSide:Math.max(strongest.minimumDepthTop5Quote,target.minimumDepthTop5Quote)
        }
      };
      groupSummary.candidate=candidate;
      candidates.push(candidate);
    }
    groupResults.push(groupSummary);
  }
  candidates.sort((a,b)=>a.relativeUnderperformanceBps-b.relativeUnderperformanceBps);
  const primary=candidates[0]||null;
  const anyWarm=groupResults.length>0;
  return {
    status:primary?"provisional_relative_value_watch_candidate":
      anyWarm?"no_provisional_relative_value_candidate":"warming_up",
    availableAssets:latestRows.length,
    requiredAssetsPerQuoteGroup:5,
    crossSectionMedianReturnBps:groupResults.length===1?groupResults[0].crossSectionMedianReturnBps:null,
    strongestIllustrativeSource:primary?.sourceAsset??null,
    candidate:primary,
    candidates,
    quoteGroups:groupResults.concat(warmingGroups),
    assets:latestRows.sort((a,b)=>
      a.comparisonQuoteAsset.localeCompare(b.comparisonQuoteAsset)||
      a.relativeUnderperformanceBps-b.relativeUnderperformanceBps
    ).slice(0,20),
    feeAssumptionBpsPerOrder:Number(feeBpsPerOrder),
    slippageAssumptionBpsPerOrder:Number(slippageBpsPerOrder),
    tradeAuthorized:false,
    statusLimitations:[
      "This is a watch candidate, not an expected-profit forecast.",
      "Relative performance is compared only within a common quote-asset group; IRT is never joined to USDT or BTC prices.",
      "IRT quote units and account settlement denomination are not verified; IRT candidates are observation-only.",
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
      subscriptionAcceptedSymbols:Number(stats.subscriptionAcceptedSymbols)||0,
      subscriptionRejectedSymbols:Number(stats.subscriptionRejectedSymbols)||0,
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
