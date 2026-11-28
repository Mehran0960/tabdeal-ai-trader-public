import {calculateRiskPlan} from "./risk.js";
import {walkPaperOrderbook} from "./paper-engine.js";

export const TABDEAL_PAPER_BOT_POLICY = Object.freeze({
  portfolioId: "tabdeal-forward-paper-v1",
  strategyVersion: "ema9-21-50-rsi14-macd-5m-v1",
  initialCapitalUsdt: 100,
  riskFraction: 0.0025,
  maxExposureFraction: 0.20,
  maxDailyLossFraction: 0.02,
  maxDrawdownFraction: 0.20,
  feeBpsPerSide: 40,
  latencyBufferBps: 5,
  maximumSlippageBps: 25,
  maximumSpreadBps: 30,
  minimumSideDepthUsdt: 1000,
  maximumBookAgeMs: 8000,
  maximumSignalAgeMs: 120000,
  stopAtrMultiple: 2,
  takeProfitRiskMultiple: 3
});

const finite = value => Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value) > 0;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

function fail(code) {
  throw new Error(code);
}

function utcDayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function floorToStep(value, step) {
  if (!positive(value) || !positive(step)) return 0;
  const decimals = Math.min(12, Math.max(
    (String(value).split(".")[1] || "").length,
    (String(step).split(".")[1] || "").length
  ));
  const scale = 10 ** decimals;
  const valueUnits = Math.floor(Number(value) * scale + 1e-8);
  const stepUnits = Math.round(Number(step) * scale);
  if (stepUnits <= 0) return 0;
  return Math.floor(valueUnits / stepUnits) * stepUnits / scale;
}

function normalizeBook(book) {
  if (!record(book) || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return null;
  const normalize = (rows, descending) => rows
    .map(row => Array.isArray(row)
      ? [Number(row[0]), Number(row[1])]
      : [Number(row?.price), Number(row?.quantity)])
    .filter(row => positive(row[0]) && positive(row[1]))
    .sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]);
  const bids = normalize(book.bids, true);
  const asks = normalize(book.asks, false);
  if (!bids.length || !asks.length || asks[0][0] <= bids[0][0]) return null;
  const mid = (bids[0][0] + asks[0][0]) / 2;
  const spreadBps = (asks[0][0] - bids[0][0]) / mid * 10000;
  const bidDepth25 = bids.filter(([price]) => price >= mid * 0.9975)
    .reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  const askDepth25 = asks.filter(([price]) => price <= mid * 1.0025)
    .reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  return {bids, asks, bid: bids[0][0], ask: asks[0][0], spreadBps, bidDepth25, askDepth25};
}

function bookGate(input, nowMs) {
  const age = nowMs - Number(input.bookObservedAtMs);
  if (!Number.isFinite(age) || age < -10000 || age > TABDEAL_PAPER_BOT_POLICY.maximumBookAgeMs) {
    return {ok: false, reason: "paper_bot_book_stale_or_clock_skewed"};
  }
  const book = normalizeBook(input.book);
  if (!book) return {ok: false, reason: "paper_bot_book_invalid"};
  if (book.spreadBps > TABDEAL_PAPER_BOT_POLICY.maximumSpreadBps) {
    return {ok: false, reason: "paper_bot_spread_gate_failed", book};
  }
  if (book.bidDepth25 < TABDEAL_PAPER_BOT_POLICY.minimumSideDepthUsdt ||
      book.askDepth25 < TABDEAL_PAPER_BOT_POLICY.minimumSideDepthUsdt) {
    return {ok: false, reason: "paper_bot_two_sided_depth_gate_failed", book};
  }
  return {ok: true, reason: "paper_bot_book_gate_passed", book, ageMs: age};
}

function validSignal(input, nowMs) {
  const candle = input?.candle;
  const analysis = input?.analysis;
  const signalAge = nowMs - (Number(candle?.minuteOpenMs) + 60000);
  if (!record(candle) || candle.isClosed !== true ||
      !Number.isSafeInteger(Number(candle.minuteOpenMs)) ||
      ![candle.open, candle.high, candle.low, candle.close].every(positive) ||
      candle.high < Math.max(candle.open, candle.close, candle.low) ||
      candle.low > Math.min(candle.open, candle.close, candle.high)) {
    return {ok: false, reason: "paper_bot_closed_candle_invalid"};
  }
  if (!Number.isFinite(signalAge) || signalAge < -10000 ||
      signalAge > TABDEAL_PAPER_BOT_POLICY.maximumSignalAgeMs) {
    return {ok: false, reason: "paper_bot_signal_stale"};
  }
  if (!record(analysis) || analysis.status !== "ready" ||
      !record(analysis.dataQuality) || analysis.dataQuality.status !== "usable" ||
      Number(analysis.dataQuality.materialGapCount || 0) !== 0 ||
      !record(analysis.indicators)) {
    return {ok: false, reason: "paper_bot_signal_quality_not_usable"};
  }
  return {ok: true, signalAgeMs: signalAge};
}

