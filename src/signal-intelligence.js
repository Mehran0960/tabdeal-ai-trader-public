import {createHash} from "node:crypto";

export const SIGNAL_SCHEMA_VERSION = 1;

export const SUPPORTED_SIGNAL_MARKETS = Object.freeze([
  "crypto_spot",
  "crypto_derivatives",
  "equities",
  "etfs",
  "gold_funds",
  "commodities",
  "fx",
  "physical_gold",
  "fixed_income"
]);

const ALLOWED_INGESTION_MODES = new Set([
  "licensed_api",
  "provider_export",
  "direct_authorized_feed",
  "user_authorized_submission"
]);
const REQUIRED_RIGHTS_SCOPES = [
  "capture",
  "model_processing",
  "historical_storage",
  "research"
];
const RESEARCH_CONFIDENCE_FLOOR = 0.95;

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

function cleanString(value, maxLength = 128) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, maxLength) : null;
}

function parseInstant(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function positiveDecimal(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? text : null;
}

function decimalNumber(value) {
  const normalized = positiveDecimal(value);
  return normalized === null ? null : Number(normalized);
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeMarket(value) {
  const market = cleanString(value, 40)?.toLowerCase();
  return SUPPORTED_SIGNAL_MARKETS.includes(market) ? market : null;
}

function normalizeTargets(targets, side) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 10) return null;
  const normalized = [];
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    if (!isRecord(target)) return null;
    const price = positiveDecimal(target.price);
    if (!price) return null;
    const label = cleanString(target.label, 12) ?? `TP${index + 1}`;
    if (label !== `TP${index + 1}`) return null;
    normalized.push({label, price});
  }
  const values = normalized.map(item => Number(item.price));
  for (let index = 1; index < values.length; index++) {
    if (side === "LONG" && values[index] <= values[index - 1]) return null;
    if (side === "SHORT" && values[index] >= values[index - 1]) return null;
  }
  return normalized;
}

export function validateSignalSource(source, {nowMs = Date.now()} = {}) {
  const errors = [];
  if (!isRecord(source)) return {accepted: false, errors: ["source_not_an_object"]};

  const sourceId = cleanString(source.sourceId, 64)?.toLowerCase();
  if (!sourceId || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(sourceId)) {
    errors.push("source_id_invalid");
  }
  if (!ALLOWED_INGESTION_MODES.has(source.ingestionMode)) {
    errors.push("ingestion_mode_not_authorized");
  }

  const markets = Array.isArray(source.markets)
    ? [...new Set(source.markets.map(normalizeMarket).filter(Boolean))]
    : [];
  if (markets.length === 0) errors.push("source_market_coverage_missing");

  const rights = source.rights;
  if (!isRecord(rights) || rights.status !== "verified") {
    errors.push("source_rights_not_verified");
  } else {
    const scopes = Array.isArray(rights.scopes) ? rights.scopes : [];
    for (const scope of REQUIRED_RIGHTS_SCOPES) {
      if (!scopes.includes(scope)) errors.push(`source_rights_scope_missing:${scope}`);
    }
    const reviewedAt = parseInstant(rights.reviewedAt);
    if (reviewedAt === null || reviewedAt > nowMs + 60_000) {
      errors.push("source_rights_review_timestamp_invalid");
    }
    if (!cleanString(rights.evidenceRef, 256)) errors.push("source_rights_evidence_missing");
  }

  if (!cleanString(source.displayName, 120)) errors.push("source_display_name_missing");

  return {
    accepted: errors.length === 0,
    errors,
    source: errors.length === 0 ? {
      sourceId,
      displayName: cleanString(source.displayName, 120),
      ingestionMode: source.ingestionMode,
      markets,
      rightsStatus: "verified",
      rightsEvidenceRef: cleanString(source.rights.evidenceRef, 256)
    } : null
  };
}

export function buildSignalFingerprint(signal) {
  if (!isRecord(signal) || !isRecord(signal.entry) || !Array.isArray(signal.targets)) {
    throw new Error("signal_fingerprint_input_invalid");
  }
  const payload = {
    market: signal.market,
    symbol: signal.instrument?.symbol,
    side: signal.side,
    quoteUnit: signal.instrument?.quoteUnit,
    entryMin: signal.entry.min,
    entryMax: signal.entry.max,
    stopLoss: signal.stopLoss,
    targets: signal.targets.map(target => target.price),
    timeframe: signal.timeframe ?? null,
    expiresAt: signal.expiresAt
  };
  return hash(JSON.stringify(payload));
}

/**
 * Normalizes structured output from a deterministic parser or AI extractor.
 * The raw message/body is never persisted; callers provide only its SHA-256 hash.
 */
