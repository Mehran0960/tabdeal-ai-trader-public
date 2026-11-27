import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTabdealMvpShadow, buildShadowHealth, runTabdealLocalPaperCapture,
  updateTabdealLocalPaperMarkouts
} from "../workers/tabdeal-mvp-shadow/index.js";

const interval = 4 * 60 * 60 * 1000;
const nowMs = Date.parse("2026-11-27T08:00:00.000Z");

function krakenCandles(count = 100, trend = "up") {
  const rows = [];
  const latestClosedOpen = Math.floor(nowMs / interval) * interval - interval;
  for (let i = 0; i < count; i++) {
    const price = trend === "up" ? 60_000 + i * 25
      : trend === "down" ? 65_000 - i * 20 : 62_000;
    const open = latestClosedOpen - (count - 1 - i) * interval;
    rows.push([
      Math.floor(open / 1000),
      String(price - 5), String(price + 10), String(price - 10),
      String(price), String(price), "10", 50
    ]);
  }
  return {error: [], result: {XXBTZUSD: rows, last: rows.at(-1)[0]}};
}
function markets() {
  return [{
    symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT",
    isSpotTradingAllowed: true, permissions: ["SPOT"],
    filters: [
      {filterType: "LOT_SIZE", minQty: "0.00001", stepSize: "0.00001"},
      {filterType: "MIN_NOTIONAL", minNotional: "5"},
      {filterType: "PRICE_FILTER", tickSize: "0.01"}
    ],
    baseAssetPrecision: 8, quoteAssetPrecision: 8
  }];
}
function depth(spread = 1) {
  const bid = 62_000;
  const ask = bid * (1 + spread / 10_000);
  return {
    bids: [[String(bid), "0.1"], [String(bid - 10), "0.1"]],
    asks: [[String(ask), "0.1"], [String(ask + 10), "0.1"]]
  };
}
function evaluate(krakenOhlc = krakenCandles(), exchangeInfo = markets(), book = depth()) {
  return evaluateTabdealMvpShadow({
    krakenOhlc, tabdealExchangeInfo: exchangeInfo, tabdealDepth: book, nowMs
  });
}

test("produces a trend watch but never an order when local sources pass", () => {
  const report = evaluate();
  assert.equal(report.data.status, "usable", JSON.stringify(report.data));
  assert.equal(report.localMarket.status, "usable_snapshot");
  assert.equal(report.trend.state, "UP_TREND_WATCH");
  assert.equal(report.decision, "WAIT");
  assert.equal(report.executionGate, "BLOCKED_NO_RESEARCH_QUALIFIED_STRATEGY");
  assert.equal(report.ordersCreated, 0);
  assert.equal(report.safety.exchangeOrdersPlaced, 0);
  assert.equal(report.liveTradingEnabled, false);
});

test("blocks when Kraken history contains a 4h gap", () => {
  const payload = krakenCandles();
  payload.result.XXBTZUSD[50][0] += interval / 1000;
  const report = evaluate(payload);
  assert.equal(report.data.status, "invalid_or_stale");
  assert.equal(report.executionGate, "BLOCKED_KRAKEN_DATA");
  assert.equal(report.decision, "WAIT");
});

test("blocks stale 4h history and never forward fills", () => {
  const payload = krakenCandles();
  for (const row of payload.result.XXBTZUSD) row[0] -= (5 * interval) / 1000;
  const report = evaluate(payload);
  assert.equal(report.data.status, "invalid_or_stale");
  assert.equal(report.executionGate, "BLOCKED_KRAKEN_DATA");
});

test("rejects Kraken API error payloads instead of substituting another source", () => {
  const report = evaluate({error: ["EGeneral:Temporary lockout"], result: {}});
  assert.equal(report.data.status, "invalid_or_stale");
  assert.equal(report.executionGate, "BLOCKED_KRAKEN_DATA");
  assert.equal(report.decision, "WAIT");
});

test("excludes Kraken's current uncommitted 4h candle", () => {
  const payload = krakenCandles();
  const currentOpen = Math.floor(nowMs / interval) * interval;
  payload.result.XXBTZUSD.push([
    Math.floor(currentOpen / 1000), "62000", "62100", "61900",
    "62050", "62030", "20", 10
  ]);
  const report = evaluate(payload);
  assert.equal(report.data.status, "usable");
  assert.equal(report.data.candleCount, 100);
  assert.equal(report.decision, "WAIT");
});

