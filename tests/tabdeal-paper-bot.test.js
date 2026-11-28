import test from "node:test";
import assert from "node:assert/strict";
import {
  createTabdealPaperBotState,
  evaluateTabdealPaperBotTick,
  TABDEAL_PAPER_BOT_POLICY
} from "../src/tabdeal-paper-bot.js";

const nowMs = Date.parse("2026-11-28T05:00:00.000Z");
const baseBook = () => ({
  bids: [["59990", "0.03"], ["59980", "0.03"]],
  asks: [["60010", "0.03"], ["60020", "0.03"]]
});
const goodSignal = (symbol = "BTCUSDT", minuteOpenMs = nowMs - 60_000) => ({
  symbol,
  signal: "BUY_CANDIDATE",
  candle: {
    minuteOpenMs, open: 60000, high: 60100, low: 59900,
    close: 60050, isClosed: true
  },
  analysis: {
    status: "ready",
    signal: "BUY_CANDIDATE",
    dataQuality: {status: "usable", materialGapCount: 0},
    indicators: {
      latestClose: 60050, atr14: 100, ema9: 60100, ema21: 60080, ema50: 60020,
      ema5m12: 60090, ema5m26: 60050, rsi14: 58, macdHistogram: 20,
      return60mPct: 0.2
    }
  },
  book: baseBook(),
  bookObservedAtMs: nowMs,
  marketRules: {
    minQty: "0.00001", maxQty: "100", stepSize: "0.00001", minNotional: "1"
  }
});

test("creates a paper-only portfolio with the registered virtual risk limits", () => {
  const state = createTabdealPaperBotState({nowMs});
  assert.equal(state.cashBalanceUsdt, 100);
  assert.equal(state.position, null);
  assert.equal(state.halted, false);
  assert.equal(TABDEAL_PAPER_BOT_POLICY.maxExposureFraction, 0.2);
  assert.equal(TABDEAL_PAPER_BOT_POLICY.riskFraction, 0.0025);
});

test("opens one virtual position from a fresh, usable signal and executable local book", () => {
  const state = createTabdealPaperBotState({nowMs});
  const result = evaluateTabdealPaperBotTick({state, signals: [goodSignal()], nowMs});
  assert.equal(result.action, "BUY");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].side, "BUY");
  assert.equal(result.state.position.symbol, "BTCUSDT");
  assert.ok(result.state.cashBalanceUsdt < 100);
  assert.equal(result.liveTradingEnabled, false);
  assert.equal(result.exchangeOrdersCreated, 0);
  assert.equal(result.fundsMoved, false);
});

test("chooses one strongest candidate and never opens two simultaneous positions", () => {
  const state = createTabdealPaperBotState({nowMs});
  const btc = goodSignal("BTCUSDT");
  const eth = goodSignal("ETHUSDT");
  eth.analysis.indicators.rsi14 = 57.5;
  eth.analysis.indicators.ema9 = 60200;
  const result = evaluateTabdealPaperBotTick({state, signals: [btc, eth], nowMs});
  assert.equal(result.action, "BUY");
  assert.equal(result.state.position !== null, true);
  assert.equal(result.events.length, 1);
});

test("does not enter on stale signals, stale books, unusable candles or gaps", () => {
  const state = createTabdealPaperBotState({nowMs});
  const staleSignal = goodSignal();
  staleSignal.candle.minuteOpenMs = nowMs - 10 * 60_000;
  const staleBook = goodSignal("ETHUSDT");
  staleBook.bookObservedAtMs = nowMs - 30_000;
  const gap = goodSignal("SOLUSDT");
  gap.analysis.dataQuality.materialGapCount = 1;
  const result = evaluateTabdealPaperBotTick({
    state, signals: [staleSignal, staleBook, gap], nowMs
  });
  assert.equal(result.action, "WAIT");
  assert.equal(result.state.position, null);
  assert.equal(result.events.length, 0);
});

test("blocks a thin or wide order book", () => {
  const state = createTabdealPaperBotState({nowMs});
  const signal = goodSignal();
  signal.book.asks = [["60010", "0.001"]];
  const result = evaluateTabdealPaperBotTick({state, signals: [signal], nowMs});
  assert.equal(result.action, "WAIT");
  assert.equal(result.state.position, null);
});

test("uses conservative stop-first handling when both stop and target are inside one candle", () => {
  const state = createTabdealPaperBotState({nowMs});
  const entered = evaluateTabdealPaperBotTick({state, signals: [goodSignal()], nowMs});
  assert.equal(entered.action, "BUY");
  const position = entered.state.position;
  const nextNow = nowMs + 60_000;
  const exitSignal = goodSignal(position.symbol, nowMs);
  exitSignal.candle.low = position.stopPrice - 1;
  exitSignal.candle.high = position.takeProfitPrice + 1;
  exitSignal.book = {
    bids: [["59800", "0.03"], ["59790", "0.03"]],
    asks: [["59810", "0.03"], ["59820", "0.03"]]
  };
  exitSignal.bookObservedAtMs = nextNow;
  const exited = evaluateTabdealPaperBotTick({
    state: entered.state, signals: [exitSignal], nowMs: nextNow
  });
  assert.equal(exited.action, "SELL");
  assert.equal(exited.reason, "stop_loss");
  assert.equal(exited.state.position, null);
  assert.ok(exited.state.realizedPnlUsdt < 0);
  assert.equal(exited.events[0].side, "SELL");
});

test("holds an open position when exit liquidity is unavailable", () => {
  const state = createTabdealPaperBotState({nowMs});
  const entered = evaluateTabdealPaperBotTick({state, signals: [goodSignal()], nowMs});
  const nextNow = nowMs + 60_000;
  const signal = goodSignal("BTCUSDT", nowMs);
  signal.candle.low = entered.state.position.stopPrice - 10;
  signal.book = {bids: [["59800", "0.000001"]], asks: [["59810", "0.000001"]]};
  signal.bookObservedAtMs = nextNow;
  const result = evaluateTabdealPaperBotTick({
    state: entered.state, signals: [signal], nowMs: nextNow
  });
  assert.equal(result.action, "EXIT_PENDING");
  assert.equal(result.state.position.symbol, "BTCUSDT");
  assert.equal(result.events.length, 0);
});

test("ignores an already processed candle and does not duplicate paper entries", () => {
  const state = createTabdealPaperBotState({nowMs});
  state.lastProcessedCandleBySymbol.BTCUSDT = nowMs - 60_000;
  const result = evaluateTabdealPaperBotTick({state, signals: [goodSignal()], nowMs});
  assert.equal(result.action, "WAIT");
  assert.equal(result.events.length, 0);
  assert.equal(result.state.position, null);
});

test("a daily-loss kill switch prevents new virtual entries", () => {
  const state = createTabdealPaperBotState({nowMs});
  state.cashBalanceUsdt = 97.9;
  const result = evaluateTabdealPaperBotTick({state, signals: [goodSignal()], nowMs});
  assert.equal(result.action, "HALTED");
  assert.equal(result.state.halted, true);
  assert.equal(result.state.haltReason, "paper_bot_daily_loss_limit");
  assert.equal(result.events.length, 0);
});

test("never creates exchange orders or moves funds", () => {
  const result = evaluateTabdealPaperBotTick({
    state: createTabdealPaperBotState({nowMs}),
    signals: [goodSignal()], nowMs
  });
  assert.equal(result.liveTradingEnabled, false);
  assert.equal(result.exchangeOrdersCreated, 0);
  assert.equal(result.fundsMoved, false);
  for (const event of result.events) assert.equal(event.exchangeOrderCreated, false);
});
