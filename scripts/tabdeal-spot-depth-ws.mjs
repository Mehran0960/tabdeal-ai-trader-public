#!/usr/bin/env node
import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

export const TABDEAL_SPOT_DEPTH_WS_URL = "wss://api1.tabdeal.org/stream/";
export const TABDEAL_SPOT_DEPTH_SYMBOLS = Object.freeze([
  "BTCIRT", "BTCUSDT",
  "ETHIRT", "ETHUSDT",
  "SOLIRT", "SOLUSDT",
  "XRPIRT", "XRPUSDT",
  "DOGEIRT", "DOGEUSDT"
]);

const DEFAULT_DURATION_MS = 60_000;
const MAX_DURATION_MS = 300_000;
const MAX_BOOK_LEVELS = 100;

function isPositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function normalizeSide(rows, descending) {
  if (!Array.isArray(rows) || rows.length > MAX_BOOK_LEVELS) return null;
  const parsed = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) return null;
    const price = Number(row[0]);
    const quantity = Number(row[1]);
    if (!isPositive(price) || !Number.isFinite(quantity) || quantity < 0) return null;
    if (quantity > 0) parsed.push({price, quantity});
  }
  parsed.sort((a, b) => descending ? b.price - a.price : a.price - b.price);
  return parsed;
}

function summarizeDepthMessage(message, expectedSymbol, receivedAtMs) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  if (String(message.s || "").toUpperCase() !== expectedSymbol) return null;
  if (message.e !== "depthUpdate") return null;
  const eventTimeMs = Number(message.E);
  if (!Number.isSafeInteger(eventTimeMs) || eventTimeMs <= 0) return null;

  const bids = normalizeSide(message.b, true);
  const asks = normalizeSide(message.a, false);
  if (!bids?.length || !asks?.length) return null;

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  if (!(bestAsk > bestBid)) return null;

  const bidDepthTop5Quote = bids.slice(0, 5).reduce((sum, row) => sum + row.price * row.quantity, 0);
  const askDepthTop5Quote = asks.slice(0, 5).reduce((sum, row) => sum + row.price * row.quantity, 0);
  const depthTotal = bidDepthTop5Quote + askDepthTop5Quote;
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / midPrice) * 10_000;
  const imbalance = depthTotal > 0 ? (bidDepthTop5Quote - askDepthTop5Quote) / depthTotal : 0;

  if (![bidDepthTop5Quote, askDepthTop5Quote, spreadBps, imbalance].every(Number.isFinite)) return null;

  return {
    symbol: expectedSymbol,
    eventTimeMs,
    receivedAtMs,
    eventLagMs: receivedAtMs - eventTimeMs,
    bestBid: String(bestBid),
    bestAsk: String(bestAsk),
    midPrice: String(midPrice),
    spreadBps,
    bidDepthTop5Quote,
    askDepthTop5Quote,
    imbalance,
    bidLevelCount: bids.length,
    askLevelCount: asks.length
  };
}

function createAccumulator(symbol) {
  const quoteAsset = symbol.endsWith("IRT") ? "IRT" : "USDT";
  return {
    symbol,
    quoteAsset,
    quoteUnitCode: quoteAsset === "IRT" ? "IRT_UNVERIFIED" : "USDT",
    updateCount: 0,
    firstEventTimeMs: null,
    lastEventTimeMs: null,
    minSpreadBps: null,
    maxSpreadBps: null,
    spreadBpsSum: 0,
    bidDepthTop5QuoteSum: 0,
    askDepthTop5QuoteSum: 0,
    imbalanceSum: 0,
    eventLagMsSum: 0,
    maxAbsoluteEventLagMs: 0,
    latest: null
  };
}

function accumulate(state, row) {
  state.updateCount++;
  state.firstEventTimeMs = state.firstEventTimeMs === null
    ? row.eventTimeMs : Math.min(state.firstEventTimeMs, row.eventTimeMs);
  state.lastEventTimeMs = state.lastEventTimeMs === null
    ? row.eventTimeMs : Math.max(state.lastEventTimeMs, row.eventTimeMs);
  state.minSpreadBps = state.minSpreadBps === null ? row.spreadBps : Math.min(state.minSpreadBps, row.spreadBps);
  state.maxSpreadBps = state.maxSpreadBps === null ? row.spreadBps : Math.max(state.maxSpreadBps, row.spreadBps);
  state.spreadBpsSum += row.spreadBps;
  state.bidDepthTop5QuoteSum += row.bidDepthTop5Quote;
  state.askDepthTop5QuoteSum += row.askDepthTop5Quote;
  state.imbalanceSum += row.imbalance;
  state.eventLagMsSum += row.eventLagMs;
  state.maxAbsoluteEventLagMs = Math.max(state.maxAbsoluteEventLagMs, Math.abs(row.eventLagMs));
  state.latest = {
    eventTimeMs: row.eventTimeMs,
    bestBid: row.bestBid,
    bestAsk: row.bestAsk,
    midPrice: row.midPrice,
    spreadBps: row.spreadBps,
    bidDepthTop5Quote: row.bidDepthTop5Quote,
    askDepthTop5Quote: row.askDepthTop5Quote,
    imbalance: row.imbalance,
    eventLagMs: row.eventLagMs
  };
}