test("blocks if the local market is inactive or not Spot", () => {
  const invalid = markets();
  invalid[0].isSpotTradingAllowed = false;
  const report = evaluate(krakenCandles(), invalid);
  assert.equal(report.localMarket.status, "invalid_or_unavailable");
  assert.equal(report.executionGate, "BLOCKED_TABDEAL_LOCAL_BOOK");
});

test("blocks a wide spread or inadequate local depth", () => {
  const report = evaluate(krakenCandles(), markets(), depth(45));
  assert.equal(report.localMarket.status, "liquidity_gate_failed");
  assert.equal(report.executionGate, "BLOCKED_TABDEAL_LOCAL_BOOK");
});

test("requires minimum depth independently on both sides of the local book", () => {
  const shallowAsk = depth();
  shallowAsk.asks = shallowAsk.asks.map(([price]) => [price, "0.001"]);
  const report = evaluate(krakenCandles(), markets(), shallowAsk);
  assert.equal(report.localMarket.bidDepthPass, true);
  assert.equal(report.localMarket.askDepthPass, false);
  assert.equal(report.localMarket.depthPass, false);
  assert.equal(report.localMarket.status, "liquidity_gate_failed");
  assert.equal(report.executionGate, "BLOCKED_TABDEAL_LOCAL_BOOK");
  assert.equal(report.decision, "WAIT");
  assert.equal(report.ordersCreated, 0);
});

test("does not generate a buy signal even when the trend is up and market is usable", () => {
  const report = evaluate();
  assert.equal(report.trend.state, "UP_TREND_WATCH");
  assert.equal(report.decision, "WAIT");
  assert.equal(report.researchGate.approvedStrategyExists, false);
  assert.equal(report.safety.orderSubmissionAttempted, false);
});

test("uses Kraken USD only as trend context and never as a Tabdeal USDT execution quote", () => {
  const report = evaluate();
  assert.equal(report.signalSource.provider, "KRAKEN_SPOT");
  assert.equal(report.signalSource.symbol, "XBTUSD");
  assert.equal(report.signalSource.quoteAsset, "USD");
  assert.equal(report.signalSource.contextOnly, true);
  assert.equal(report.signalSource.executableTabdealQuote, false);
  assert.equal(report.localMarket.quoteUnit, "USDT");
  assert.equal(report.decision, "WAIT");
});


test("health endpoint marks a recent scan as fresh", () => {
  const capturedAt = "2026-11-27T08:00:00.000Z";
  const health = buildShadowHealth({capturedAt}, {
    nowMs: Date.parse("2026-11-27T08:10:00.000Z")
  });
  assert.equal(health.status, "fresh");
  assert.equal(health.fresh, true);
  assert.equal(health.ageMs, 10 * 60 * 1000);
  assert.equal(health.expectedCadenceMinutes, 15);
});

test("health endpoint warns when the last scan is stale", () => {
  const health = buildShadowHealth({capturedAt: "2026-11-27T08:00:00.000Z"}, {
    nowMs: Date.parse("2026-11-27T08:45:00.000Z")
  });
  assert.equal(health.status, "stale");
  assert.equal(health.fresh, false);
});

test("health endpoint fails closed on invalid scan timestamp", () => {
  const health = buildShadowHealth({capturedAt: "not-a-date"}, {
    nowMs: Date.parse("2026-11-27T08:10:00.000Z")
  });
  assert.equal(health.status, "invalid_report_time");
  assert.equal(health.fresh, false);
});


