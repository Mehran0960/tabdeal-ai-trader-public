import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSignalFingerprint,
  normalizeSignal,
  scoreSignalSource,
  validateSignalSource
} from "../src/signal-intelligence.js";

const NOW = Date.parse("2026-11-28T12:00:00.000Z");

function authorizedSource(overrides = {}) {
  return {
    sourceId: "provider.alpha",
    displayName: "Provider Alpha",
    ingestionMode: "licensed_api",
    markets: ["crypto_spot", "crypto_derivatives", "equities", "etfs", "gold_funds", "commodities", "fx", "physical_gold", "fixed_income"],
    rights: {
      status: "verified",
      scopes: ["capture", "model_processing", "historical_storage", "research"],
      evidenceRef: "contract:signal-feed-2026-01",
      reviewedAt: "2026-11-28T09:00:00.000Z"
    },
    ...overrides
  };
}

function validSignal(overrides = {}) {
  return {
    market: "crypto_spot",
    instrument: {
      symbol: "BTCUSDT",
      quoteUnit: "USDT",
      venue: "TABDEAL",
      productType: "spot"
    },
    side: "LONG",
    entry: {min: "60000", max: "60100"},
    stopLoss: "59000",
    targets: [
      {label: "TP1", price: "61000"},
      {label: "TP2", price: "62000"},
      {label: "TP3", price: "63000"}
    ],
    timeframe: "4h",
    publishedAt: "2026-11-28T10:00:00.000Z",
    firstSeenAt: "2026-11-28T10:00:03.000Z",
    expiresAt: "2026-11-29T10:00:00.000Z",
    parser: {provider: "structured-extractor", model: "test-model", confidence: 0.99},
    rawContentHash: "a".repeat(64),
    ...overrides
  };
}

test("source is accepted only with verified rights, scoped uses and an approved ingestion mode", () => {
  const valid = validateSignalSource(authorizedSource(), {nowMs: NOW});
  assert.equal(valid.accepted, true);
  assert.equal(valid.source.sourceId, "provider.alpha");

  const publicScrape = validateSignalSource(authorizedSource({
    ingestionMode: "telegram_public_scrape"
  }), {nowMs: NOW});
  assert.equal(publicScrape.accepted, false);
  assert.ok(publicScrape.errors.includes("ingestion_mode_not_authorized"));

  const missingScope = validateSignalSource(authorizedSource({
    rights: {
      status: "verified",
      scopes: ["capture", "research"],
      evidenceRef: "contract:1",
      reviewedAt: "2026-11-28T09:00:00.000Z"
    }
  }), {nowMs: NOW});
  assert.equal(missingScope.accepted, false);
  assert.ok(missingScope.errors.includes("source_rights_scope_missing:model_processing"));
});

test("normalizes a fully specified licensed Spot signal without storing raw message text", () => {
  const result = normalizeSignal(validSignal(), authorizedSource(), {nowMs: NOW});
  assert.equal(result.accepted, true);
  assert.equal(result.signal.market, "crypto_spot");
  assert.equal(result.signal.side, "LONG");
  assert.deepEqual(result.signal.targets.map(target => target.label), ["TP1", "TP2", "TP3"]);
  assert.equal(result.signal.researchEligible, true);
  assert.equal(result.signal.executionEligible, false);
  assert.ok(result.signal.executionVetoes.includes("live_execution_disabled"));
  assert.equal("rawText" in result.signal, false);
  assert.equal(result.signal.rawContentHash, "a".repeat(64));
  assert.equal(result.signal.captureLagMs, 3000);
  assert.match(result.signal.fingerprint, /^[a-f0-9]{64}$/);
});

test("keeps low-confidence extractions out of research scoring and flags unsupported execution markets", () => {
  const lowConfidence = normalizeSignal(validSignal({
    parser: {provider: "structured-extractor", model: "test-model", confidence: 0.82}
  }), authorizedSource(), {nowMs: NOW});
  assert.equal(lowConfidence.accepted, true);
  assert.equal(lowConfidence.signal.researchEligible, false);
  assert.ok(lowConfidence.warnings.includes("parser_confidence_below_research_threshold"));

  const equity = normalizeSignal(validSignal({
    market: "equities",
    instrument: {symbol: "FOLD", quoteUnit: "IRT", venue: "BROKER_X", productType: "equity"}
  }), authorizedSource(), {nowMs: NOW});
  assert.equal(equity.accepted, true);
  assert.ok(equity.signal.executionVetoes.includes("no_approved_execution_adapter_for_market"));
});