export function normalizeSignal(input, source, {nowMs = Date.now()} = {}) {
  const sourceCheck = validateSignalSource(source, {nowMs});
  if (!sourceCheck.accepted) {
    return {accepted: false, errors: sourceCheck.errors, signal: null};
  }
  if (!isRecord(input)) return {accepted: false, errors: ["signal_not_an_object"], signal: null};

  const errors = [];
  const market = normalizeMarket(input.market);
  if (!market) errors.push("signal_market_unsupported");
  else if (!sourceCheck.source.markets.includes(market)) errors.push("source_not_authorized_for_market");

  const instrument = isRecord(input.instrument) ? input.instrument : {};
  const symbol = cleanString(instrument.symbol, 48)?.toUpperCase();
  const quoteUnit = cleanString(instrument.quoteUnit, 24)?.toUpperCase();
  const venue = cleanString(instrument.venue, 64);
  const productType = cleanString(instrument.productType, 32)?.toLowerCase();
  if (!symbol || !/^[A-Z0-9._:/-]{1,48}$/.test(symbol)) errors.push("instrument_symbol_invalid");
  if (!quoteUnit || !/^[A-Z0-9._/-]{1,24}$/.test(quoteUnit)) errors.push("instrument_quote_unit_invalid");
  if (!productType) errors.push("instrument_product_type_missing");

  const side = cleanString(input.side, 12)?.toUpperCase();
  if (side !== "LONG" && side !== "SHORT") errors.push("signal_side_invalid");

  const entryMin = positiveDecimal(input.entry?.min);
  const entryMax = positiveDecimal(input.entry?.max);
  if (!entryMin || !entryMax || Number(entryMin) > Number(entryMax)) {
    errors.push("signal_entry_range_invalid");
  }
  const stopLoss = positiveDecimal(input.stopLoss);
  if (!stopLoss) errors.push("signal_stop_loss_invalid");

  const targets = normalizeTargets(input.targets, side);
  if (!targets) errors.push("signal_targets_invalid_or_unordered");

  if (entryMin && entryMax && stopLoss && targets && side === "LONG") {
    if (Number(stopLoss) >= Number(entryMin)) errors.push("long_stop_not_below_entry");
    if (targets.some(target => Number(target.price) <= Number(entryMax))) errors.push("long_target_not_above_entry");
  }
  if (entryMin && entryMax && stopLoss && targets && side === "SHORT") {
    if (Number(stopLoss) <= Number(entryMax)) errors.push("short_stop_not_above_entry");
    if (targets.some(target => Number(target.price) >= Number(entryMin))) errors.push("short_target_not_below_entry");
  }

  const publishedAt = parseInstant(input.publishedAt);
  const firstSeenAt = parseInstant(input.firstSeenAt);
  const expiresAt = parseInstant(input.expiresAt);
  if (publishedAt === null) errors.push("signal_published_at_invalid");
  if (firstSeenAt === null) errors.push("signal_first_seen_at_invalid");
  if (expiresAt === null) errors.push("signal_expiry_invalid");
  if (publishedAt !== null && publishedAt > nowMs + 60_000) errors.push("signal_publication_in_future");
  if (firstSeenAt !== null && firstSeenAt > nowMs + 60_000) errors.push("signal_first_seen_in_future");
  if (publishedAt !== null && firstSeenAt !== null && firstSeenAt < publishedAt - 5 * 60_000) {
    errors.push("capture_precedes_publication");
  }
  if (firstSeenAt !== null && expiresAt !== null && expiresAt <= firstSeenAt) {
    errors.push("signal_expired_before_capture");
  }

  const timeframe = cleanString(input.timeframe, 24);
  if (!timeframe || !/^(\d+[mhdw]|intraday|swing|position)$/i.test(timeframe)) {
    errors.push("signal_timeframe_invalid");
  }

  const parser = isRecord(input.parser) ? input.parser : {};
  const hasParserConfidence = typeof parser.confidence === "number" ||
    (typeof parser.confidence === "string" && parser.confidence.trim() !== "");
  const parserConfidence = hasParserConfidence ? Number(parser.confidence) : Number.NaN;
  if (!Number.isFinite(parserConfidence) || parserConfidence < 0 || parserConfidence > 1) {
    errors.push("parser_confidence_invalid");
  }
  const rawContentHash = cleanString(input.rawContentHash, 64)?.toLowerCase();
  if (!rawContentHash || !/^[a-f0-9]{64}$/.test(rawContentHash)) {
    errors.push("raw_content_hash_invalid");
  }

  const leverage = input.leverage === undefined || input.leverage === null ? 1 : Number(input.leverage);
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 1000) errors.push("signal_leverage_invalid");

  if (errors.length > 0) return {accepted: false, errors, signal: null};

  const captureLagMs = firstSeenAt - publishedAt;
  const researchEligible = parserConfidence >= RESEARCH_CONFIDENCE_FLOOR;
  const executionVetoes = [
    "live_execution_disabled",
    "cross_market_execution_adapter_not_implemented"
  ];
  if (market !== "crypto_spot") executionVetoes.push("no_approved_execution_adapter_for_market");
  if (market === "crypto_spot" && productType !== "spot") executionVetoes.push("crypto_product_not_spot");
  if (side !== "LONG") executionVetoes.push("short_execution_not_enabled");
  if (leverage > 1) executionVetoes.push("leverage_not_enabled");
  if (market === "crypto_spot" && quoteUnit !== "USDT") executionVetoes.push("crypto_quote_unit_not_approved");

  const signal = {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: hash(`${sourceCheck.source.sourceId}|${input.publishedAt}|${rawContentHash}`),
    fingerprint: null,
    sourceId: sourceCheck.source.sourceId,
    sourceDisplayName: sourceCheck.source.displayName,
    market,
    instrument: {symbol, quoteUnit, venue, productType},
    side,
    entry: {min: entryMin, max: entryMax},
    stopLoss,
    targets,
    timeframe,
    publishedAt: new Date(publishedAt).toISOString(),
    firstSeenAt: new Date(firstSeenAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    captureLagMs,
    parser: {
      provider: cleanString(parser.provider, 64),
      model: cleanString(parser.model, 80),
      confidence: parserConfidence
    },
    rawContentHash,
    leverage,
    researchEligible,
    executionEligible: false,
    executionVetoes
  };
  signal.fingerprint = buildSignalFingerprint(signal);

  return {
    accepted: true,
    errors: [],
    warnings: researchEligible ? [] : ["parser_confidence_below_research_threshold"],
    signal
  };
}