function marketRulesReady(rules) {
  return record(rules) && positive(rules.minQty) && positive(rules.stepSize) &&
    positive(rules.minNotional) && (!rules.maxQty || positive(rules.maxQty));
}

function paperEquity(state, bookBySymbol = {}) {
  const position = state.position;
  if (!position) return Number(state.cashBalanceUsdt);
  const supplied = bookBySymbol[position.symbol];
  const book = supplied?.book || normalizeBook(supplied);
  if (!book) return null;
  const markGross = Number(position.quantity) * book.bid *
    (1 - TABDEAL_PAPER_BOT_POLICY.latencyBufferBps / 10000);
  const markFee = markGross * TABDEAL_PAPER_BOT_POLICY.feeBpsPerSide / 10000;
  return Number(state.cashBalanceUsdt) + markGross - markFee;
}

function updateRiskState(state, equity, nowMs) {
  if (!positive(equity)) return {ok: false, reason: "paper_bot_equity_unavailable"};
  const day = utcDayKey(nowMs);
  if (state.dayKeyUtc !== day) {
    state.dayKeyUtc = day;
    state.dayStartEquityUsdt = equity;
  }
  state.peakEquityUsdt = Math.max(Number(state.peakEquityUsdt), equity);
  const dailyLossFraction = Math.max(0,
    (Number(state.dayStartEquityUsdt) - equity) / Number(state.dayStartEquityUsdt));
  const drawdownFraction = Math.max(0,
    (Number(state.peakEquityUsdt) - equity) / Number(state.peakEquityUsdt));
  state.maxDrawdownPct = Math.max(Number(state.maxDrawdownPct || 0), drawdownFraction * 100);
  if (dailyLossFraction >= TABDEAL_PAPER_BOT_POLICY.maxDailyLossFraction ||
      drawdownFraction >= TABDEAL_PAPER_BOT_POLICY.maxDrawdownFraction) {
    state.halted = true;
    state.haltReason = dailyLossFraction >= TABDEAL_PAPER_BOT_POLICY.maxDailyLossFraction
      ? "paper_bot_daily_loss_limit"
      : "paper_bot_max_drawdown_limit";
  }
  return {ok: true, equity, dailyLossFraction, drawdownFraction,
    halted: state.halted === true, haltReason: state.haltReason || null};
}

function makeEvent({symbol, side, quantity, price, notional, fee, reason, nowMs, candleOpenMs, realizedPnlUsdt = null}) {
  return {
    eventId: [symbol, side, candleOpenMs, reason].join(":"),
    symbol, side, quantity, averagePrice: price, quoteNotional: notional,
    feePaid: fee, reason, eventAtMs: nowMs, candleOpenMs, realizedPnlUsdt,
    execution: "PAPER_ONLY_LOCAL_TABDEAL_ORDERBOOK",
    exchangeOrderCreated: false
  };
}

function tryPaperExit(state, input, reason, nowMs) {
  const position = state.position;
  const gate = bookGate(input, nowMs);
  if (!gate.ok) return {changed: false, reason: gate.reason};
  const fill = walkPaperOrderbook({
    side: "sell", quantity: Number(position.quantity), levels: gate.book.bids,
    latencyBufferBps: TABDEAL_PAPER_BOT_POLICY.latencyBufferBps,
    maxSlippageBps: TABDEAL_PAPER_BOT_POLICY.maximumSlippageBps
  });
  if (fill.status !== "filled" ||
      Math.abs(fill.filledQuantity - Number(position.quantity)) > Math.max(1e-12, Number(position.quantity) * 1e-8)) {
    return {changed: false, reason: "paper_bot_exit_not_fully_fillable"};
  }
  const notional = fill.quoteNotional;
  const minNotional = Number(input.marketRules?.minNotional);
  if (!positive(minNotional) || notional + 1e-10 < minNotional) {
    return {changed: false, reason: "paper_bot_exit_below_market_minimum"};
  }
  const fee = notional * TABDEAL_PAPER_BOT_POLICY.feeBpsPerSide / 10000;
  const netProceeds = notional - fee;
  const realizedPnlUsdt = netProceeds - Number(position.entryDebitUsdt);
  state.cashBalanceUsdt = Number(state.cashBalanceUsdt) + netProceeds;
  state.realizedPnlUsdt = Number(state.realizedPnlUsdt || 0) + realizedPnlUsdt;
  const event = makeEvent({
    symbol: position.symbol, side: "SELL", quantity: fill.filledQuantity,
    price: fill.avgFillPrice, notional, fee, reason, nowMs,
    candleOpenMs: Number(input.candle.minuteOpenMs), realizedPnlUsdt
  });
  state.position = null;
  state.lastProcessedCandleBySymbol[position.symbol] = Number(input.candle.minuteOpenMs);
  return {changed: true, event, reason: "paper_bot_position_closed"};
}

