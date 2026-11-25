import {createHash} from "node:crypto";

export const TABDEAL_SIGNAL_PAGE_URL = "https://tabdeal.org/crypto-price/signal";
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_GRAPH_NODES = 100_000;
const MAX_EVENTS = 500;
const FRESH_SOURCE_AGE_MS = 5 * 60 * 1000;
const STALE_SOURCE_AGE_MS = 60 * 60 * 1000;
const WRAPPER_TAGS = new Set([
  "ShallowReactive", "Reactive", "Ref", "ShallowRef", "ComputedRef",
  "ReadonlyRef", "ReadonlyReactive"
]);
const SPECIAL_TAGS = new Set([
  "Date", "Set", "Map", "BigInt", "null", "undefined", "NaN",
  "Infinity", "-Infinity", "-0"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, maxLength = 160) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function positiveDecimalString(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? normalized : null;
}

function decodeNuxtGraph(graph) {
  if (!Array.isArray(graph) || graph.length < 8 || graph.length > MAX_GRAPH_NODES) {
    throw new Error("tabdeal_signal_nuxt_graph_invalid");
  }

  const cache = new Map();
  const active = new Set();

  function dereference(value, depth) {
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return decodeIndex(value, depth + 1);
    }
    return value;
  }

  function decodeIndex(index, depth = 0) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= graph.length) {
      throw new Error("tabdeal_signal_nuxt_reference_invalid");
    }
    if (depth > 100) throw new Error("tabdeal_signal_nuxt_depth_exceeded");
    if (cache.has(index)) return cache.get(index);
    if (active.has(index)) throw new Error("tabdeal_signal_nuxt_cycle_unsupported");

    const node = graph[index];
    active.add(index);
    let result;

    if (Array.isArray(node)) {
      const tag = typeof node[0] === "string" ? node[0] : null;
      if (tag && WRAPPER_TAGS.has(tag)) {
        if (node.length !== 2) throw new Error("tabdeal_signal_nuxt_wrapper_invalid");
        result = dereference(node[1], depth);
      } else if (tag && SPECIAL_TAGS.has(tag)) {
        if (tag === "Date") {
          const dateValue = dereference(node[1], depth);
          const date = new Date(dateValue);
          if (!Number.isFinite(date.getTime())) throw new Error("tabdeal_signal_nuxt_date_invalid");
          result = date.toISOString();
        } else if (tag === "Set") {
          const values = node.length > 1 ? dereference(node[1], depth) : [];
          result = new Set(Array.isArray(values) ? values : []);
        } else if (tag === "Map") {
          const values = node.length > 1 ? dereference(node[1], depth) : [];
          result = new Map(Array.isArray(values) ? values : []);
        } else if (tag === "BigInt") {
          result = BigInt(dereference(node[1], depth));
        } else {
          const special = {
            null: null,
            undefined: undefined,
            NaN,
            Infinity,
            "-Infinity": -Infinity,
            "-0": -0
          };
          result = special[tag];
        }
      } else {
        result = [];
        cache.set(index, result);
        for (const item of node) result.push(dereference(item, depth));
      }
    } else if (isRecord(node)) {
      result = Object.create(null);
      cache.set(index, result);
      for (const [key, value] of Object.entries(node)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error("tabdeal_signal_nuxt_unsafe_key");
        }
        result[key] = dereference(value, depth);
      }
    } else {
      result = node;
    }

    cache.set(index, result);
    active.delete(index);
    return result;
  }

  function unwrapIndex(index) {
    for (let depth = 0; depth < 10; depth++) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= graph.length) {
        throw new Error("tabdeal_signal_nuxt_reference_invalid");
      }
      const node = graph[index];
      if (Array.isArray(node) && typeof node[0] === "string" && WRAPPER_TAGS.has(node[0])) {
        if (node.length !== 2) throw new Error("tabdeal_signal_nuxt_wrapper_invalid");
        index = node[1];
        continue;
      }
      return index;
    }
    throw new Error("tabdeal_signal_nuxt_wrapper_depth_exceeded");
  }

  const rootNode = graph[1];
  if (!isRecord(rootNode)) throw new Error("tabdeal_signal_nuxt_root_invalid");
  const prerenderedAt = decodeIndex(rootNode.prerenderedAt);
  const dataNode = graph[unwrapIndex(rootNode.data)];
  if (!isRecord(dataNode)) throw new Error("tabdeal_signal_nuxt_data_invalid");
  const pageNode = graph[unwrapIndex(dataNode["/crypto-price/signal"])];
  if (!isRecord(pageNode)) throw new Error("tabdeal_signal_nuxt_signal_page_invalid");
  const marketEventsData = decodeIndex(unwrapIndex(pageNode.marketEventsData));

  return {prerenderedAt, marketEventsData};
}

