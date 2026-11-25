import test from "node:test";
import assert from "node:assert/strict";
import { buildMicrostructureSnapshot } from "../src/market-intelligence.js";

const book = {
  status: "ok",
  lastUpdate: 1_800_000_000_000,
  bids: [["100", "10"], ["99.95", "20"], ["99.5", "30"]],
  asks: [["100.1", "5"], ["100.2", "15"], ["100.6", "30"]]
};

test("microstructure computes spread, microprice and quote-depth imbalance", () => {
  const result = buildMicrostructureSnapshot(book, { trades: [] }, { nowMs: 1_800_000_000_000 });
  assert.ok(result.spreadBps > 0);
  assert.ok(result.depthImbalance10BpsPct > 0);
  assert.ok(Number.isFinite(result.micropriceEdgeBps));
  assert.equal(result.tradeImbalancePct, null);
  assert.equal(result.tradeFlowReliable, false);
});

test("trade-flow imbalance is quote-volume weighted, not trade-count weighted", () => {
  const result = buildMicrostructureSnapshot(book, { trades: [
    { time: 1_800_000_000_000, price: "100", volume: "10", type: "buy" },
    { time: 1_800_000_000_000, price: "100", volume: "2", type: "sell" },
    { time: 1_800_000_000_000, price: "100", volume: "1", type: "unknown" },
    { time: 1_800_000_000_000, price: "0", volume: "50", type: "buy" }
  ] }, { nowMs: 1_800_000_000_000 });
  assert.ok(result.tradeImbalancePct > 60);
  assert.equal(result.buyTradeCount, 1);
  assert.equal(result.sellTradeCount, 1);
  assert.equal(result.tradeCount, 2);
});

test("stale orderbooks fail closed", () => {
  assert.throws(
    () => buildMicrostructureSnapshot(book, { trades: [] }, { nowMs: 1_800_000_200_000 }),
    /stale_orderbook/
  );
});

test("invalid or crossed best quotes fail closed", () => {
  assert.throws(
    () => buildMicrostructureSnapshot({ ...book, asks: [["99", "1"]] }, { trades: [] }, { nowMs: 1_800_000_000_000 }),
    /invalid_best_quotes/
  );
});


test("capped recent-trade samples are not marked reliable for flow confirmation", () => {
  const cappedTrades = Array.from({ length: 100 }, (_, index) => ({
    time: 1_800_000_000_000 - index * 1000,
    price: "100",
    volume: "1",
    type: index % 2 ? "buy" : "sell"
  }));
  const result = buildMicrostructureSnapshot(book, { trades: cappedTrades }, { nowMs: 1_800_000_000_000 });
  assert.equal(result.tradeSampleCapped, true);
  assert.equal(result.tradeFlowReliable, false);
});