function entryScore(input) {
  const x = input.analysis.indicators;
  const rsiDistance = Math.abs(Number(x.rsi14) - 58);
  const trendSpread = (Number(x.ema9) / Number(x.ema50) - 1) * 10000;
  const macdBps = Number(x.macdHistogram) / Number(x.latestClose) * 10000;
  return -rsiDistance + trendSpread * 0.02 + macdBps;
}

export function createTabdealPaperBotState({initialCapitalUsdt = TABDEAL_PAPER_BOT_POLICY.initialCapitalUsdt, nowMs = Date.now()} = {}) {
  if (!positive(initialCapitalUsdt) || !Number.isSafeInteger(nowMs)) fail("paper_bot_initial_state_invalid");
  return {
    schemaVersion: 1,
    portfolioId: TABDEAL_PAPER_BOT_POLICY.portfolioId,
    strategyVersion: TABDEAL_PAPER_BOT_POLICY.strategyVersion,
    initialCapitalUsdt: Number(initialCapitalUsdt),
    cashBalanceUsdt: Number(initialCapitalUsdt),
    peakEquityUsdt: Number(initialCapitalUsdt),
    dayStartEquityUsdt: Number(initialCapitalUsdt),
    dayKeyUtc: utcDayKey(nowMs),
    realizedPnlUsdt: 0,
    maxDrawdownPct: 0,
    halted: false,
    haltReason: null,
    position: null,
    lastProcessedCandleBySymbol: {},
    tradeCount: 0,
    lastRunAtMs: null
  };
}

