import test from "node:test";
import assert from "node:assert/strict";
import {
  captureTabdealSpotDepthWebsocket,
  TABDEAL_SPOT_DEPTH_SYMBOLS,
  TABDEAL_SPOT_DEPTH_WS_URL
} from "../scripts/tabdeal-spot-depth-ws.mjs";

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  emit(name, event) {
    for (const callback of this.listeners.get(name) || []) callback(event);
  }
  send(message) {
    this.sent.push(message);
    const request = JSON.parse(message);
    queueMicrotask(() => {
      this.emit("message", {data: JSON.stringify({result: null, id: request.id})});
      for (const topic of request.params) {
        const symbol = topic.split("@")[0].toUpperCase();
        this.emit("message", {data: JSON.stringify({
          stream: topic,
          data: {
            e: "depthUpdate",
            E: 1_800_000_000_000,
            U: 100,
            u: 102,
            s: symbol,
            b: [["100", "2"], ["99", "3"]],
            a: [["101", "1"], ["102", "2"]]
          }
        })});
      }
    });
  }
  close() {
    this.closed = true;
    this.emit("close", {code: 1000});
  }
}

test("subscribes to official public Spot depth topics and aggregates updates", async () => {
  FakeWebSocket.instances = [];
  const report = await captureTabdealSpotDepthWebsocket({
    symbols: ["BTCUSDT", "ETHIRT"],
    durationMs: 150,
    WebSocketImpl: FakeWebSocket,
    clock: () => 1_800_000_000_010
  });
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, TABDEAL_SPOT_DEPTH_WS_URL);
  assert.equal(JSON.parse(ws.sent[0]).method, "SUBSCRIBE");
  assert.deepEqual(JSON.parse(ws.sent[0]).params, ["btcusdt@depth@2000ms", "ethirt@depth@2000ms"]);
  assert.equal(report.summary.symbolsWithUpdates, 2);
  assert.equal(report.symbols[0].updateCount, 1);
  assert.equal(report.symbols[0].quoteAsset, "USDT");
  assert.equal(report.symbols[0].quoteUnitCode, "USDT");
  assert.equal(report.symbols[1].quoteAsset, "IRT");
  assert.equal(report.symbols[1].quoteUnitCode, "IRT_UNVERIFIED");
  assert.deepEqual(report.symbols[0].bidLevelCountRange, {min: 2, mean: 2, max: 2});
  assert.deepEqual(report.symbols[0].askLevelCountRange, {min: 2, mean: 2, max: 2});
  assert.deepEqual(report.symbols[0].sequenceMetadataFieldsObserved, ["U", "u"]);
  assert.equal(report.symbols[0].sequenceMetadataObserved, true);
  assert.equal(report.symbols[0].latest.bestBid, "100");
  assert.equal(report.symbols[0].latest.bestAsk, "101");
  assert.ok(Math.abs(report.symbols[0].latest.spreadBps - 99.50248756218906) < 1e-10);
  assert.equal(report.safety.apiKeyUsed, false);
  assert.equal(report.safety.placesOrders, false);
  assert.equal(report.safety.movesFunds, false);
  assert.equal(ws.closed, true);
});

test("rejects any symbol outside the documented fixed Spot research universe", async () => {
  await assert.rejects(
    captureTabdealSpotDepthWebsocket({
      symbols: ["BTCUSDT", "BOOEUSDT"],
      durationMs: 150,
      WebSocketImpl: FakeWebSocket
    }),
    /symbol_not_allowlisted/
  );
  assert.equal(TABDEAL_SPOT_DEPTH_SYMBOLS.includes("BOOEUSDT"), false);
});

test("rejects a crossed or malformed depth update rather than summarizing it", async () => {
  class CrossedWebSocket extends FakeWebSocket {
    send(message) {
      const request = JSON.parse(message);
      queueMicrotask(() => {
        this.emit("message", {data: JSON.stringify({result: null, id: request.id})});
        const topic = request.params[0];
        this.emit("message", {data: JSON.stringify({
          stream: topic,
          data: {e: "depthUpdate", E: 1_800_000_000_000, s: "BTCUSDT",
            b: [["102", "1"]], a: [["101", "1"]]}
        })});
      });
    }
  }
  await assert.rejects(
    captureTabdealSpotDepthWebsocket({
      symbols: ["BTCUSDT"],
      durationMs: 150,
      WebSocketImpl: CrossedWebSocket,
      clock: () => 1_800_000_000_010
    }),
    /no_valid_updates/
  );
});

test("fails closed when the subscription closes before the sample window", async () => {
  class EarlyCloseWebSocket extends FakeWebSocket {
    constructor(url) {
      super(url);
      queueMicrotask(() => this.emit("close", {code: 1006}));
    }
  }
  await assert.rejects(
    captureTabdealSpotDepthWebsocket({
      symbols: ["BTCUSDT"],
      durationMs: 150,
      WebSocketImpl: EarlyCloseWebSocket
    }),
    /closed_early/
  );
});
