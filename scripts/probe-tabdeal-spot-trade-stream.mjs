#!/usr/bin/env node
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

export const TABDEAL_SPOT_PUBLIC_WS_URL = "wss://api1.tabdeal.org/stream/";
export const TABDEAL_SPOT_TRADE_PROBE_SYMBOL = "BTCUSDT";
export const TABDEAL_SPOT_TRADE_PROBE_TOPICS = Object.freeze([
  "btcusdt@trade",
  "btcusdt@aggTrade"
]);

function parseMessageData(raw) {
  if (typeof raw === "string") return JSON.parse(raw);
  if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8"));
  return null;
}

function eventTime(data) {
  for (const field of ["T", "E", "time", "timestamp"]) {
    const value = Number(data?.[field]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function tradeId(data) {
  for (const field of ["t", "a", "id", "tradeId", "aggTradeId"]) {
    const value = data?.[field];
    if ((typeof value === "string" || typeof value === "number") && /^\d{1,30}$/.test(String(value))) {
      try {
        const id = BigInt(String(value));
        if (id >= 0n) return id;
      } catch {}
    }
  }
  return null;
}

export async function probeTabdealSpotTradeStreams({
  durationMs = 30_000,
  connectionTimeoutMs = 15_000,
  WebSocketImpl = globalThis.WebSocket,
  clock = () => Date.now()
} = {}) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 5_000 || durationMs > 120_000) {
    throw new Error("tabdeal_spot_trade_probe_duration_invalid");
  }
  if (typeof WebSocketImpl !== "function") {
    throw new Error("tabdeal_spot_trade_probe_websocket_unavailable");
  }

  const topics = TABDEAL_SPOT_TRADE_PROBE_TOPICS.map((topic, index) => ({
    topic,
    id: index + 1,
    acknowledged: false,
    subscriptionResponseSummary: null,
    messages: 0,
    malformedMessages: 0,
    ignoredMessages: 0,
    eventTypes: new Set(),
    payloadKeys: new Set(),
    firstEventTimeMs: null,
    lastEventTimeMs: null,
    firstTradeId: null,
    lastTradeId: null,
    previousTradeId: null,
    duplicateTradeIds: 0,
    nonIncreasingTradeIds: 0,
    tradeIdSamples: 0,
    priceFieldObserved: false,
    quantityFieldObserved: false,
    buyerMakerFieldObserved: false
  }));
  const topicByName = new Map(topics.map(row => [row.topic, row]));
  const topicById = new Map(topics.map(row => [row.id, row]));
  const errors = [];
  const startedAtMs = clock();
  if (!Number.isFinite(startedAtMs)) throw new Error("tabdeal_spot_trade_probe_clock_invalid");

  return new Promise((resolve, reject) => {
    let ws;
    let opened = false;
    let finished = false;
    let connectionTimer;
    let durationTimer;
    let nonJsonMessageCount = 0;

    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(connectionTimer);
      clearTimeout(durationTimer);
      try { ws?.close(1000, "probe-complete"); } catch {}
      if (error) {
        reject(error);
        return;
      }
      const endedAtMs = clock();
      const results = topics.map(row => {
        const messages = row.messages;
        return {
          topic: row.topic,
          acknowledged: row.acknowledged,
          subscriptionResponseSummary: row.subscriptionResponseSummary,
          messageCount: messages,
          malformedMessages: row.malformedMessages,
          ignoredMessages: row.ignoredMessages,
          eventTypes: [...row.eventTypes].sort(),
          payloadKeys: [...row.payloadKeys].sort(),
          firstEventTime: row.firstEventTimeMs ? new Date(row.firstEventTimeMs).toISOString() : null,
          lastEventTime: row.lastEventTimeMs ? new Date(row.lastEventTimeMs).toISOString() : null,
          firstTradeId: row.firstTradeId === null ? null : row.firstTradeId.toString(),
          lastTradeId: row.lastTradeId === null ? null : row.lastTradeId.toString(),
          tradeIdSamples: row.tradeIdSamples,
          duplicateTradeIds: row.duplicateTradeIds,
          nonIncreasingTradeIds: row.nonIncreasingTradeIds,
          priceFieldObserved: row.priceFieldObserved,
          quantityFieldObserved: row.quantityFieldObserved,
          buyerMakerFieldObserved: row.buyerMakerFieldObserved,
          result: messages > 0 ? "trade_messages_observed"
            : row.acknowledged ? "acknowledged_but_no_trade_messages_observed"
            : errors.some(item => item.topic === row.topic) ? "subscription_error"
            : "no_acknowledgement_or_trade_messages"
        };
      });
      resolve({
        schemaVersion: 1,
        provider: "TABDEAL_SPOT_WS_CAPABILITY_PROBE",
        websocketUrl: TABDEAL_SPOT_PUBLIC_WS_URL,
        symbol: TABDEAL_SPOT_TRADE_PROBE_SYMBOL,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: endedAtMs - startedAtMs,
        topics: results,
        errors,
        nonJsonMessageCount,
        conclusion: results.some(row => row.messageCount > 0)
          ? "one_or_more_undocumented_spot_trade_topics_emitted_messages"
          : "no_spot_trade_messages_observed_in_probe_window_not_proof_of_absence",
        safety: {
          publicWebsocketOnly: true,
          apiKeyUsed: false,
          apiSecretUsed: false,
          authenticatedAccountAccess: false,
          privateEndpointsUsed: false,
          placesOrders: false,
          cancelsOrders: false,
          movesFunds: false,
          liveTradingEnabled: false
        },
        caveats: [
          "The tested topics are not documented in the currently reviewed official Spot WebSocket documentation.",
          "A positive observation does not establish a supported or stable API contract.",
          "A negative observation during a short probe does not prove the topic does not exist.",
          "No raw trade payloads or account information are retained."
        ]
      });
    };

    try {
      ws = new WebSocketImpl(TABDEAL_SPOT_PUBLIC_WS_URL);
    } catch {
      reject(new Error("tabdeal_spot_trade_probe_connect_failed"));
      return;
    }

    connectionTimer = setTimeout(() => {
      finish(new Error("tabdeal_spot_trade_probe_open_timeout"));
    }, connectionTimeoutMs);
    durationTimer = setTimeout(() => {
      if (!opened) finish(new Error("tabdeal_spot_trade_probe_not_open"));
      else finish();
    }, durationMs);

    ws.addEventListener("open", () => {
      if (finished) return;
      opened = true;
      clearTimeout(connectionTimer);
      for (const row of topics) {
        try {
          ws.send(JSON.stringify({method: "SUBSCRIBE", params: [row.topic], id: row.id}));
        } catch {
          finish(new Error("tabdeal_spot_trade_probe_subscribe_send_failed"));
          return;
        }
      }
    });

    ws.addEventListener("message", event => {
      if (finished) return;
      let parsed;
      try {
        parsed = parseMessageData(event?.data);
      } catch {
        nonJsonMessageCount++;
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        nonJsonMessageCount++;
        return;
      }

      if (Number.isSafeInteger(parsed.id) && topicById.has(parsed.id)) {
        const row = topicById.get(parsed.id);
        if (parsed.error && typeof parsed.error === "object") {
          const errorCode = Number(parsed.error.code);
          const errorMessage = String(parsed.error.msg || parsed.error.message || "subscription_rejected").slice(0, 160);
          row.subscriptionResponseSummary = {
            kind: "error",
            responseKeys: Object.keys(parsed).sort(),
            errorKeys: Object.keys(parsed.error).sort(),
            code: Number.isFinite(errorCode) ? errorCode : null,
            message: errorMessage
          };
          errors.push({topic: row.topic, code: row.subscriptionResponseSummary.code, message: errorMessage});
        } else if (parsed.result === null) {
          row.acknowledged = true;
          row.subscriptionResponseSummary = {kind: "null_acknowledgement", responseKeys: Object.keys(parsed).sort()};
        } else {
          const result = parsed.result;
          const summary = {
            kind: "non_null_result",
            responseKeys: Object.keys(parsed).sort(),
            resultType: Array.isArray(result) ? "array" : typeof result
          };
          if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") {
            summary.resultValue = String(result).slice(0, 120);
          } else if (Array.isArray(result)) {
            summary.resultLength = result.length;
            summary.resultItemTypes = [...new Set(result.slice(0, 10).map(value => Array.isArray(value) ? "array" : value === null ? "null" : typeof value))];
            summary.resultItemSummaries = result.slice(0, 5).map(value => {
              if (!value || typeof value !== "object" || Array.isArray(value)) {
                return {type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value};
              }
              const safeFields = {};
              for (const key of ["stream", "symbol", "s", "topic", "channel", "event", "e", "eventType", "type", "status", "code", "message", "msg", "param", "error"]) {
                if (["string", "number", "boolean"].includes(typeof value[key])) {
                  safeFields[key] = String(value[key]).slice(0, 100);
                }
              }
              if (value.error && typeof value.error === "object") {
                safeFields.errorSummary = {
                  keys: Object.keys(value.error).sort().slice(0, 20),
                  code: Number.isFinite(Number(value.error.code)) ? Number(value.error.code) : null,
                  message: String(value.error.msg || value.error.message || "").slice(0, 120)
                };
              }
              return {
                type: "object",
                keys: Object.keys(value).sort().slice(0, 40),
                safeFields,
                priceFieldObserved: Object.hasOwn(value, "p") || Object.hasOwn(value, "price"),
                quantityFieldObserved: Object.hasOwn(value, "q") || Object.hasOwn(value, "qty"),
                tradeIdFieldObserved: ["t", "a", "id", "tradeId"].some(key => Object.hasOwn(value, key))
              };
            });
          } else if (result && typeof result === "object") {
            summary.resultKeys = Object.keys(result).sort().slice(0, 30);
            summary.resultSafeFields = {};
            for (const key of ["stream", "symbol", "s", "topic", "channel", "event", "e", "eventType", "type", "status", "code", "message", "msg"]) {
              if (["string", "number", "boolean"].includes(typeof result[key])) {
                summary.resultSafeFields[key] = String(result[key]).slice(0, 100);
              }
            }
          }
          row.subscriptionResponseSummary = summary;
          row.ignoredMessages++;
        }
        return;
      }

      if (typeof parsed.stream !== "string") {
        nonJsonMessageCount++;
        return;
      }
      const row = topicByName.get(parsed.stream.toLowerCase());
      if (!row) {
        nonJsonMessageCount++;
        return;
      }

      const data = typeof parsed.data === "string"
        ? (() => { try { return JSON.parse(parsed.data); } catch { return null; } })()
        : parsed.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        row.malformedMessages++;
        return;
      }

      row.messages++;
      if (typeof data.e === "string") row.eventTypes.add(data.e);
      for (const key of Object.keys(data)) row.payloadKeys.add(key);
      const timestamp = eventTime(data);
      if (timestamp !== null) {
        row.firstEventTimeMs = row.firstEventTimeMs === null ? timestamp : Math.min(row.firstEventTimeMs, timestamp);
        row.lastEventTimeMs = row.lastEventTimeMs === null ? timestamp : Math.max(row.lastEventTimeMs, timestamp);
      }
      const id = tradeId(data);
      if (id !== null) {
        row.tradeIdSamples++;
        if (row.firstTradeId === null) row.firstTradeId = id;
        if (row.previousTradeId !== null) {
          if (id === row.previousTradeId) row.duplicateTradeIds++;
          if (id <= row.previousTradeId) row.nonIncreasingTradeIds++;
        }
        row.previousTradeId = id;
        row.lastTradeId = id;
      }
      row.priceFieldObserved ||= Object.hasOwn(data, "p") || Object.hasOwn(data, "price");
      row.quantityFieldObserved ||= Object.hasOwn(data, "q") || Object.hasOwn(data, "qty");
      row.buyerMakerFieldObserved ||= Object.hasOwn(data, "m") || Object.hasOwn(data, "isBuyerMaker");
    });

    ws.addEventListener("error", () => {
      finish(new Error("tabdeal_spot_trade_probe_websocket_error"));
    });
    ws.addEventListener("close", () => {
      if (!finished) finish(new Error("tabdeal_spot_trade_probe_closed_early"));
    });
  });
}

async function main() {
  const durationMs = Number(process.env.TABDEAL_SPOT_TRADE_PROBE_DURATION_MS || 30_000);
  const report = await probeTabdealSpotTradeStreams({durationMs});
  const outputPath = path.join("artifacts", "tabdeal-spot-trade-probe", "latest.json");
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log("TABDEAL_SPOT_TRADE_STREAM_PROBE_COMPLETE");
  console.log(JSON.stringify({
    symbol: report.symbol,
    durationMs: report.durationMs,
    conclusion: report.conclusion,
    topics: report.topics,
    errors: report.errors,
    nonJsonMessageCount: report.nonJsonMessageCount,
    publicWebsocketOnly: report.safety.publicWebsocketOnly,
    apiKeyUsed: report.safety.apiKeyUsed,
    ordersPlaced: 0,
    outputPath
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error("TABDEAL_SPOT_TRADE_STREAM_PROBE_FAILED");
    console.error(String(error?.message || error).slice(0, 180));
    process.exitCode = 1;
  });
}
