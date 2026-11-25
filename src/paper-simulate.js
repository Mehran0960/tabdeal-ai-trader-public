import { buildMarketResearch } from "./research.js";
import { confirmCandidatesAcrossScans } from "./paper-candidate-policy.js";
import {
  classifyForwardPaperSignal,
  createPaperEntryPlan,
  createPaperExitPlan,
  calculatePaperPortfolioRisk
} from "./paper-engine.js";

const PAPER_MVP_SYMBOL = "BTCIRT";
const PAPER_MVP_RESOLUTION = "240";
const RESOLUTIONS = Object.freeze({ "240": 14_400 });
const MAX_RUN_AGE_MS = 10 * 60_000;
const MAX_BOOK_AGE_MS = 30_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 10_000;

// D1 batch() executes sequentially inside one SQL transaction. This assertion
// uses SQLite changes() from the immediately preceding statement; NULL violates
// paper_orders.portfolio_applied NOT NULL and rolls back the entire batch on a miss.
export const PAPER_LEDGER_CHANGE_ASSERT_SQL =
  "UPDATE paper_orders SET portfolio_applied = CASE WHEN changes() = 1 THEN 0 ELSE NULL END WHERE id = ?";

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const nonNegative = value => Number.isFinite(Number(value)) && Number(value) >= 0;