function normalizeEvent(raw) {
  if (!isRecord(raw)) return null;
  const symbol = cleanText(raw.symbol, 24)?.toUpperCase();
  const eventType = cleanText(raw.event_type, 80)?.toUpperCase();
  const eventTime = cleanText(raw.time, 32);
  const currentPrice = positiveDecimalString(raw.current_price);
  if (!symbol || !/^[A-Z0-9]{2,20}$/.test(symbol)) return null;
  if (!eventType || !/^[A-Z][A-Z0-9_]{2,79}$/.test(eventType)) return null;
  if (!eventTime || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(eventTime)) return null;
  if (!currentPrice) return null;

  const rawMarkets = Array.isArray(raw.markets) ? raw.markets : [];
  const markets = [...new Set(rawMarkets
    .map(value => cleanText(value, 32)?.toUpperCase())
    .filter(value => value && /^[A-Z0-9]{2,20}_(?:IRT|USDT)$/.test(value)))];

  const detail = raw.detail === null || raw.detail === undefined
    ? null
    : cleanText(String(raw.detail), 80);
  const detailIsPercentage = raw.detail_is_percentage === true;
  const event = {
    symbol,
    eventType,
    eventTimeSource: eventTime,
    currentPrice,
    detail,
    detailIsPercentage,
    markets,
    hasSpotMarket: markets.length > 0,
    supportsInstantSwap: raw.swappable === true,
    dexOnlyFlag: raw.dexable === true,
    slug: cleanText(raw.slug, 48)
  };
  event.eventKey = [symbol, eventType, eventTime, detail ?? ""].join("|");
  return event;
}

export function parseTabdealSignalPageHtml(html, {nowMs = Date.now()} = {}) {
  if (typeof html !== "string" || html.length < 100 || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    throw new Error("tabdeal_signal_html_invalid_or_too_large");
  }
  const match = html.match(/<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error("tabdeal_signal_nuxt_payload_missing");

  let graph;
  try {
    graph = JSON.parse(match[1]);
  } catch {
    throw new Error("tabdeal_signal_nuxt_json_invalid");
  }
  const root = decodeNuxtGraph(graph);
  const marketEvents = root?.marketEventsData;
  if (!isRecord(marketEvents) || !Array.isArray(marketEvents.results)) {
    throw new Error("tabdeal_signal_event_data_missing");
  }

  const prerenderedAtMs = Number(root.prerenderedAt);
  if (!Number.isFinite(prerenderedAtMs) || prerenderedAtMs <= 0) {
    throw new Error("tabdeal_signal_render_timestamp_invalid");
  }
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error("tabdeal_signal_clock_invalid");
  if (marketEvents.results.length > MAX_EVENTS) throw new Error("tabdeal_signal_event_count_exceeded");

  const events = marketEvents.results.map(normalizeEvent).filter(Boolean);
  const totalEventCount = Number(marketEvents.count);
  const numberOfPages = Number(marketEvents.number_of_pages);
  if (!Number.isSafeInteger(totalEventCount) || totalEventCount < events.length || totalEventCount > 10_000) {
    throw new Error("tabdeal_signal_total_count_invalid");
  }
  if (!Number.isSafeInteger(numberOfPages) || numberOfPages < 1 || numberOfPages > 1_000) {
    throw new Error("tabdeal_signal_page_count_invalid");
  }
  if (events.length === 0 && totalEventCount > 0) throw new Error("tabdeal_signal_no_valid_events");

  const sourceAgeMs = nowMs - prerenderedAtMs;
  const capturedAt = new Date(nowMs).toISOString();
  const sourceRenderedAt = new Date(prerenderedAtMs).toISOString();
  const sourceFreshness = sourceAgeMs < 0
    ? "future_render_timestamp"
    : sourceAgeMs <= FRESH_SOURCE_AGE_MS ? "fresh_under_5m"
    : sourceAgeMs <= STALE_SOURCE_AGE_MS ? "delayed_5m_to_60m"
    : "stale_over_60m";
  const snapshotId = createHash("sha256")
    .update(JSON.stringify({sourceRenderedAt, events, totalEventCount, sourceFreshness}))
    .digest("hex");

  return {
    schemaVersion: 1,
    provider: "TABDEAL_SIGNAL_PAGE",
    sourceUrl: TABDEAL_SIGNAL_PAGE_URL,
    capturedAt,
    sourceRenderedAt,
    sourceAgeMs,
    sourceFreshness,
    pagination: {
      totalEventCount,
      numberOfPages,
      rowsReturned: events.length,
      allPagesCaptured: events.length >= totalEventCount,
      firstPageOnly: events.length < totalEventCount
    },
    events,
    snapshotId,
    safety: {
      publicPageOnly: true,
      authenticatedAccountAccess: false,
      userCommentsCaptured: false,
      userTradeLeaderboardCaptured: false,
      apiCredentialsUsed: false,
      orderSubmissionAttempted: false,
      fundsMoved: false
    }
  };
}

export async function fetchTabdealSignalEvents({
  fetchImpl = fetch,
  clock = () => Date.now(),
  timeoutMs = 15_000,
  url = TABDEAL_SIGNAL_PAGE_URL
} = {}) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Tabdeal-AI-Trader-Public-Research/0.1"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response?.ok) throw new Error("tabdeal_signal_http_" + (response?.status ?? 0));
  const html = await response.text();
  return parseTabdealSignalPageHtml(html, {nowMs: clock()});
}