test("rejects malformed, stale-at-capture and directionally inconsistent price plans", () => {
  const badStop = normalizeSignal(validSignal({stopLoss: "60500"}), authorizedSource(), {nowMs: NOW});
  assert.equal(badStop.accepted, false);
  assert.ok(badStop.errors.includes("long_stop_not_below_entry"));

  const badTargets = normalizeSignal(validSignal({
    targets: [{label: "TP1", price: "62000"}, {label: "TP2", price: "61500"}]
  }), authorizedSource(), {nowMs: NOW});
  assert.equal(badTargets.accepted, false);
  assert.ok(badTargets.errors.includes("signal_targets_invalid_or_unordered"));

  const lateCapture = normalizeSignal(validSignal({
    expiresAt: "2026-11-28T09:59:00.000Z"
  }), authorizedSource(), {nowMs: NOW});
  assert.equal(lateCapture.accepted, false);
  assert.ok(lateCapture.errors.includes("signal_expired_before_capture"));

  const badHash = normalizeSignal(validSignal({rawContentHash: "not-a-hash"}), authorizedSource(), {nowMs: NOW});
  assert.equal(badHash.accepted, false);
  assert.ok(badHash.errors.includes("raw_content_hash_invalid"));
});

test("fingerprint identifies copied plans across different sources", () => {
  const first = normalizeSignal(validSignal(), authorizedSource(), {nowMs: NOW});
  const second = normalizeSignal(validSignal(), authorizedSource({
    sourceId: "provider.beta",
    displayName: "Provider Beta"
  }), {nowMs: NOW});
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(buildSignalFingerprint(first.signal), buildSignalFingerprint(second.signal));
  assert.notEqual(first.signal.signalId, second.signal.signalId);
});

test("source scoring includes losing trades and reports drawdown and non-promotion status", () => {
  const records = [
    {firstSeenAt: "2026-11-01T00:00:00Z", outcome: {resolved: true, netR: 1}},
    {firstSeenAt: "2026-11-02T00:00:00Z", outcome: {resolved: true, netR: -0.5}},
    {firstSeenAt: "2026-11-03T00:00:00Z", outcome: {resolved: true, netR: 2}},
    {firstSeenAt: "2026-11-04T00:00:00Z", outcome: {resolved: true, netR: -1}},
    {firstSeenAt: "2026-11-05T00:00:00Z", outcome: {status: "missed"}},
    {firstSeenAt: "2026-11-06T00:00:00Z", outcome: {status: "expired_untriggered"}},
    {firstSeenAt: "2026-11-07T00:00:00Z", outcome: {status: "open"}}
  ];
  const score = scoreSignalSource(records, {minimumResolvedTrades: 4, minimumProfitFactor: 1.2});
  assert.equal(score.signalsObserved, 7);
  assert.equal(score.resolvedTrades, 4);
  assert.equal(score.noEntrySignals, 2);
  assert.equal(score.unresolvedSignals, 1);
  assert.equal(score.wins, 2);
  assert.equal(score.losses, 2);
  assert.equal(score.totalNetR, 1.5);
  assert.equal(score.expectancyR, 0.375);
  assert.equal(score.profitFactor, 2);
  assert.equal(score.maxDrawdownR, 1);
  assert.equal(score.candidateForHoldoutReview, true);
  assert.equal(score.livePromotionEligible, false);
});

test("source scoring never fabricates sample sufficiency or profit factor", () => {
  const score = scoreSignalSource([
    {outcome: {resolved: true, netR: 1}},
    {outcome: {resolved: true, netR: 2}}
  ], {minimumResolvedTrades: 100});
  assert.equal(score.candidateForHoldoutReview, false);
  assert.equal(score.profitFactor, null);
  assert.equal(score.livePromotionEligible, false);
});