function fail(code){throw new Error(code);}
function tehranDayKey(epochMs){
  const parts=new Intl.DateTimeFormat("en-CA",{
    timeZone:"Asia/Tehran",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(new Date(epochMs));
  const obj=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return obj.year+"-"+obj.month+"-"+obj.day;
}

export function validatePaperRunPayload(input,claims,{nowMs=Date.now()}={}){
  if(!input||input.schemaVersion!==1||!Array.isArray(input.pairs)||
     input.pairs.length<1||input.pairs.length>8) fail("paper_run_payload_shape_invalid");
  const runId=String(input.githubRunId||""),attempt=Number(input.githubRunAttempt);
  const sha=String(input.commitSha||"").toLowerCase(),generatedMs=Date.parse(String(input.generatedAt||""));
  if(!/^\d{1,20}$/.test(runId)||runId!==String(claims.run_id||"")||
     !Number.isSafeInteger(attempt)||attempt<1||attempt!==Number(claims.run_attempt)||
     !/^[a-f0-9]{40}$/.test(sha)||String(claims.sha||"").toLowerCase()!==sha) fail("paper_run_github_identity_mismatch");
  if(!Number.isFinite(generatedMs)||Math.abs(nowMs-generatedMs)>MAX_RUN_AGE_MS) fail("paper_run_generated_at_stale_or_invalid");
  const seen=new Set();
  const pairs=input.pairs.map(raw=>{
    const symbol=String(raw?.symbol||"").toUpperCase(),resolution=String(raw?.resolution||"");
    const duration=RESOLUTIONS[resolution];
    const quoteAsset=symbol.endsWith("IRT")?"IRT":symbol.endsWith("USDT")?"USDT":"";
    const strategy=String(raw?.strategy||"");
    const paperType=String(raw?.paperType||(symbol==="BTCIRT"?"legacy_btcirt":"multi_asset"));
    if(!symbol||resolution!==PAPER_MVP_RESOLUTION||!duration||seen.has(symbol)||
       !["ema-trend","donchian-breakout"].includes(strategy)||
       !["legacy_btcirt","multi_asset","position_management"].includes(paperType)||
       (paperType==="legacy_btcirt"&&(symbol!==PAPER_MVP_SYMBOL||strategy!=="ema-trend"))){
      fail("paper_run_symbol_resolution_strategy_invalid");
    }
    seen.add(symbol);
    const source=String(raw.sourcePriceUnit||"").toUpperCase();
    const canonical=String(raw.canonicalPriceUnit||"").toUpperCase();
    const multiplier=Number(raw.multiplier);
    const expectedStatus=source==="TOMAN"?"udf_toman_likely":
      source==="RIAL"?"udf_rial_likely":source==="USDT"?"udf_usdt_likely":"";
    const mappingValid=quoteAsset==="IRT"
      ? canonical==="RIAL"&&((source==="TOMAN"&&multiplier===10)||(source==="RIAL"&&multiplier===1))
      : quoteAsset==="USDT"&&source==="USDT"&&canonical==="USDT"&&multiplier===1;
    if(!mappingValid||String(raw.unitAudit?.status||"")!==expectedStatus){
      fail("paper_run_pair_unit_mapping_invalid_"+symbol);
    }
    const audit=raw.unitAudit||{},auditObservedMs=Date.parse(String(audit.observedAt||""));
    const tradeRatio=Number(audit.tradeRatio),midRatio=Number(audit.midRatio);
    const ratioSpread=Number(audit.ratioSpreadPct),bookAge=Number(audit.bookAgeMs),candleAge=Number(audit.candleAgeSeconds);
    const floor=source==="TOMAN"?9:0.9,ceil=source==="TOMAN"?11:1.1;
    if(!Number.isFinite(auditObservedMs)||Math.abs(nowMs-auditObservedMs)>60_000||
       ![tradeRatio,midRatio].every(x=>Number.isFinite(x)&&x>=floor&&x<=ceil)||
       !Number.isFinite(ratioSpread)||ratioSpread<0||ratioSpread>1||
       !Number.isFinite(bookAge)||bookAge< -MAX_FUTURE_CLOCK_SKEW_MS||bookAge>MAX_BOOK_AGE_MS||
       !Number.isFinite(candleAge)||candleAge< -60||candleAge>60) fail("paper_run_same_pair_unit_audit_invalid_"+symbol);
    const book=raw.orderbook||{};
    const bestBid=Array.isArray(book.bids)&&book.bids.length?Number(book.bids[0]?.[0]):NaN;
    const bestAsk=Array.isArray(book.asks)&&book.asks.length?Number(book.asks[0]?.[0]):NaN;
    const bookLastUpdateMs=Number(raw.orderbookLastUpdateMs);
    if(!positive(bestBid)||!positive(bestAsk)||bestAsk<=bestBid||!Number.isFinite(bookLastUpdateMs)||
       Math.abs((nowMs-bookLastUpdateMs)-bookAge)>5000||!Array.isArray(book.bids)||!Array.isArray(book.asks)||
       book.bids.length>50||book.asks.length>50) fail("paper_run_orderbook_invalid_"+symbol);
    const candles=raw.candles;
    if(!Array.isArray(candles)||candles.length<200||candles.length>500) fail("paper_run_history_count_invalid_"+symbol);
    let previous=0;
    const closedCandles=candles.map(row=>{
      const time=Number(row?.time),open=Number(row?.open),high=Number(row?.high),low=Number(row?.low),
        close=Number(row?.close),volume=Number(row?.volume);
      if(!Number.isSafeInteger(time)||time<=previous||![open,high,low,close].every(positive)||!nonNegative(volume)||
         high<Math.max(open,close,low)||low>Math.min(open,close,high)||time+duration>Math.floor(nowMs/1000)){
        fail("paper_run_historical_candle_invalid_"+symbol);
      }
      previous=time;return {time,open,high,low,close,volume};
    });
    return {symbol,resolution,quoteAsset,strategy,paperType,sourcePriceUnit:source,canonicalPriceUnit:canonical,multiplier,
      unitAudit:{status:audit.status,tradeRatio,midRatio,ratioSpreadPct:ratioSpread,
        observedAt:new Date(auditObservedMs).toISOString(),bookAgeMs:bookAge,candleAgeSeconds:candleAge},
      orderbook:{bids:book.bids.map(x=>[Number(x[0]),Number(x[1])]),asks:book.asks.map(x=>[Number(x[0]),Number(x[1])])},
      orderbookLastUpdateMs:bookLastUpdateMs,candles:closedCandles};
  });
  return {githubRunId:runId,githubRunAttempt:attempt,commitSha:sha,generatedAt:input.generatedAt,pairs};
}
function convertCandles(pair){
  return pair.candles.map(row=>({
    time:row.time,open:row.open*pair.multiplier,high:row.high*pair.multiplier,
    low:row.low*pair.multiplier,close:row.close*pair.multiplier,volume:row.volume
  }));
}

function latestWatchCandidate(row){
  return {paperType:"legacy_btcirt",symbol:row.symbol,quoteAsset:row.quote_asset,
    resolution:row.resolution,strategy:row.strategy,
    severeStressActualReturnPct:Number(row.severe_stress_actual_return_pct),
    baseOutperformanceWindowRatePct:Number(row.base_outperformance_window_rate_pct),
    worstWindowDrawdownPct:Number(row.worst_window_drawdown_pct),
    minimumWindowCount:Number(row.minimum_window_count),minimumTradeCount:Number(row.minimum_trade_count)};
}
function multiAssetWatchCandidate(row){
  return {paperType:"multi_asset",symbol:row.symbol,quoteAsset:row.quote_asset,
    resolution:row.resolution,strategy:row.strategy,confirmedScans:2,
    baseActualReturnPct:Number(row.base_return_pct),moderateStressActualReturnPct:Number(row.moderate_stress_return_pct),
    severeStressActualReturnPct:Number(row.severe_stress_return_pct),
    baseOutperformanceWindowRatePct:Number(row.base_benchmark_outperformance_pct),
    moderateOutperformanceWindowRatePct:Number(row.moderate_benchmark_outperformance_pct),
    severeOutperformanceWindowRatePct:Number(row.severe_benchmark_outperformance_pct),
    worstWindowDrawdownPct:Number(row.worst_window_drawdown_pct),minimumWindowCount:Number(row.minimum_window_count),
    minimumTradeCount:Number(row.minimum_trade_count),benjaminiHochbergQValue:Number(row.q_value),
    multipleTestingHypothesisCount:Number(row.hypothesis_count)};
}
function managementCandidate(position){
  return {paperType:"position_management",manageExistingPosition:true,symbol:position.symbol,
    quoteAsset:position.quote_unit==="RIAL"?"IRT":"USDT",resolution:String(position.resolution),strategy:String(position.strategy)};
}

function buildFillStatements(db,orderId,plan,side,createdAt){
  const fees=Number(plan.feePaid||0);
  const fills=Array.isArray(plan.fills)?plan.fills:[];
  if(!fills.length)throw new Error("paper_order_fill_levels_missing");
  const total=Number(plan.quoteNotional);
  const stmts=[];
  for(const fill of fills){
    const share=total>0?Number(fill.quoteNotional)/total:0;
    stmts.push(db.prepare(
      "INSERT INTO paper_fills (paper_order_id,level_index,side,fill_price,quantity,quote_notional,fee_paid,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?)"
    ).bind(orderId,Number(fill.levelIndex),side,Number(fill.price),Number(fill.quantity),
      Number(fill.quoteNotional),fees*share,createdAt));
  }
  return stmts;
}

async function applyPaperEntry(db,{portfolio,plan,orderKey,candleTime,bookLastUpdateMs,runId,runAttempt,createdAt}){
  const prior=await db.prepare("SELECT id,portfolio_applied FROM paper_orders WHERE client_order_key=?")
    .bind(orderKey).first();
  if(prior?.id){
    if(Number(prior.portfolio_applied)===1)return {status:"duplicate_ignored",symbol:plan.symbol};
    throw new Error("paper_entry_previous_attempt_requires_manual_reconciliation");
  }
  const riskDetails=JSON.stringify({
    historicalCandidate:true,spreadBps:plan.spreadBps,depth25:plan.depth25,
    bookAgeMs:plan.bookAgeMs,riskPlan:plan.riskPlan,unit:"quote_asset_separated",
    liveTradingEnabled:false,exchangeOrdersPlaced:0
  });
  const insert=await db.prepare(
    "INSERT OR IGNORE INTO paper_orders (client_order_key,symbol,quote_unit,strategy,resolution,side,action,"+
    "candle_time,requested_quantity,filled_quantity,average_fill_price,quote_notional,fee_paid,spread_bps,"+
    "latency_buffer_bps,status,reason,risk_details_json,book_last_update_ms,created_at) "+
    "VALUES (?,?,?,?,?,'buy','entry',?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(orderKey,plan.symbol,plan.quoteUnit,plan.strategy,plan.resolution,candleTime,
    plan.requestedQuantity,plan.filledQuantity,plan.avgFillPrice,plan.quoteNotional,plan.feePaid,
    plan.spreadBps,Number(portfolio.latency_buffer_bps),plan.fillStatus,plan.reason,riskDetails,
    bookLastUpdateMs,createdAt).run();
  if(Number(insert.meta?.changes||0)!==1)return {status:"duplicate_ignored",symbol:plan.symbol};
  const order=await db.prepare("SELECT id FROM paper_orders WHERE client_order_key=?").bind(orderKey).first();
  const orderId=Number(order?.id);
  if(!Number.isSafeInteger(orderId)||orderId<=0)throw new Error("paper_entry_order_id_missing");
  const now=createdAt;
  await db.batch([
    // Debit first, then assert exactly one portfolio row changed. If cash,
    // portfolio state or identity no longer matches, NOT NULL aborts the batch.
    db.prepare(
      "UPDATE paper_portfolios SET cash_balance=cash_balance-?-?,fees_paid=fees_paid+?,updated_at=? "+
      "WHERE quote_unit=? AND virtual_only=1 AND paper_enabled=1 AND kill_switch=0 AND cash_balance>=?+?"
    ).bind(plan.quoteNotional,plan.feePaid,plan.feePaid,now,plan.quoteUnit,plan.quoteNotional,plan.feePaid),
    db.prepare(PAPER_LEDGER_CHANGE_ASSERT_SQL).bind(orderId),
    db.prepare(
      "INSERT INTO paper_positions (symbol,quote_unit,strategy,resolution,quantity,average_entry_price,"+
      "stop_price,take_profit_price,entry_notional,entry_fee,realized_pnl,last_mark_price,status,entry_order_id,"+
      "opened_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,'open',?,?,?) "+
      "ON CONFLICT(symbol) DO UPDATE SET quote_unit=excluded.quote_unit,strategy=excluded.strategy,"+
      "resolution=excluded.resolution,quantity=excluded.quantity,average_entry_price=excluded.average_entry_price,"+
      "stop_price=excluded.stop_price,take_profit_price=excluded.take_profit_price,entry_notional=excluded.entry_notional,"+
      "entry_fee=excluded.entry_fee,realized_pnl=0,last_mark_price=excluded.last_mark_price,status='open',"+
      "entry_order_id=excluded.entry_order_id,opened_at=excluded.opened_at,closed_at=NULL,updated_at=excluded.updated_at "+
      "WHERE paper_positions.status='closed'"
    ).bind(plan.symbol,plan.quoteUnit,plan.strategy,plan.resolution,plan.filledQuantity,plan.avgFillPrice,
      plan.stopPrice,plan.takeProfitPrice,plan.quoteNotional,plan.feePaid,plan.avgFillPrice,orderId,now,now),
    // A pre-existing open row or any other no-op position write rolls back
    // the debit and leaves the order explicitly pending reconciliation.
    db.prepare(PAPER_LEDGER_CHANGE_ASSERT_SQL).bind(orderId),
    ...buildFillStatements(db,orderId,plan,"buy",createdAt),
    db.prepare("UPDATE paper_orders SET portfolio_applied=1 WHERE id=?").bind(orderId)
  ]);

  return {status:"paper_filled",symbol:plan.symbol,side:"buy",orderId,quantity:plan.filledQuantity,
    notional:plan.quoteNotional,fee:plan.feePaid,partial:plan.fillStatus==="partial"};
}

async function applyPaperExit(db,{portfolio,position,plan,orderKey,candleTime,bookLastUpdateMs,createdAt}){
  const prior=await db.prepare("SELECT id,portfolio_applied FROM paper_orders WHERE client_order_key=?")
    .bind(orderKey).first();
  if(prior?.id){
    if(Number(prior.portfolio_applied)===1)return {status:"duplicate_ignored",symbol:plan.symbol};
    throw new Error("paper_exit_previous_attempt_requires_manual_reconciliation");
  }
  const positionQty=Number(position.quantity);
  const allocatedEntryFee=Number(position.entry_fee||0)*Number(plan.filledQuantity)/positionQty;
  const realized=(Number(plan.avgFillPrice)-Number(position.average_entry_price))*Number(plan.filledQuantity)-
    Number(plan.feePaid)-allocatedEntryFee;
  const remaining=Math.max(0,positionQty-Number(plan.filledQuantity));
  const done=remaining<=Math.max(1e-12,positionQty*1e-9);
  const riskDetails=JSON.stringify({
    reason:plan.reason,bookAgeMs:plan.bookAgeMs,remainingQuantity:remaining,
    allocatedEntryFee,realizedPnl:realized,liveTradingEnabled:false,exchangeOrdersPlaced:0
  });
  const insert=await db.prepare(
    "INSERT OR IGNORE INTO paper_orders (client_order_key,symbol,quote_unit,strategy,resolution,side,action,"+
    "candle_time,requested_quantity,filled_quantity,average_fill_price,quote_notional,fee_paid,spread_bps,"+
    "latency_buffer_bps,status,reason,risk_details_json,book_last_update_ms,created_at) "+
    "VALUES (?,?,?,?,?,'sell',?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(orderKey,plan.symbol,plan.quoteUnit,plan.strategy,plan.resolution,plan.reason,candleTime,
    plan.requestedQuantity,plan.filledQuantity,plan.avgFillPrice,plan.quoteNotional,plan.feePaid,
    Number(plan.spreadBps||0),Number(portfolio.latency_buffer_bps),plan.fillStatus,plan.reason,riskDetails,
    bookLastUpdateMs,createdAt).run();
  if(Number(insert.meta?.changes||0)!==1)return {status:"duplicate_ignored",symbol:plan.symbol};
  const order=await db.prepare("SELECT id FROM paper_orders WHERE client_order_key=?").bind(orderKey).first();
  const orderId=Number(order?.id);
  if(!Number.isSafeInteger(orderId)||orderId<=0)throw new Error("paper_exit_order_id_missing");
  await db.batch([
    db.prepare(
      "UPDATE paper_positions SET quantity=?,entry_fee=MAX(0,entry_fee-?),realized_pnl=realized_pnl+?,"+
      "last_mark_price=?,status=?,closed_at=?,updated_at=? WHERE symbol=? AND status='open' AND quantity=?"
    ).bind(remaining,allocatedEntryFee,realized,plan.avgFillPrice,done?"closed":"open",
      done?createdAt:null,createdAt,plan.symbol,positionQty),
    // Assert the position update matched the exact open quantity being exited.
    db.prepare(PAPER_LEDGER_CHANGE_ASSERT_SQL).bind(orderId),
    db.prepare(
      "UPDATE paper_portfolios SET cash_balance=cash_balance+?-?,fees_paid=fees_paid+?,"+
      "realized_pnl=realized_pnl+?,updated_at=? WHERE quote_unit=? AND virtual_only=1 AND paper_enabled=1"
    ).bind(plan.quoteNotional,plan.feePaid,plan.feePaid,realized,createdAt,plan.quoteUnit),
    // If the portfolio credit cannot be applied, roll back the position close.
    db.prepare(PAPER_LEDGER_CHANGE_ASSERT_SQL).bind(orderId),
    ...buildFillStatements(db,orderId,plan,"sell",createdAt),
    db.prepare("UPDATE paper_orders SET portfolio_applied=1 WHERE id=?").bind(orderId)
  ]);

  return {status:done?"paper_closed":"paper_partial_exit",symbol:plan.symbol,side:"sell",
    orderId,quantity:plan.filledQuantity,remainingQuantity:remaining,notional:plan.quoteNotional,
    fee:plan.feePaid,realizedPnl:realized};
}

export async function simulatePaperRun(db,input,claims,{nowMs=Date.now()}={}){
  const validated=validatePaperRunPayload(input,claims,{nowMs});
  const createdAt=new Date(nowMs).toISOString();
  const results=[];
  const byQuote=new Map();
  const bumpOutcome=(quote,delta={})=>{
    const prior=byQuote.get(quote)||{accepted:0,executed:0,skipped:0};
    byQuote.set(quote,{
      accepted:prior.accepted+Number(delta.accepted||0),
      executed:prior.executed+Number(delta.executed||0),
      skipped:prior.skipped+Number(delta.skipped||0)
    });
  };
  for(const pair of validated.pairs){
    const registry=await db.prepare(
      "SELECT * FROM research_market_pair_registry WHERE symbol=?"
    ).bind(pair.symbol).first();
    if(!registry||Number(registry.research_enabled)!==1||Number(registry.execution_enabled)!==0||
      registry.udf_source_price_unit!==pair.sourcePriceUnit||
      registry.canonical_price_unit!==pair.canonicalPriceUnit||
      Number(registry.conversion_multiplier)!==pair.multiplier||
      registry.unit_audit_status!=="EMPIRICAL_LIKELY_ONE_SNAPSHOT"){
      results.push({symbol:pair.symbol,status:"skipped",reason:"research_registry_gate_not_enabled"});
      bumpOutcome(pair.canonicalPriceUnit,{skipped:1});
      continue;
    }
    const portfolio=await db.prepare("SELECT * FROM paper_portfolios WHERE quote_unit=?")
      .bind(pair.canonicalPriceUnit).first();
    if(!portfolio||Number(portfolio.virtual_only)!==1||Number(portfolio.paper_enabled)!==1){
      results.push({symbol:pair.symbol,status:"skipped",reason:"paper_portfolio_not_enabled"});
      bumpOutcome(pair.canonicalPriceUnit,{skipped:1});
      continue;
    }
    const pendingOrder=await db.prepare(
      "SELECT id,client_order_key FROM paper_orders WHERE symbol=? AND portfolio_applied=0 LIMIT 1"
    ).bind(pair.symbol).first();
    if(pendingOrder){
      results.push({symbol:pair.symbol,status:"skipped",reason:"paper_order_pending_reconciliation"});
      bumpOutcome(pair.canonicalPriceUnit,{skipped:1});
      continue;
    }
    const existingPosition=await db.prepare(
      "SELECT * FROM paper_positions WHERE symbol=? AND status='open'"
    ).bind(pair.symbol).first();
    let candidate=null;
    if(existingPosition){
      if(String(existingPosition.strategy)!==pair.strategy||String(existingPosition.resolution)!==pair.resolution){
        results.push({symbol:pair.symbol,status:"skipped",reason:"open_position_strategy_identity_mismatch"});
        bumpOutcome(pair.canonicalPriceUnit,{skipped:1});continue;
      }
      candidate=managementCandidate(existingPosition);
    }else if(pair.paperType==="multi_asset"){
      const recentRuns=await db.prepare("SELECT id,generated_at FROM paper_candidate_runs ORDER BY id DESC LIMIT 2").all();
      const runRows=recentRuns.results||[];
      if(runRows.length<2){
        results.push({symbol:pair.symbol,status:"skipped",reason:"two_confirming_scout_runs_required"});
        bumpOutcome(pair.canonicalPriceUnit,{skipped:1});continue;
      }
      const evidence=await db.prepare(
        "SELECT e.*,r.generated_at FROM paper_candidate_evidence e "+
        "JOIN paper_candidate_runs r ON r.id=e.run_id WHERE e.run_id IN (?,?) "+
        "AND e.symbol=? AND e.resolution=? AND e.strategy=?"
      ).bind(Number(runRows[0].id),Number(runRows[1].id),pair.symbol,pair.resolution,pair.strategy).all();
      const confirmed=confirmCandidatesAcrossScans({runs:runRows,evidence:evidence.results||[],nowMs});
      const row=confirmed.find(item=>String(item.symbol)===pair.symbol&&String(item.strategy)===pair.strategy);
      if(!row){
        results.push({symbol:pair.symbol,status:"skipped",reason:"multi_asset_candidate_not_in_two_recent_scans"});
        bumpOutcome(pair.canonicalPriceUnit,{skipped:1});continue;
      }
      candidate=multiAssetWatchCandidate(row);
    }else{
      if(pair.symbol!==PAPER_MVP_SYMBOL||pair.strategy!=="ema-trend"){
        results.push({symbol:pair.symbol,status:"skipped",reason:"legacy_paper_scope_is_btcirt_ema_only"});
        bumpOutcome(pair.canonicalPriceUnit,{skipped:1});continue;
      }
      const candidateRow=await db.prepare(
        "SELECT c.*,r.generated_at AS research_generated_at FROM research_watch_candidates c "+
        "JOIN research_watch_runs r ON r.id=c.run_id "+
        "WHERE c.symbol=? AND c.resolution=? AND c.strategy='ema-trend' "+
        "ORDER BY r.id DESC LIMIT 1"
      ).bind(pair.symbol,pair.resolution).first();
      const age=candidateRow?nowMs-Date.parse(String(candidateRow.research_generated_at||"")):Infinity;
      if(!candidateRow||!Number.isFinite(age)||age< -60_000||age>4*60*60*1000){
        results.push({symbol:pair.symbol,status:"skipped",reason:"legacy_btcirt_candidate_missing_or_stale"});
        bumpOutcome(pair.canonicalPriceUnit,{skipped:1});continue;
      }
      candidate=latestWatchCandidate(candidateRow);
    }
    const candles=convertCandles(pair);
    const duration=RESOLUTIONS[pair.resolution];
    const analysis=buildMarketResearch(candles,{
      resolutionSeconds:duration,horizonBars:1,minCandles:200,maxCandleAgeBars:1,
      nowEpochSeconds:Math.floor(nowMs/1000),symbol:pair.symbol
    });
    const positionsResult=await db.prepare(
      "SELECT * FROM paper_positions WHERE quote_unit=? AND status='open'"
    ).bind(pair.canonicalPriceUnit).all();
    const openPositions=positionsResult.results||[];
    const markPrices=Object.fromEntries(validated.pairs
      .filter(p=>p.canonicalPriceUnit===pair.canonicalPriceUnit)
      .map(p=>[p.symbol,Number(p.orderbook.bids[0][0])]));
    const dayKey=tehranDayKey(nowMs);
    if(String(portfolio.day_key)!==dayKey){
      const currentOpenNotional=openPositions.reduce((sum,p)=>
        sum+Number(p.quantity)*(Number(markPrices[p.symbol])||Number(p.last_mark_price)),0);
      const currentEquity=Number(portfolio.cash_balance)+currentOpenNotional;
      await db.prepare("UPDATE paper_portfolios SET day_key=?,day_start_equity=?,updated_at=? WHERE quote_unit=?")
        .bind(dayKey,currentEquity,createdAt,pair.canonicalPriceUnit).run();
      portfolio.day_key=dayKey;portfolio.day_start_equity=currentEquity;
    }
    const risk=calculatePaperPortfolioRisk({portfolio,openPositions,markPrices});
    if(!risk.valid){
      results.push({symbol:pair.symbol,status:"skipped",reason:risk.reason});
      bumpOutcome(pair.canonicalPriceUnit,{skipped:1});
      continue;
    }
    if(risk.killSwitch){
      await db.prepare("UPDATE paper_portfolios SET kill_switch=1,peak_equity=MAX(peak_equity,?),updated_at=? WHERE quote_unit=?")
        .bind(risk.peakEquity,createdAt,pair.canonicalPriceUnit).run();
      portfolio.kill_switch=1;
    }
    const bookAgeMs=nowMs-pair.orderbookLastUpdateMs;
    const book={bids:pair.orderbook.bids,asks:pair.orderbook.asks};
    const signal=classifyForwardPaperSignal({candidate,analysis,hasOpenPosition:Boolean(existingPosition)});
    let plan=null,action=null;
    if(existingPosition){
      const bid=Number(book.bids[0]?.[0]);
      const reason=bid<=Number(existingPosition.stop_price)?"stop_exit":
        bid>=Number(existingPosition.take_profit_price)?"take_profit_exit":
        signal.action==="exit"?"signal_exit":null;
      if(reason&&reason!=="none"){
        plan=createPaperExitPlan({position:{...existingPosition,exitCandleTime:analysis.lastCandle?.time},
          book,portfolio,orderbookLastUpdateMs:pair.orderbookLastUpdateMs,nowMs,reason});
        action="exit";
      }else{
        results.push({symbol:pair.symbol,status:"hold",reason:signal.reason,analysisDecision:analysis.decision,
          liveTradingEnabled:false});
        bumpOutcome(pair.canonicalPriceUnit,{skipped:1});
        continue;
      }
    }else{
      if(signal.action!=="buy"){
        results.push({symbol:pair.symbol,status:signal.action,reason:signal.reason,
          analysisDecision:analysis.decision,liveTradingEnabled:false});
        bumpOutcome(pair.canonicalPriceUnit,{skipped:1});
        continue;
      }
      if(Number(portfolio.kill_switch)===1||risk.killSwitch){
        results.push({symbol:pair.symbol,status:"skipped",reason:"paper_kill_switch_active"});
        bumpOutcome(pair.canonicalPriceUnit,{skipped:1});
        continue;
      }
      if(openPositions.length>=Number(portfolio.max_open_positions)){
        results.push({symbol:pair.symbol,status:"skipped",reason:"paper_max_open_positions"});
        bumpOutcome(pair.canonicalPriceUnit,{skipped:1});
        continue;
      }
      plan=createPaperEntryPlan({candidate,analysis,portfolio,book,
        orderbookLastUpdateMs:pair.orderbookLastUpdateMs,nowMs});
      action="entry";
    }
    if(!plan?.approved){
      results.push({symbol:pair.symbol,status:"skipped",reason:plan?.reason||"paper_plan_not_approved",
        liveTradingEnabled:false});
      bumpOutcome(pair.canonicalPriceUnit,{skipped:1});
      continue;
    }
    if(action==="entry"){
      const currentExposure=risk.openNotional;
      if(currentExposure+plan.quoteNotional>risk.equity*Number(portfolio.max_exposure_fraction)){
        results.push({symbol:pair.symbol,status:"skipped",reason:"portfolio_total_exposure_cap"});
        bumpOutcome(pair.canonicalPriceUnit,{skipped:1});
        continue;
      }
    }
    const candleTime=Number(analysis.lastCandle?.time);
    const orderKey=[pair.symbol,pair.resolution,candleTime,action,validated.githubRunId,validated.githubRunAttempt].join(":");
    const stored=action==="entry"
      ? await applyPaperEntry(db,{portfolio,plan,orderKey,candleTime,bookLastUpdateMs:pair.orderbookLastUpdateMs,
          runId:validated.githubRunId,runAttempt:validated.githubRunAttempt,createdAt})
      : await applyPaperExit(db,{portfolio,position:existingPosition,plan,orderKey,candleTime,
          bookLastUpdateMs:pair.orderbookLastUpdateMs,createdAt});
    results.push({...stored,analysisDecision:analysis.decision,liveTradingEnabled:false,exchangeOrdersPlaced:0});
    bumpOutcome(pair.canonicalPriceUnit,{
      accepted:1,
      executed:stored.status.startsWith("paper_")?1:0,
      skipped:stored.status.startsWith("paper_")?0:1
    });
  }

  const portfolioSummaries=[];
  for(const quote of ["RIAL","USDT"]){
    const portfolio=await db.prepare("SELECT * FROM paper_portfolios WHERE quote_unit=?").bind(quote).first();
    if(!portfolio)continue;
    const positions=await db.prepare("SELECT * FROM paper_positions WHERE quote_unit=? AND status='open'").bind(quote).all();
    const openPositions=positions.results||[];
    const marks=Object.fromEntries(validated.pairs.filter(p=>(quote==="RIAL"?p.symbol.endsWith("IRT"):p.symbol.endsWith("USDT")))
      .map(p=>[p.symbol,Number(p.orderbook.bids[0][0])]));
    const risk=calculatePaperPortfolioRisk({portfolio,openPositions,markPrices:marks});
    const openNotional=openPositions.reduce((sum,p)=>sum+Number(p.quantity)*(Number(marks[p.symbol])||Number(p.last_mark_price)),0);
    const equity=Number(portfolio.cash_balance)+openNotional;
    const peak=Math.max(Number(portfolio.peak_equity),equity);
    const dailyLoss=Math.max(0,(Number(portfolio.day_start_equity)-equity)/Number(portfolio.day_start_equity));
    const drawdown=Math.max(0,(peak-equity)/peak);
    if(risk.killSwitch||dailyLoss>=Number(portfolio.max_daily_loss_fraction)||drawdown>=Number(portfolio.max_drawdown_fraction)){
      await db.prepare("UPDATE paper_portfolios SET kill_switch=1,peak_equity=MAX(peak_equity,?),updated_at=? WHERE quote_unit=?")
        .bind(peak,createdAt,quote).run();
    }else{
      await db.prepare("UPDATE paper_portfolios SET peak_equity=MAX(peak_equity,?),updated_at=? WHERE quote_unit=?")
        .bind(peak,createdAt,quote).run();
    }
    const outcome=byQuote.get(quote)||{accepted:0,executed:0,skipped:0};
    const snapshot=await db.prepare(
      "INSERT OR IGNORE INTO paper_run_snapshots (github_run_id,github_run_attempt,generated_at,portfolio_quote_unit,"+
      "starting_equity,cash_balance,open_position_count,open_notional,marked_equity,realized_pnl,fees_paid,"+
      "daily_loss_fraction,drawdown_fraction,accepted_signal_count,executed_paper_order_count,skipped_signal_count) "+
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(validated.githubRunId,validated.githubRunAttempt,createdAt,quote,portfolio.starting_equity,
      portfolio.cash_balance,openPositions.length,openNotional,equity,portfolio.realized_pnl,portfolio.fees_paid,
      dailyLoss,drawdown,outcome.accepted,outcome.executed,outcome.skipped).run();
    portfolioSummaries.push({quoteUnit:quote,cashBalance:portfolio.cash_balance,equity,
      openPositions:openPositions.length,openNotional,realizedPnl:portfolio.realized_pnl,
      feesPaid:portfolio.fees_paid,dailyLossFraction:dailyLoss,drawdownFraction:drawdown,
      killSwitch:risk.killSwitch||dailyLoss>=Number(portfolio.max_daily_loss_fraction)||
        drawdown>=Number(portfolio.max_drawdown_fraction)});
  }
  return {status:"stored",githubRunId:validated.githubRunId,githubRunAttempt:validated.githubRunAttempt,
    evaluatedPairs:validated.pairs.length,results,portfolios:portfolioSummaries,
    paperOrdersSimulated:results.filter(r=>r.status==="paper_filled"||r.status==="paper_closed"||r.status==="paper_partial_exit").length,
    exchangeOrdersPlaced:0,liveTradingEnabled:false,observationOnly:false,orderEndpoints:false};
}
