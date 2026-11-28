import test from "node:test";
import assert from "node:assert/strict";
import {runTabdealPaperBot} from "../workers/tabdeal-mvp-shadow/index.js";
import {TABDEAL_PAPER_BOT_POLICY} from "../src/tabdeal-paper-bot.js";

const nowMs = Date.parse("2026-11-28T05:00:00.000Z");

function response(payload) {
  return {ok:true,status:200,async json(){return payload;}};
}

function paperDbMock(signalRow) {
  let stateJson = null;
  let leaseToken = null;
  let leaseUntilMs = 0;
  const events = [];
  const prepared = (sql, values) => ({
    bind(...args) { values.args=args; return this; },
    async run() {
      const args=values.args||[];
      if (sql.includes("INSERT OR IGNORE INTO tabdeal_paper_bot_state")) {
        if (stateJson===null) stateJson=args[1];
        return {meta:{changes:1}};
      }
      if (sql.includes("UPDATE tabdeal_paper_bot_state SET lease_token=")) {
        if (leaseUntilMs < Number(args[4])) {
          leaseToken=args[0];
          leaseUntilMs=Number(args[1]);
          return {meta:{changes:1}};
        }
        return {meta:{changes:0}};
      }
      throw new Error("paper_db_unexpected_run");
    },
    async first() {
      const args=values.args||[];
      if (sql.includes("SELECT state_json FROM tabdeal_paper_bot_state")) {
        return leaseToken===args[1] ? {state_json:stateJson} : null;
      }
      if (sql.includes("FROM tabdeal_local_paper_signals s")) {
        return args[0]==="BTCUSDT" ? signalRow : null;
      }
      throw new Error("paper_db_unexpected_first");
    },
    async all() { return {results:[]}; },
    sql,values
  });
  const DB = {
    prepare(sql) { return prepared(sql,{}); },
    async batch(statements) {
      for (const statement of statements) {
        const sql=statement.sql;
        const args=statement.values?.args || [];
        if (sql.includes("INSERT OR IGNORE INTO tabdeal_paper_bot_events")) {
          if (!events.some(row=>row.event_id===args[0])) {
            events.push({
              event_id:args[0],side:args[3],symbol:args[2],
              event_at_ms:args[4],metadata_json:args[12]
            });
          }
        } else if (sql.includes("UPDATE tabdeal_paper_bot_state SET state_json=")) {
          stateJson=args[0];
          leaseToken=null;
          leaseUntilMs=0;
        } else {
          throw new Error("paper_db_unexpected_batch_statement");
        }
      }
      return [];
    }
  };
  return {
    DB,
    inspect() {
      return {state:stateJson?JSON.parse(stateJson):null,events:[...events],leaseToken};
    }
  };
}

function signalRow() {
  const candleOpenMs=nowMs-60_000;
  return {
    symbol:"BTCUSDT",signal:"BUY_CANDIDATE",reason:"registered_ema_mtf_momentum_conditions_met",
    candle_open_ms:candleOpenMs,
    open_price:"60000",high_price:"60100",low_price:"59900",close_price:"60050",is_closed:1,
    indicators_json:JSON.stringify({
      latestClose:60050,atr14:100,ema9:60100,ema21:60080,ema50:60020,
      ema5m12:60090,ema5m26:60050,rsi14:58,macdHistogram:20,return60mPct:0.2
    }),
    quality_json:JSON.stringify({
      status:"usable",materialGapCount:0,expectedBars:240,actualBars:240,
      continuityEpoch:0,tradeCount60m:60,tradeCount15m:15
    })
  };
}

function exchangeInfo() {
  return [{
    symbol:"BTCUSDT",status:"TRADING",baseAsset:"BTC",quoteAsset:"USDT",
    isSpotTradingAllowed:true,permissions:["SPOT"],
    filters:[
      {filterType:"LOT_SIZE",minQty:"0.00001",maxQty:"100",stepSize:"0.00001"},
      {filterType:"MIN_NOTIONAL",minNotional:"5"},
      {filterType:"PRICE_FILTER",tickSize:"0.01"}
    ],
    baseAssetPrecision:8,quoteAssetPrecision:8
  }];
}

function depth() {
  return {
    bids:[["59990","0.03"],["59980","0.03"]],
    asks:[["60010","0.03"],["60020","0.03"]]
  };
}

test("Worker scheduled paper portfolio opens one virtual position and persists an idempotent ledger",async()=>{
  const db=paperDbMock(signalRow());
  const env={DB:db.DB};
  const requests=[];
  const fetchImpl=async(url)=>{
    const value=String(url);
    requests.push(value);
    if(value.endsWith("/exchangeInfo")) return response(exchangeInfo());
    if(value.includes("/depth?symbol=BTCUSDT")) return response(depth());
    throw new Error("unexpected_public_request");
  };
  const result=await runTabdealPaperBot(env,{nowMs,fetchImpl});
  assert.equal(result.status,"evaluated");
  assert.equal(result.action,"BUY");
  assert.equal(result.openPosition,"BTCUSDT");
  assert.equal(result.events,1);
  assert.equal(result.liveTradingEnabled,false);
  assert.equal(result.exchangeOrdersCreated,0);
  assert.equal(result.fundsMoved,false);
  assert.equal(requests.length,2);
  const stored=db.inspect();
  assert.equal(stored.state.position.symbol,"BTCUSDT");
  assert.equal(stored.events.length,1);
  assert.equal(stored.events[0].side,"BUY");
  assert.equal(stored.leaseToken,null);
  assert.equal(stored.state.portfolioId,TABDEAL_PAPER_BOT_POLICY.portfolioId);
});

test("Worker paper portfolio skips a concurrent scheduled tick while lease is held",async()=>{
  const db=paperDbMock(signalRow());
  const env={DB:db.DB};
  const first=await runTabdealPaperBot(env,{nowMs,fetchImpl:async url=>{
    const value=String(url);
    if(value.endsWith("/exchangeInfo")) return response(exchangeInfo());
    if(value.includes("/depth?symbol=BTCUSDT")) return response(depth());
    throw new Error("unexpected_public_request");
  }});
  assert.equal(first.action,"BUY");
  const second=await runTabdealPaperBot(env,{nowMs:nowMs+1,fetchImpl:async()=>{
    throw new Error("fetch_should_not_be_needed_for_lock_test");
  }});
  assert.equal(second.status,"evaluated");
  assert.notEqual(second.action,"BUY");
  assert.equal(db.inspect().events.length,1);
});
