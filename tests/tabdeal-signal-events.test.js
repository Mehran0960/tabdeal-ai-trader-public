import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchTabdealSignalEvents,
  parseTabdealSignalPageHtml
} from "../src/tabdeal-signal-events.js";

function makeHtml({events = null, totalCount = 1, pages = 1, renderedAt = 1_800_000_000_000} = {}) {
  const graph = [
    ["ShallowReactive", 1],
    {prerenderedAt: 2, data: 3},
    renderedAt,
    ["ShallowReactive", 4],
    {"/crypto-price/signal": 5},
    {marketEventsData: 6},
    ["Reactive", 7],
    {number_of_pages: 8, count: 9, results: 10},
    pages,
    totalCount,
    events ?? [11],
    {
      symbol: 12,
      event_type: 13,
      current_price: 14,
      time: 15,
      detail: 16,
      detail_is_percentage: 17,
      markets: 18,
      swappable: 19,
      dexable: 20,
      slug: 21
    },
    "BTC",
    "CROSS_MA_20_AND_50_INCREASING",
    "67400.5",
    "1405-09-04 12:00",
    "67000.0",
    false,
    [22],
    true,
    false,
    "btc",
    "BTC_USDT"
  ];
  return `<html><script id="__NUXT_DATA__" type="application/json">${JSON.stringify(graph)}</script></html>`;
}

test("parses only public market event rows from the Nuxt payload", () => {
  const now = 1_800_000_060_000;
  const report = parseTabdealSignalPageHtml(makeHtml({renderedAt: now - 10_000}), {nowMs: now});
  assert.equal(report.provider, "TABDEAL_SIGNAL_PAGE");
  assert.equal(report.sourceFreshness, "fresh_under_5m");
  assert.equal(report.pagination.totalEventCount, 1);
  assert.equal(report.pagination.rowsReturned, 1);
  assert.equal(report.pagination.allPagesCaptured, true);
  assert.equal(report.events[0].symbol, "BTC");
  assert.equal(report.events[0].eventType, "CROSS_MA_20_AND_50_INCREASING");
  assert.equal(report.events[0].markets[0], "BTC_USDT");
  assert.equal(report.events[0].hasSpotMarket, true);
  assert.equal(report.safety.userCommentsCaptured, false);
  assert.equal(report.safety.userTradeLeaderboardCaptured, false);
  assert.equal(report.safety.apiCredentialsUsed, false);
  assert.equal(report.safety.orderSubmissionAttempted, false);
});

test("marks first-page-only data as incomplete rather than inventing full coverage", () => {
  const report = parseTabdealSignalPageHtml(makeHtml({totalCount: 14, pages: 2}), {nowMs: 1_800_000_060_000});
  assert.equal(report.pagination.totalEventCount, 14);
  assert.equal(report.pagination.rowsReturned, 1);
  assert.equal(report.pagination.numberOfPages, 2);
  assert.equal(report.pagination.firstPageOnly, true);
  assert.equal(report.pagination.allPagesCaptured, false);
});

test("rejects malformed or unsafe event rows", () => {
  const invalid = makeHtml({events: [11], totalCount: 1});
  const graph = JSON.parse(invalid.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
  graph[11].symbol = 12;
  graph[12] = "BTC<script>";
  const html = `<script id="__NUXT_DATA__">${JSON.stringify(graph)}</script>`;
  assert.throws(() => parseTabdealSignalPageHtml(html, {nowMs: 1_800_000_060_000}), /no_valid_events/);
});

test("fails closed when the public page structure changes", () => {
  assert.throws(() => parseTabdealSignalPageHtml("<html>no nuxt payload but this intentionally long fixture exceeds the initial minimum length required to reach the Nuxt script lookup safely</html>"), /nuxt_payload_missing/);
  assert.throws(() => parseTabdealSignalPageHtml("x"), /html_invalid/);
});

test("fetches the public signal page using GET only and no credentials", async () => {
  const html = makeHtml({renderedAt: 1_800_000_050_000});
  const calls = [];
  const report = await fetchTabdealSignalEvents({
    clock: () => 1_800_000_060_000,
    fetchImpl: async (url, options) => {
      calls.push({url: String(url), method: options.method, headers: options.headers});
      return {ok: true, status: 200, text: async () => html};
    }
  });
  assert.equal(report.events.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(Object.keys(calls[0].headers).some(key => /authorization|api-key|api-secret/i.test(key)), false);
});

test("classifies delayed and stale server-rendered signals separately", () => {
  const now = 1_800_000_060_000;
  const delayed = parseTabdealSignalPageHtml(makeHtml({renderedAt: now - 30 * 60_000}), {nowMs: now});
  const stale = parseTabdealSignalPageHtml(makeHtml({renderedAt: now - 10 * 60 * 60_000}), {nowMs: now});
  assert.equal(delayed.sourceFreshness, "delayed_5m_to_60m");
  assert.equal(stale.sourceFreshness, "stale_over_60m");
});