export function evaluateTabdealPaperBotTick({state, signals, nowMs = Date.now()} = {}) {
  if (!Number.isSafeInteger(nowMs) || !Array.isArray(signals)) fail("paper_bot_tick_input_invalid");
  const current = state === undefined || state === null
    ? createTabdealPaperBotState({nowMs})
    : structuredClone(state);
  if (current.schemaVersion !== 1 ||
      current.portfolioId !== TABDEAL_PAPER_BOT_POLICY.portfolioId ||
      !positive(current.initialCapitalUsdt) ||
      !finite(current.cashBalanceUsdt) || Number(current.cashBalanceUsdt) < 0 ||
      !record(current.lastProcessedCandleBySymbol) ||
      (current.position && (!positive(current.position.quantity) ||
        typeof current.position.symbol !== "string"))) {
    fail("paper_bot_state_invalid");
  }

  const events = [];
  const normalized = signals.filter(row => record(row) &&
    /^[A-Z0-9]{2,20}USDT$/.test(String(row.symbol || "").toUpperCase()))
    .map(row => ({...row, symbol: String(row.symbol).toUpperCase()}));

  if (current.position) {
    const input = normalized.find(row => row.symbol === current.position.symbol);
    if (!input) return {
      state: current, events, changed: false, action: "HOLD",
      reason: "paper_bot_open_position_signal_missing",
      liveTradingEnabled: false, exchangeOrdersCreated: 0, fundsMoved: false
    };
    const signalCheck = validSignal(input, nowMs);
    if (!signalCheck.ok) return {
      state: current, events, changed: false, action: "HOLD",
      reason: signalCheck.reason,
      liveTradingEnabled: false, exchangeOrdersCreated: 0, fundsMoved: false
    };

    const position = current.position;
    const candle = input.candle;
    const indicators = input.analysis.indicators;
    const stopTouched = Number(candle.low) <= Number(position.stopPrice);
    const targetTouched = Number(candle.high) >= Number(position.takeProfitPrice);
    const trendLost = Number(indicators.ema9) <= Number(indicators.ema21) ||
      Number(indicators.ema21) <= Number(indicators.ema50) ||
      Number(indicators.ema5m12) <= Number(indicators.ema5m26);
    // If both barriers occur inside one 1m candle, assume the stop was hit first.
    const exitReason = stopTouched ? "stop_loss"
      : targetTouched ? "take_profit"
      : current.halted ? current.haltReason
      : trendLost ? "trend_alignment_lost"
      : null;

    const gate = bookGate(input, nowMs);
    if (!gate.ok) return {
      state: current, events, changed: false,
      action: exitReason ? "EXIT_PENDING" : "HOLD",
      reason: exitReason ? "exit_pending_" + exitReason + "_" + gate.reason : gate.reason,
      liveTradingEnabled: false, exchangeOrdersCreated: 0, fundsMoved: false
    };
    const equity = paperEquity(current, {[position.symbol]: gate});
    const risk = updateRiskState(current, equity, nowMs);
    const finalReason = exitReason || (risk.halted ? risk.haltReason : null);
    if (!finalReason) {
      current.lastProcessedCandleBySymbol[position.symbol] = Number(candle.minuteOpenMs);
      current.position.lastMarkPrice = gate.book.bid;
      current.position.lastUpdatedAtMs = nowMs;
      current.lastRunAtMs = nowMs;
      return {
        state: current, events, changed: true, action: "HOLD",
        reason: "paper_bot_position_within_exit_rules",
        risk, liveTradingEnabled: false, exchangeOrdersCreated: 0, fundsMoved: false
      };
    }

    const exit = tryPaperExit(current, input, finalReason, nowMs);
    if (!exit.changed) return {
      state: current, events, changed: false, action: "EXIT_PENDING",
      reason: exit.reason, risk,
      liveTradingEnabled: false, exchangeOrdersCreated: 0, fundsMoved: false
    };
    events.push(exit.event);
    current.tradeCount += 1;
    current.lastRunAtMs = nowMs;
    const postExitRisk = updateRiskState(current, current.cashBalanceUsdt, nowMs);
    return {
      state: current, events, changed: true, action: "SELL",
      reason: finalReason, risk: postExitRisk,
      liveTradingEnabled: false, exchangeOrdersCreated: 0, fundsMoved: false
    };
  }

  const equity = Number(current.cashBalanceUsdt);
  const risk = updateRiskState(current, equity, nowMs);
  if (current.halted) return {
    state: current, events, changed: false, action: "HALTED",
    reason: current.haltReason || "paper_bot_kill_switch_active", risk,
    liveTradingEnabled: false, exchangeOrdersCreated: 0, fundsMoved: false
  };

  const candidates = [];
  for (const input of normalized) {
    const check = validSignal(input, nowMs);
    if (!check.ok || input.analysis.signal !== "BUY_CANDIDATE") continue;
    const candleOpenMs = Number(input.candle.minuteOpenMs);
    if (candleOpenMs <= Number(current.lastProcessedCandleBySymbol[input.symbol] || 0)) continue;
    const book = bookGate(input, nowMs);
    if (!book.ok || !marketRulesReady(input.marketRules)) continue;
    const indicators = input.analysis.indicators;
    if (![indicators.atr14, indicators.ema9, indicators.ema21, indicators.ema50,
      indicators.ema5m12, indicators.ema5m26, indicators.rsi14, indicators.macdHistogram,
      indicators.latestClose].every(finite)) continue;
    candidates.push({...input, signalCheck: check, normalizedBook: book.book,
      score: entryScore(input)});
  }
  candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));

  for (const input of candidates) {
    const book = input.normalizedBook;
    const atr = Number(input.analysis.indicators.atr14);
    const referenceEntry = book.ask;
    const proposedStop = referenceEntry - TABDEAL_PAPER_BOT_POLICY.stopAtrMultiple * atr;
    if (!positive(proposedStop) || proposedStop >= referenceEntry) {
      current.lastProcessedCandleBySymbol[input.symbol] = Number(input.candle.minuteOpenMs);
      continue;
    }
    const plan = calculateRiskPlan({
      equity: current.cashBalanceUsdt,
      entryPrice: referenceEntry,
      stopPrice: proposedStop,
      feeBps: TABDEAL_PAPER_BOT_POLICY.feeBpsPerSide,
      slippageBps: TABDEAL_PAPER_BOT_POLICY.latencyBufferBps,
      riskFraction: TABDEAL_PAPER_BOT_POLICY.riskFraction,
      maxExposureFraction: TABDEAL_PAPER_BOT_POLICY.maxExposureFraction,
      maxDailyLossFraction: TABDEAL_PAPER_BOT_POLICY.maxDailyLossFraction,
      maxDrawdownFraction: TABDEAL_PAPER_BOT_POLICY.maxDrawdownFraction,
      killSwitch: current.halted
    });
    if (!plan.approved) {
      current.lastProcessedCandleBySymbol[input.symbol] = Number(input.candle.minuteOpenMs);
      continue;
    }
    const step = Number(input.marketRules.stepSize);
    const quantity = floorToStep(plan.quantity, step);
    const minQty = Number(input.marketRules.minQty);
    const maxQty = Number(input.marketRules.maxQty || Number.POSITIVE_INFINITY);
    if (!positive(quantity) || quantity < minQty || quantity > maxQty) {
      current.lastProcessedCandleBySymbol[input.symbol] = Number(input.candle.minuteOpenMs);
      continue;
    }
    const fill = walkPaperOrderbook({
      side: "buy", quantity, levels: book.asks,
      latencyBufferBps: TABDEAL_PAPER_BOT_POLICY.latencyBufferBps,
      maxSlippageBps: TABDEAL_PAPER_BOT_POLICY.maximumSlippageBps
    });
    if (fill.status !== "filled" ||
        Math.abs(fill.filledQuantity - quantity) > Math.max(1e-12, quantity * 1e-8)) {
      current.lastProcessedCandleBySymbol[input.symbol] = Number(input.candle.minuteOpenMs);
      continue;
    }
    const notional = fill.quoteNotional;
    const minNotional = Number(input.marketRules.minNotional);
    const fee = notional * TABDEAL_PAPER_BOT_POLICY.feeBpsPerSide / 10000;
    const debit = notional + fee;
    if (!positive(minNotional) || notional + 1e-10 < minNotional ||
        debit > Number(current.cashBalanceUsdt) + 1e-8) {
      current.lastProcessedCandleBySymbol[input.symbol] = Number(input.candle.minuteOpenMs);
      continue;
    }
    const stopPrice = fill.avgFillPrice - TABDEAL_PAPER_BOT_POLICY.stopAtrMultiple * atr;
    const riskPerUnit = fill.avgFillPrice - stopPrice;
    const takeProfitPrice = fill.avgFillPrice + TABDEAL_PAPER_BOT_POLICY.takeProfitRiskMultiple * riskPerUnit;
    current.cashBalanceUsdt = Math.max(0, Number(current.cashBalanceUsdt) - debit);
    current.position = {
      symbol: input.symbol,
      strategyVersion: TABDEAL_PAPER_BOT_POLICY.strategyVersion,
      quantity: fill.filledQuantity,
      entryPrice: fill.avgFillPrice,
      entryNotionalUsdt: notional,
      entryFeeUsdt: fee,
      entryDebitUsdt: debit,
      stopPrice,
      takeProfitPrice,
      entryCandleOpenMs: Number(input.candle.minuteOpenMs),
      entryAtMs: nowMs,
      lastMarkPrice: book.bid
    };
    current.lastProcessedCandleBySymbol[input.symbol] = Number(input.candle.minuteOpenMs);
    current.tradeCount += 1;
    current.lastRunAtMs = nowMs;
    const event = makeEvent({
      symbol: input.symbol, side: "BUY", quantity: fill.filledQuantity,
      price: fill.avgFillPrice, notional, fee, reason: "local_mtf_momentum_candidate",
      nowMs, candleOpenMs: Number(input.candle.minuteOpenMs)
    });
    events.push(event);
    return {
      state: current, events, changed: true, action: "BUY",
      reason: "paper_bot_entry_approved",
      risk: updateRiskState(current, current.cashBalanceUsdt + notional, nowMs),
      liveTradingEnabled: false, exchangeOrdersCreated: 0, fundsMoved: false
    };
  }

  for (const input of normalized) {
    const time = Number(input.candle?.minuteOpenMs);
    if (Number.isSafeInteger(time) &&
        time > Number(current.lastProcessedCandleBySymbol[input.symbol] || 0)) {
      current.lastProcessedCandleBySymbol[input.symbol] = time;
    }
  }
  current.lastRunAtMs = nowMs;
  return {
    state: current, events, changed: true, action: "WAIT",
    reason: candidates.length ? "paper_bot_candidates_failed_entry_guards" : "no_fresh_qualified_paper_signal",
    risk, liveTradingEnabled: false, exchangeOrdersCreated: 0, fundsMoved: false
  };
}