function finalizeAccumulator(state) {
  const n = state.updateCount;
  if (!n) return state;
  return {
    symbol: state.symbol,
    quoteAsset: state.quoteAsset,
    quoteUnitCode: state.quoteUnitCode,
    updateCount: n,
    firstEventTime: new Date(state.firstEventTimeMs).toISOString(),
    lastEventTime: new Date(state.lastEventTimeMs).toISOString(),
    minSpreadBps: state.minSpreadBps,
    meanSpreadBps: state.spreadBpsSum / n,
    maxSpreadBps: state.maxSpreadBps,
    meanBidDepthTop5Quote: state.bidDepthTop5QuoteSum / n,
    meanAskDepthTop5Quote: state.askDepthTop5QuoteSum / n,
    meanTop5Imbalance: state.imbalanceSum / n,
    meanEventLagMs: state.eventLagMsSum / n,
    maxAbsoluteEventLagMs: state.maxAbsoluteEventLagMs,
    latest: state.latest
  };
}

export async function captureTabdealSpotDepthWebsocket({
  symbols = TABDEAL_SPOT_DEPTH_SYMBOLS,
  durationMs = DEFAULT_DURATION_MS,
  WebSocketImpl = globalThis.WebSocket,
  clock = () => Date.now(),
  connectionTimeoutMs = 15_000
} = {}) {
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > TABDEAL_SPOT_DEPTH_SYMBOLS.length) {
    throw new Error("tabdeal_spot_depth_symbols_invalid");
  }
  const normalized = [...new Set(symbols.map(value => String(value).trim().toUpperCase()))];
  if (normalized.length !== symbols.length ||
      normalized.some(symbol => !TABDEAL_SPOT_DEPTH_SYMBOLS.includes(symbol))) {
    throw new Error("tabdeal_spot_depth_symbol_not_allowlisted");
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > MAX_DURATION_MS) {
    throw new Error("tabdeal_spot_depth_duration_invalid");
  }
  if (typeof WebSocketImpl !== "function") {
    throw new Error("tabdeal_spot_depth_websocket_unavailable");
  }

  const states = new Map(normalized.map(symbol => [symbol, createAccumulator(symbol)]));
  const topicToSymbol = new Map(normalized.map(symbol => [
    symbol.toLowerCase() + "@depth@2000ms", symbol
  ]));
  const startedAtMs = clock();
  if (!Number.isFinite(startedAtMs)) throw new Error("tabdeal_spot_depth_clock_invalid");

  return new Promise((resolve, reject) => {
    let ws;
    let finished = false;
    let opened = false;
    let subscriptionAcknowledged = false;
    let invalidMessageCount = 0;
    let ignoredMessageCount = 0;
    let receivedMessageCount = 0;
    let timeoutHandle;
    let connectionHandle;

    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      clearTimeout(connectionHandle);
      try { ws?.close(1000, "sample-complete"); } catch {}
      if (error) {
        reject(error);
        return;
      }

      const endedAtMs = clock();
      const symbols = [...states.values()].map(finalizeAccumulator);
      const symbolsWithUpdates = symbols.filter(row => row.updateCount > 0).length;
      if (symbolsWithUpdates === 0) {
        reject(new Error("tabdeal_spot_depth_no_valid_updates"));
        return;
      }
      const payload = {
        schemaVersion: 1,
        provider: "TABDEAL_SPOT_DEPTH_WEBSOCKET",
        websocketUrl: TABDEAL_SPOT_DEPTH_WS_URL,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: endedAtMs - startedAtMs,
        updateIntervalMs: 2000,
        requestedSymbols: normalized,
        subscriptionAcknowledged,
        symbols,
        summary: {
          requestedSymbolCount: normalized.length,
          symbolsWithUpdates,
          symbolsWithoutUpdates: symbols.filter(row => row.updateCount === 0).map(row => row.symbol),
          receivedMessageCount,
          invalidMessageCount,
          ignoredMessageCount
        },
        methodology: {
          source: "official public Spot market WebSocket",
          topic: "symbol@depth@2000ms",
          aggregation: "online summaries of best bid/ask, top-five quote depth, spread and imbalance; raw depth messages are not retained",
          tradingUse: "microstructure diagnostics only; not a standalone entry or exit signal"
        },
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
        }
      };
      const digestBody = JSON.stringify({
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
        requestedSymbols: payload.requestedSymbols,
        symbols: payload.symbols
      });
      payload.snapshotId = createHash("sha256").update(digestBody).digest("hex");
      resolve(payload);
    };

    try {
      ws = new WebSocketImpl(TABDEAL_SPOT_DEPTH_WS_URL);
    } catch {
      reject(new Error("tabdeal_spot_depth_websocket_connect_failed"));
      return;
    }

    connectionHandle = setTimeout(() => {
      finish(new Error("tabdeal_spot_depth_websocket_open_timeout"));
    }, connectionTimeoutMs);
    timeoutHandle = setTimeout(() => {
      if (!opened) finish(new Error("tabdeal_spot_depth_websocket_not_open"));
      else finish();
    }, durationMs);

    ws.addEventListener("open", () => {
      if (finished) return;
      opened = true;
      clearTimeout(connectionHandle);
      const params = normalized.map(symbol => symbol.toLowerCase() + "@depth@2000ms");
      try {
        ws.send(JSON.stringify({method: "SUBSCRIBE", params, id: 1}));
      } catch {
        finish(new Error("tabdeal_spot_depth_subscribe_send_failed"));
      }
    });

    ws.addEventListener("message", event => {
      if (finished) return;
      let raw = event?.data;
      if (typeof raw !== "string") {
        if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
        else if (raw && typeof raw.text === "function") {
          ignoredMessageCount++;
          return;
        } else raw = String(raw ?? "");
      }

      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        invalidMessageCount++;
        return;
      }
      if (parsed && parsed.id === 1) {
        if (parsed.error) {
          finish(new Error("tabdeal_spot_depth_subscription_rejected"));
          return;
        }
        if (parsed.result === null) subscriptionAcknowledged = true;
        else ignoredMessageCount++;
        return;
      }
      if (!parsed || typeof parsed !== "object" || typeof parsed.stream !== "string") {
        ignoredMessageCount++;
        return;
      }

      const symbol = topicToSymbol.get(parsed.stream.toLowerCase());
      if (!symbol) {
        ignoredMessageCount++;
        return;
      }
      receivedMessageCount++;
      const row = summarizeDepthMessage(parsed.data, symbol, clock());
      if (!row) {
        invalidMessageCount++;
        return;
      }
      accumulate(states.get(symbol), row);
    });

    ws.addEventListener("error", () => {
      finish(new Error("tabdeal_spot_depth_websocket_error"));
    });

    ws.addEventListener("close", () => {
      if (!finished) finish(new Error("tabdeal_spot_depth_websocket_closed_early"));
    });
  });
}