/**
 * Computes descriptive, net-of-cost source metrics from independently resolved
 * paper observations. This is a screening report, never a live-trading approval.
 */
export function scoreSignalSource(records, {minimumResolvedTrades = 100, minimumProfitFactor = 1.2} = {}) {
  if (!Array.isArray(records)) throw new Error("signal_records_must_be_an_array");
  if (!Number.isSafeInteger(minimumResolvedTrades) || minimumResolvedTrades < 1) {
    throw new Error("minimum_resolved_trades_invalid");
  }
  if (!Number.isFinite(minimumProfitFactor) || minimumProfitFactor <= 0) {
    throw new Error("minimum_profit_factor_invalid");
  }

  const noEntryStatuses = new Set(["no_entry", "missed", "expired_untriggered", "unfillable"]);
  const trades = [];
  let noEntrySignals = 0;
  let unresolvedSignals = 0;
  let quarantinedSignals = 0;

  for (const record of records) {
    if (record?.researchEligible === false) {
      quarantinedSignals++;
      continue;
    }
    const outcome = record?.outcome;
    if (isRecord(outcome) && noEntryStatuses.has(outcome.status)) {
      noEntrySignals++;
      continue;
    }
    const hasNetR = outcome?.netR !== null && outcome?.netR !== undefined &&
      (typeof outcome.netR === "number" || typeof outcome.netR === "string");
    const netR = hasNetR ? Number(outcome.netR) : Number.NaN;
    if (isRecord(outcome) && outcome.resolved === true && Number.isFinite(netR)) {
      const timestamp = parseInstant(record.firstSeenAt) ?? parseInstant(outcome.resolvedAt) ?? 0;
      trades.push({netR, timestamp});
    } else {
      unresolvedSignals++;
    }
  }

  trades.sort((a, b) => a.timestamp - b.timestamp);
  let grossWinsR = 0;
  let grossLossesR = 0;
  let totalNetR = 0;
  let equityR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;

  for (const trade of trades) {
    totalNetR += trade.netR;
    equityR += trade.netR;
    if (trade.netR > 0) {
      wins++;
      grossWinsR += trade.netR;
    } else if (trade.netR < 0) {
      losses++;
      grossLossesR += Math.abs(trade.netR);
    } else {
      breakeven++;
    }
    peakR = Math.max(peakR, equityR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
  }

  const resolvedTrades = trades.length;
  const profitFactor = grossLossesR > 0 ? grossWinsR / grossLossesR : null;
  const expectancyR = resolvedTrades > 0 ? totalNetR / resolvedTrades : null;
  const winRate = resolvedTrades > 0 ? wins / resolvedTrades : null;
  const candidateForHoldoutReview =
    resolvedTrades >= minimumResolvedTrades &&
    expectancyR > 0 &&
    profitFactor !== null &&
    profitFactor >= minimumProfitFactor;

  return {
    signalsObserved: records.length,
    resolvedTrades,
    noEntrySignals,
    unresolvedSignals,
    quarantinedSignals,
    wins,
    losses,
    breakeven,
    winRate,
    expectancyR,
    profitFactor,
    totalNetR,
    maxDrawdownR,
    candidateForHoldoutReview,
    livePromotionEligible: false,
    promotionVetoes: [
      "source_metrics_do_not_replace_chronological_holdout",
      "multiple_testing_correction_required",
      "forward_paper_validation_required",
      "market_specific_execution_costs_and_fillability_required",
      "manual_risk_review_required"
    ]
  };
}
