#!/usr/bin/env node
import {createHmac} from "node:crypto";
import {appendFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";

const API_BASE = "https://api1.tabdeal.org";
const QUOTE_ASSET = "USDT";
const QUOTE_BUDGET = "1.00000000";
const MAX_SPREAD_BPS = 30;
const MAX_EXECUTION_SLIPPAGE_BPS = 5;
const RECV_WINDOW_MS = 5_000;
const CANDIDATE_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "PAXGUSDT",
  "BNBUSDT", "ADAUSDT", "TRXUSDT", "LINKUSDT", "LTCUSDT", "BCHUSDT",
  "DOTUSDT", "AVAXUSDT", "XLMUSDT", "SHIBUSDT", "TONUSDT", "APTUSDT",
  "NEARUSDT", "UNIUSDT", "FILUSDT", "ETCUSDT", "ATOMUSDT", "PEPEUSDT",
  "SUIUSDT", "ARBUSDT", "OPUSDT", "AAVEUSDT", "MKRUSDT", "INJUSDT"
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function precisionOf(value) {
  const text = String(value ?? "");
  const point = text.indexOf(".");
  return point < 0 ? 0 : text.length - point - 1;
}
function decimalUnits(value, precision) {
  const [whole, fraction = ""] = String(value).split(".");
  if (fraction.length > precision && /[1-9]/.test(fraction.slice(precision))) {
    throw new Error("decimal_precision_exceeds_filter");
  }
  return BigInt(whole) * (10n ** BigInt(precision)) +
    BigInt((fraction.slice(0, precision) + "0".repeat(precision)).slice(0, precision) || "0");
}
function unitsDecimal(value, precision) {
  const base = 10n ** BigInt(precision);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(precision, "0");
  return precision ? whole.toString() + "." + fraction : whole.toString();
}
function filterOf(info, type) {
  return Array.isArray(info?.filters)
    ? info.filters.find(row => isRecord(row) && row.filterType === type) ?? null
    : null;
}
function parseLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels.map(row => {
    if (!Array.isArray(row) || row.length < 2) return null;
    const price = positive(row[0]), quantity = positive(row[1]);
    return price && quantity ? {price, quantity} : null;
  }).filter(Boolean);
}
function signedParams(params, secret) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.append(key, String(value));
  }
  const unsigned = query.toString();
  query.append("signature", createHmac("sha256", secret).update(unsigned, "utf8").digest("hex"));
  return query;
}
async function jsonResponse(response) {
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error("response_too_large");
  try { return JSON.parse(body); } catch { throw new Error("response_not_json"); }
}
async function publicGet(path) {
  const response = await fetch(API_BASE + "/r/api/v1" + path, {
    method: "GET", headers: {accept: "application/json"},
    redirect: "error", signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("public_http_" + response.status);
  return jsonResponse(response);
}
async function privateGet(path, params, apiKey, apiSecret) {
  const query = signedParams({...params, timestamp: Date.now(), recvWindow: RECV_WINDOW_MS}, apiSecret);
  const response = await fetch(API_BASE + "/r/api/v1" + path + "?" + query.toString(), {
    method: "GET",
    headers: {accept: "application/json", "X-MBX-APIKEY": apiKey},
    redirect: "error", signal: AbortSignal.timeout(10_000)
  });
  const data = await jsonResponse(response);
  if (!response.ok) throw new Error("private_http_" + response.status);
  return data;
}
function normalizedSymbolList(payload) {
  if (!Array.isArray(payload)) throw new Error("exchange_info_schema_invalid");
  return payload.filter(info =>
    isRecord(info) &&
    info.quoteAsset === QUOTE_ASSET &&
    info.status === "TRADING" &&
    info.isSpotTradingAllowed === true &&
    Array.isArray(info.permissions) &&
    info.permissions.includes("SPOT") &&
    typeof info.symbol === "string" &&
    CANDIDATE_SYMBOLS.includes(info.symbol) &&
    Array.isArray(info.orderTypes) &&
    info.orderTypes.includes("LIMIT")
  );
}
function sizeWithinOneUsdt(info, depth) {
  const asks = parseLevels(depth?.asks);
  const bids = parseLevels(depth?.bids);
  if (!asks.length || !bids.length) return {ok:false,reason:"book_empty"};
  const bestBid = bids[0].price, bestAsk = asks[0].price;
  if (bestAsk <= bestBid) return {ok:false,reason:"book_crossed"};
  const mid = (bestAsk + bestBid) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
  if (!Number.isFinite(spreadBps) || spreadBps > MAX_SPREAD_BPS) {
    return {ok:false,reason:"spread_above_30bps",spreadBps};
  }
  const lot = filterOf(info, "LOT_SIZE");
  const priceFilter = filterOf(info, "PRICE_FILTER");
  const minNotionalFilter = filterOf(info, "MIN_NOTIONAL");
  const minQty = positive(lot?.minQty);
  const maxQty = positive(lot?.maxQty);
  const step = positive(lot?.stepSize);
  const tick = positive(priceFilter?.tickSize);
  const minNotional = positive(minNotionalFilter?.minNotional);
  if (!minQty || !step || !tick || !minNotional) {
    return {ok:false,reason:"required_filter_missing"};
  }
  const p = Math.max(
    precisionOf(depth.asks[0][0]),
    precisionOf(priceFilter.tickSize),
    precisionOf(priceFilter.minPrice),
    precisionOf(priceFilter.maxPrice)
  );
  const q = Math.max(precisionOf(lot.stepSize), precisionOf(lot.minQty), precisionOf(lot.maxQty ?? lot.stepSize));
  if (p > 24 || q > 24) return {ok:false,reason:"precision_over_24"};
  const bestAskUnits = decimalUnits(depth.asks[0][0], p);
  const tickUnits = decimalUnits(priceFilter.tickSize, p);
  const maxPxUnits = bestAskUnits * BigInt(10_000 + MAX_EXECUTION_SLIPPAGE_BPS) / 10_000n;
  const limitPxUnits = maxPxUnits / tickUnits * tickUnits;
  const limitPrice = unitsDecimal(limitPxUnits, p);
  const limitPriceNumber = Number(limitPrice);
  const minPxUnits = priceFilter.minPrice ? decimalUnits(priceFilter.minPrice, p) : 0n;
  const maxPxUnits = priceFilter.maxPrice ? decimalUnits(priceFilter.maxPrice, p) : null;
  if (limitPxUnits < minPxUnits || (maxPxUnits !== null && limitPxUnits > maxPxUnits)) {
    return {ok:false,reason:"price_filter"};
  }
  const stepUnits = decimalUnits(lot.stepSize, q);
  const maxQtyUnits = decimalUnits(lot.maxQty ?? "999999999", q);
  const minQtyUnits = decimalUnits(lot.minQty, q);
  const quoteUnits = decimalUnits(QUOTE_BUDGET, 8);
  const scale = 10n ** BigInt(p + q);
  const rawQtyUnits = quoteUnits * scale / (10n ** 8n * limitPxUnits);
  const qtyUnits = rawQtyUnits / stepUnits * stepUnits;
  if (qtyUnits < minQtyUnits || qtyUnits > maxQtyUnits) {
    return {ok:false,reason:"lot_size"};
  }
  const qty = unitsDecimal(qtyUnits, q);
  const notionalNumerator = limitPxUnits * qtyUnits * (10n ** 8n);
  const notionalDenominator = scale;
  const notionalUnits = (notionalNumerator + notionalDenominator / 2n) / notionalDenominator;
  const exactAboveBudget = notionalNumerator > quoteUnits * scale;
  const minNotionalUnits = decimalUnits(minNotionalFilter.minNotional, 8);
  if (exactAboveBudget) return {ok:false,reason:"quote_budget_exceeded"};
  if (notionalUnits < minNotionalUnits) {
    return {
      ok:false,reason:"min_notional_after_step_rounding",
      bestBid,bestAsk,spreadBps,limitPrice,quantity:qty,
      roundedNotional:unitsDecimal(notionalUnits,8),
      minNotional:minNotionalFilter.minNotional,
      stepSize:lot.stepSize,tickSize:priceFilter.tickSize
    };
  }
  const askQtyWithinLimit = asks.filter(level=>level.price<=limitPriceNumber)
    .reduce((sum,level)=>sum+level.quantity,0);
  if (askQtyWithinLimit + 1e-18 < Number(qty)) {
    return {ok:false,reason:"visible_ask_depth",bestBid,bestAsk,spreadBps,limitPrice,quantity:qty};
  }
  const totalAskQuoteWithinLimit = asks.filter(level=>level.price<=limitPriceNumber)
    .reduce((sum,level)=>sum+level.price*level.quantity,0);
  return {
    ok:true,
    symbol:info.symbol,baseAsset:info.baseAsset,quoteAsset:info.quoteAsset,
    bestBid,bestAsk,spreadBps,limitPrice,quantity:qty,
    estimatedQuoteNotional:unitsDecimal(notionalUnits,8),
    minNotional:minNotionalFilter.minNotional,
    stepSize:lot.stepSize,tickSize:priceFilter.tickSize,
    askDepthQuoteWithinLimit:totalAskQuoteWithinLimit,
    baseAssetPrecision:info.baseAssetPrecision,
    quoteAssetPrecision:info.quoteAssetPrecision
  };
}
async function main() {
  const apiKey=process.env.TABDEAL_API_KEY, apiSecret=process.env.TABDEAL_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("tabdeal_credentials_missing");
  const [markets, account] = await Promise.all([
    publicGet("/exchangeInfo"),
    privateGet("/account",{},apiKey,apiSecret)
  ]);
  if (account?.accountType!=="SPOT" || account?.canTrade!==true) {
    throw new Error("spot_account_trade_permission_not_confirmed");
  }
  const freeUsdt=Array.isArray(account.balances)
    ? Number(account.balances.find(row=>row?.asset==="USDT")?.free ?? 0) : 0;
  if (!Number.isFinite(freeUsdt) || freeUsdt<1) {
    throw new Error("free_usdt_below_one");
  }
  const listed=normalizedSymbolList(markets);
  const rows=[];
  for (const info of listed) {
    try {
      const depth=await publicGet("/depth?symbol="+encodeURIComponent(info.symbol)+"&limit=20");
      const size=sizeWithinOneUsdt(info,depth);
      if (!size.ok) {
        rows.push({symbol:info.symbol,ok:false,reason:size.reason,
          ...(size.spreadBps!==undefined?{spreadBps:size.spreadBps}:{}),
          ...(size.roundedNotional?{roundedNotional:size.roundedNotional}:{}),
          ...(size.minNotional?{minNotional:size.minNotional}:{}),
          ...(size.stepSize?{stepSize:size.stepSize}:{}),
          ...(size.quantity?{quantity:size.quantity}:{})});
        continue;
      }
      const trades=await publicGet("/trades?symbol="+encodeURIComponent(info.symbol)+"&limit=100");
      let recentQuoteVolume=0, latestTradeAgeMs=null;
      if (Array.isArray(trades)) {
        const times=[];
        for (const trade of trades) {
          const price=positive(trade?.price), qty=positive(trade?.qty);
          if (price&&qty) recentQuoteVolume+=price*qty;
          if (Number.isFinite(Number(trade?.time))) times.push(Number(trade.time));
        }
        if (times.length) latestTradeAgeMs=Math.max(0,Date.now()-Math.max(...times));
      }
      const openOrders=await privateGet("/openOrders",{symbol:info.symbol},apiKey,apiSecret);
      if (!Array.isArray(openOrders) || openOrders.length!==0) {
        rows.push({...size,ok:false,reason:"existing_open_orders",openOrderCount:Array.isArray(openOrders)?openOrders.length:null});
        continue;
      }
      rows.push({...size,ok:true,recentQuoteVolume100Trades:recentQuoteVolume,latestTradeAgeMs,openOrderCount:0});
    } catch (error) {
      rows.push({symbol:info.symbol,ok:false,reason:String(error?.message||error).slice(0,100)});
    }
  }
  const candidates=rows.filter(row=>row.ok).sort((a,b)=>
    (b.recentQuoteVolume100Trades??0)-(a.recentQuoteVolume100Trades??0) ||
    (a.spreadBps??Infinity)-(b.spreadBps??Infinity) ||
    (b.askDepthQuoteWithinLimit??0)-(a.askDepthQuoteWithinLimit??0)
  );
  const report={
    checkedAt:new Date().toISOString(),
    quoteBudget:QUOTE_BUDGET,
    accountFreeUsdt:freeUsdt,
    spotTradingEnabled:true,
    listedUsdtSpotCandidates:listed.map(row=>row.symbol),
    compatibleCandidateCount:candidates.length,
    recommendedCandidate:candidates[0]??null,
    candidates,
    rejected:rows.filter(row=>!row.ok),
    safety:{publicMarketReadsOnly:true,privateAccountAndOpenOrderReadsOnly:true,
      orderSubmissionAttempted:false,orderCancellationAttempted:false,fundsMoved:false}
  };
  console.log("TABDEAL_ONE_USDT_MARKET_SCOUT");
  console.log(JSON.stringify(report,null,2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "## Tabdeal one-USDT-compatible Spot market scan\n\n"+
      "- Quote budget: 1.00000000 USDT\n"+
      "- Compatible candidates: "+candidates.length+"\n"+
      "- Recommended: "+(candidates[0]?.symbol??"none") +"\n"+
      (candidates[0]?"- Estimated order notional: "+candidates[0].estimatedQuoteNotional+" USDT\n"+
        "- Quantity: "+candidates[0].quantity+" "+candidates[0].baseAsset+"\n"+
        "- Limit price: "+candidates[0].limitPrice+" USDT\n"+
        "- Spread: "+candidates[0].spreadBps.toFixed(2)+" bps\n":"")+
      "- Orders/cancellations/funds moved: none\n"
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{
    console.error("TABDEAL_ONE_USDT_MARKET_SCOUT_FAILED: "+String(error?.message||error).slice(0,160));
    process.exitCode=1;
  });
}