async function main() {
  const durationMs = Number(process.env.TABDEAL_SPOT_DEPTH_DURATION_MS || DEFAULT_DURATION_MS);
  const report = await captureTabdealSpotDepthWebsocket({durationMs});
  const outputPath = path.join("artifacts", "tabdeal-spot-depth", "latest.json");
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log("TABDEAL_PUBLIC_SPOT_DEPTH_CAPTURE_COMPLETE");
  console.log(JSON.stringify({
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    durationMs: report.durationMs,
    requestedSymbols: report.requestedSymbols,
    summary: report.summary,
    symbols: report.symbols.map(row => ({
      symbol: row.symbol,
      updateCount: row.updateCount,
      minSpreadBps: row.minSpreadBps,
      meanSpreadBps: row.meanSpreadBps,
      maxSpreadBps: row.maxSpreadBps,
      meanTop5Imbalance: row.meanTop5Imbalance,
      maxAbsoluteEventLagMs: row.maxAbsoluteEventLagMs
    })),
    publicWebsocketOnly: report.safety.publicWebsocketOnly,
    apiKeyUsed: report.safety.apiKeyUsed,
    ordersPlaced: 0,
    outputPath
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error("TABDEAL_PUBLIC_SPOT_DEPTH_CAPTURE_FAILED");
    console.error(String(error?.message || error).slice(0, 180));
    process.exitCode = 1;
  });
}
