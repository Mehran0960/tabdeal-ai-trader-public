import test from "node:test";
import assert from "node:assert/strict";
import {
  probeTabdealSpotTradeStreams,
  TABDEAL_SPOT_PUBLIC_WS_URL,
  TABDEAL_SPOT_TRADE_PROBE_TOPICS
} from "../scripts/probe-tabdeal-spot-trade-stream.mjs";

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
    const request = JSON.parse(message);
    this.sent.push(request);
    queueMicrotask(() => {
      this.emit("message", {data: JSON.stringify({result: null, id: request.id})});
      if (request.params[0] === "btcusdt@trade") {
        this.emit("message", {data: JSON.stringify({
          stream: request.params[0],
          data: {e: "trade", E: 1_800_000_000_000, T: 1_800_000_000_001,
            s: "BTCUSDT", t: 12, p: "65000.1", q: "0.01", m: false}
        })});
      }
    });
  }
  close() {
    this.closed = true;
    this.emit("close", {code: 1000});
  }
}

test("probes only public Spot trade topics and records capability metadata", async () => {
  FakeWebSocket.instances = [];
  const report = await probeTabdealSpotTradeStreams({
    durationMs: 5_000,
    WebSocketImpl: FakeWebSocket,
    clock: () => 1_800_000_000_010
  });
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, TABDEAL_SPOT_PUBLIC_WS_URL);
  assert.deepEqual(ws.sent.map(row => row.params[0]), [...TABDEAL_SPOT_TRADE_PROBE_TOPICS]);
  assert.equal(report.topics[0].messageCount, 1);
  assert.deepEqual(report.topics[0].eventTypes, ["trade"]);
  assert.deepEqual(report.topics[0].payloadKeys.sort(), ["E", "T", "e", "m", "p", "q", "s", "t"]);
  assert.equal(report.topics[0].priceFieldObserved, true);
  assert.equal(report.topics[0].quantityFieldObserved, true);
  assert.equal(report.topics[0].buyerMakerFieldObserved, true);
  assert.equal(report.topics[0].firstTradeId, "12");
  assert.equal(report.topics[1].messageCount, 0);
  assert.equal(report.topics[1].acknowledged, true);
  assert.equal(report.safety.apiKeyUsed, false);
  assert.equal(report.safety.placesOrders, false);
  assert.equal(report.safety.movesFunds, false);
  assert.equal(ws.closed, true);
});

test("records an explicit subscription error without treating it as support", async () => {
  class RejectingWebSocket extends FakeWebSocket {
    send(message) {
      const request = JSON.parse(message);
      this.sent.push(request);
      queueMicrotask(() => this.emit("message", {data: JSON.stringify({
        id: request.id,
        error: {code: -1, msg: "unknown topic"}
      })}));
    }
  }
  const report = await probeTabdealSpotTradeStreams({
    durationMs: 5_000,
    WebSocketImpl: RejectingWebSocket,
    clock: () => 1_800_000_000_010
  });
  assert.equal(report.topics[0].result, "subscription_error");
  assert.equal(report.topics[0].messageCount, 0);
  assert.equal(report.safety.apiKeyUsed, false);
});

test("rejects durations outside the bounded one-time probe window", async () => {
  await assert.rejects(
    probeTabdealSpotTradeStreams({durationMs: 1_000, WebSocketImpl: FakeWebSocket}),
    /duration_invalid/
  );
});


test("captures non-null subscription responses without falsely marking a topic acknowledged", async () => {
  class NonNullAckWebSocket extends FakeWebSocket {
    send(message) {
      const request = JSON.parse(message);
      this.sent.push(request);
      queueMicrotask(() => this.emit("message", {data: JSON.stringify({
        id: request.id,
        result: "topic_ignored"
      })}));
    }
  }
  const report = await probeTabdealSpotTradeStreams({
    durationMs: 5_000,
    WebSocketImpl: NonNullAckWebSocket,
    clock: () => 1_800_000_000_010
  });
  assert.equal(report.topics[0].acknowledged, false);
  assert.deepEqual(report.topics[0].subscriptionResponseSummary, {
    kind: "non_null_result",
    responseKeys: ["id", "result"],
    resultType: "string",
    resultValue: "topic_ignored"
  });
  assert.equal(report.topics[0].messageCount, 0);
});


test("summarizes array response object fields without retaining raw trade values", async () => {
  class ArrayResultWebSocket extends FakeWebSocket {
    send(message) {
      const request = JSON.parse(message);
      this.sent.push(request);
      queueMicrotask(() => this.emit("message", {data: JSON.stringify({
        id: request.id,
        result: [{stream: "btcusdt@trade", symbol: "BTCUSDT", e: "subscription", status: "subscribed"}]
      })}));
    }
  }
  const report = await probeTabdealSpotTradeStreams({
    durationMs: 5_000,
    WebSocketImpl: ArrayResultWebSocket,
    clock: () => 1_800_000_000_010
  });
  assert.equal(report.topics[0].subscriptionResponseSummary.resultType, "array");
  assert.deepEqual(report.topics[0].subscriptionResponseSummary.resultItemSummaries[0], {
    type: "object",
    keys: ["e", "status", "stream", "symbol"],
    safeFields: {
      stream: "btcusdt@trade",
      symbol: "BTCUSDT",
      e: "subscription",
      status: "subscribed"
    },
    priceFieldObserved: false,
    quantityFieldObserved: false,
    tradeIdFieldObserved: false
  });
});


test("records only safe public fields from a topic rejection object", async () => {
  class TopicRejectWebSocket extends FakeWebSocket {
    send(message) {
      const request = JSON.parse(message);
      this.sent.push(request);
      queueMicrotask(() => this.emit("message", {data: JSON.stringify({
        id: request.id,
        result: [{param: request.params[0], error: "unknown topic"}]
      })}));
    }
  }
  const report = await probeTabdealSpotTradeStreams({
    durationMs: 5_000,
    WebSocketImpl: TopicRejectWebSocket,
    clock: () => 1_800_000_000_010
  });
  assert.deepEqual(report.topics[0].subscriptionResponseSummary.resultItemSummaries[0].safeFields, {
    param: "btcusdt@trade",
    error: "unknown topic"
  });
  assert.equal(report.topics[0].messageCount, 0);
  assert.equal(report.topics[0].acknowledged, false);
});