test("local forward-paper capture records WAIT without account access or exchange orders",async()=>{
  const start=Date.parse("2026-11-27T00:00:00.000Z");
  const rows=[];
  let prior=60_000;
  for(let i=0;i<240;i++){
    const close=prior+0.5;
    rows.push({
      minute_open_ms:start+i*60_000,
      open_price:String(prior),high_price:String(close+1),low_price:String(prior-1),
      close_price:String(close),quote_volume:"100",trade_count:1,
      continuity_epoch:0,coverage_status:"complete",is_closed:1
    });
    prior=close;
  }
  const nowMs=start+240*60_000+5_000;
  const state={
    last_successful_poll_at_ms:nowMs-5_000,
    last_trade_time_ms:nowMs-5_000,
    continuity_epoch:0,last_poll_status:"captured"
  };
  const writes=[];
  const db={
    prepare(sql){
      let params=[];
      const bound={
        bind(...values){params=values;return bound;},
        async first(){
          if(sql.includes("SELECT last_successful_poll_at_ms"))return state;
          if(sql.includes("SELECT candle_open_ms FROM tabdeal_local_paper_signals"))return null;
          if(sql.includes("SELECT COUNT(*) AS evaluation_count"))return {
            evaluation_count:1,buy_candidate_count:0,paper_entry_count:0,
            completed_60m_count:0,avg_60m_net_bps_fee10:null,
            avg_60m_net_bps_fee20:null,avg_60m_net_bps_fee40:null
          };
          throw new Error("unexpected_first_query");
        },
        async all(){
          if(sql.includes("SELECT minute_open_ms,open_price"))return {results:[...rows].reverse()};
          if(sql.includes("SELECT symbol,strategy_version,candle_open_ms,entry_price"))return {results:[]};
          throw new Error("unexpected_all_query");
        },
        async run(){
          writes.push({sql,params});
          return {meta:{changes:1}};
        }
      };
      return bound;
    },
    async batch(){throw new Error("unexpected_batch_for_wait_signal");}
  };
  const result=await runTabdealLocalPaperCapture({DB:db},{nowMs});
  assert.equal(result.status,"ready");
  assert.equal(result.signal,"WAIT");
  assert.equal(result.paper.eligibleEntryRecorded,false);
  assert.equal(result.liveTradingEnabled,false);
  assert.equal(result.exchangeOrdersCreated,0);
  const insert=writes.find(row=>row.sql.startsWith("INSERT OR IGNORE INTO tabdeal_local_paper_signals"));
  assert.ok(insert);
  assert.equal(insert.params[5],"WAIT");
  assert.equal(insert.params[7],0);
});



test("forward paper markouts anchor to actual entry time and skip no-trade exits",async()=>{
  const base=1_800_000_000_000;
  const writes=[];
  const db={
    prepare(sql){
      const statement={
        bind(...params){writes.push({sql,params});return statement;},
        async all() {
          return {
            results: [{
              symbol: "BTCUSDT",
              strategy_version: "ema9-21-50-rsi14-macd-5m-v1",
              candle_open_ms: base,
              entry_price: 100,
              entry_spread_bps: 10,
              entry_observed_at_ms: base + 90_000
            }]
          };
        }
      };
      return statement;
    },
    async batch(items){writes.push(...items);return [];}
  };
  const candles=[
    // This close is after signal-candle open + 5m, but before entry-observed + 5m.
    {minuteOpenMs:base+300_000,close:101,coverageStatus:"complete",tradeCount:1},
    // The first bar after the correct target has no actual trade and cannot be used.
    {minuteOpenMs:base+360_000,close:101,coverageStatus:"no_trade",tradeCount:0},
    // Use the first real-trade close within the allowed 3m execution-lag window.
    {minuteOpenMs:base+420_000,close:102,coverageStatus:"complete",tradeCount:2}
  ];
  const result=await updateTabdealLocalPaperMarkouts({DB:db},candles,base+500_000);
  assert.equal(result.resolvedMarkouts,1);
  const update=writes.find(row=>row.sql?.includes("markout_5m_candle_open_ms"));
  assert.ok(update);
  assert.equal(update.params[0],base+420_000);
  assert.equal(update.params[1],390_000);
  assert.equal(update.params[2],102);
});

test("forward paper markout stays unresolved when no real trade occurs within the allowed delay",async()=>{
  const base=1_800_000_000_000;
  const writes=[];
  const db={
    prepare(sql){
      const statement={
        bind(...params){writes.push({sql,params});return statement;},
        async all() {
          return {
            results: [{
              symbol: "BTCUSDT",
              strategy_version: "ema9-21-50-rsi14-macd-5m-v1",
              candle_open_ms: base,
              entry_price: 100,
              entry_spread_bps: 10,
              entry_observed_at_ms: base + 90_000
            }]
          };
        }
      };
      return statement;
    },
    async batch(items){writes.push(...items);return [];}
  };
  const result=await updateTabdealLocalPaperMarkouts({DB:db},[
    {minuteOpenMs:base+360_000,close:100,coverageStatus:"no_trade",tradeCount:0},
    {minuteOpenMs:base+420_000,close:100,coverageStatus:"no_trade",tradeCount:0},
    {minuteOpenMs:base+480_000,close:100,coverageStatus:"no_trade",tradeCount:0}
  ],base+600_000);
  assert.equal(result.resolvedMarkouts,0);
  assert.equal(writes.length,1);
});
