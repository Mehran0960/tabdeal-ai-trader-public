const DEFAULT_MIN_CANDLES = 80;
const DEFAULT_MIN_OOS_WINDOWS = 30;
const PERIODS = Object.freeze({ fast: 20, slow: 50, rsi: 14, atr: 14, bollinger: 20, volume: 20 });
const EPSILON = 1e-12;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentile(values, probability) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const position = (clean.length - 1) * Math.min(1, Math.max(0, probability));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return clean[lower];
  return clean[lower] + (clean[upper] - clean[lower]) * (position - lower);
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function standardDeviation(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return null;
  const average = mean(clean);
  return Math.sqrt(clean.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (clean.length - 1));
}

function normalizeCandles(input) {
  if (!Array.isArray(input)) throw new TypeError("candles_must_be_an_array");
  const sorted = input.map(row => ({
    time: Math.floor(Number(row.candle_time ?? row.time)),
    open: finite(row.open),
    high: finite(row.high),
    low: finite(row.low),
    close: finite(row.close),
    volume: finite(row.volume)
  })).sort((a, b) => a.time - b.time);
  const result = [];
  let previousTime = -Infinity;
  for (const candle of sorted) {
    if (!Number.isSafeInteger(candle.time) || candle.time <= previousTime) continue;
    if ([candle.open, candle.high, candle.low, candle.close, candle.volume].some(value => value === null)) continue;
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0) continue;
    if (candle.high < Math.max(candle.open, candle.close, candle.low)) continue;
    if (candle.low > Math.min(candle.open, candle.close, candle.high)) continue;
    result.push(candle);
    previousTime = candle.time;
  }
  return result;
}

// A gap longer than six expected bars starts a new series segment. Indicators,
// forecasts and backtests must never bridge a discontinuity spanning months or years.
const SEVERE_GAP_MULTIPLE = 6;
const MATERIAL_GAP_MULTIPLE = 1.5;

function latestContiguousSegment(input, resolutionSeconds) {
  if (!Number.isFinite(resolutionSeconds) || resolutionSeconds <= 0) {
    throw new RangeError("resolution_seconds_required");
  }
  const normalized = normalizeCandles(input);
  let segmentStartIndex = 0;
  let discontinuityCount = 0;
  let maxObservedGapSeconds = 0;

  for (let index = 1; index < normalized.length; index++) {
    const gapSeconds = normalized[index].time - normalized[index - 1].time;
    maxObservedGapSeconds = Math.max(maxObservedGapSeconds, gapSeconds);
    if (gapSeconds > resolutionSeconds * SEVERE_GAP_MULTIPLE) {
      segmentStartIndex = index;
      discontinuityCount++;
    }
  }

  const candles = normalized.slice(segmentStartIndex);
  const segmentGaps = candles.slice(1).map((row, index) => row.time - candles[index].time);
  const maxCandleGapSeconds = segmentGaps.length ? Math.max(...segmentGaps) : 0;
  const materialGapCount = segmentGaps.filter(gap => gap > resolutionSeconds * MATERIAL_GAP_MULTIPLE).length;
  const maximumToleratedMaterialGaps = Math.max(3, candles.length * 0.02);
  const status = materialGapCount > maximumToleratedMaterialGaps
    ? "degraded_gaps_detected"
    : segmentStartIndex > 0
      ? "usable_latest_contiguous_segment"
      : "usable";

  return {
    candles,
    quality: {
      status,
      rawCandleCount: input.length,
      normalizedCandleCount: normalized.length,
      candleCount: candles.length,
      firstCandleTime: candles[0]?.time ?? null,
      lastCandleTime: candles.at(-1)?.time ?? null,
      discardedBeforeLatestContiguousSegment: segmentStartIndex,
      severeDiscontinuityCount: discontinuityCount,
      maxObservedGapSeconds,
      maxCandleGapSeconds,
      materialGapCount,
      maximumToleratedMaterialGaps,
      severeGapMultiple: SEVERE_GAP_MULTIPLE,
      duplicateOrMalformedRowsDiscarded: input.length - normalized.length
    }
  };
}

function contiguousCandleSegments(input, resolutionSeconds) {
  if (!Number.isFinite(resolutionSeconds) || resolutionSeconds <= 0) {
    throw new RangeError("resolution_seconds_required");
  }
  const normalized = normalizeCandles(input);
  const ranges = [];
  let segmentStart = 0;
  for (let index = 1; index < normalized.length; index++) {
    const gapSeconds = normalized[index].time - normalized[index - 1].time;
    if (gapSeconds > resolutionSeconds * SEVERE_GAP_MULTIPLE) {
      ranges.push(normalized.slice(segmentStart, index));
      segmentStart = index;
    }
  }
  if (normalized.length) ranges.push(normalized.slice(segmentStart));

  return ranges.map((candles, index) => {
    const history = latestContiguousSegment(candles, resolutionSeconds);
    return {
      segmentIndex: index + 1,
      candles: history.candles,
      quality: history.quality,
      startTime: history.candles[0]?.time ?? null,
      endTime: history.candles.at(-1)?.time ?? null
    };
  });
}

function emaSeries(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;
  const alpha = 2 / (period + 1);
  let current = mean(values.slice(0, period));
  output[period - 1] = current;
  for (let index = period; index < values.length; index++) {
    current = alpha * values[index] + (1 - alpha) * current;
    output[index] = current;
  }
  return output;
}

function rsiSeries(closes, period = PERIODS.rsi) {
  const output = Array(closes.length).fill(null);
  if (closes.length <= period) return output;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index++) {
    const change = closes[index] - closes[index - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  const calculate = () => averageLoss <= EPSILON ? 100 : 100 - (100 / (1 + averageGain / averageLoss));
  output[period] = calculate();
  for (let index = period + 1; index < closes.length; index++) {
    const change = closes[index] - closes[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(0, change)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(0, -change)) / period;
    output[index] = calculate();
  }
  return output;
}

function atrSeries(candles, period = PERIODS.atr) {
  const output = Array(candles.length).fill(null);
  if (candles.length <= period) return output;
  const ranges = Array(candles.length).fill(null);
  for (let index = 1; index < candles.length; index++) {
    const row = candles[index];
    const previousClose = candles[index - 1].close;
    ranges[index] = Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose)
    );
  }
  let current = mean(ranges.slice(1, period + 1));
  output[period] = current;
  for (let index = period + 1; index < candles.length; index++) {
    current = ((current * (period - 1)) + ranges[index]) / period;
    output[index] = current;
  }
  return output;
}

function rollingVolatility(closes, period = 20) {
  const output = Array(closes.length).fill(null);
  const returns = closes.map((close, index) => index ? Math.log(close / closes[index - 1]) : null);
  for (let index = period; index < closes.length; index++) {
    output[index] = standardDeviation(returns.slice(index - period + 1, index + 1));
  }
  return output;
}

function rollingBands(closes, period = PERIODS.bollinger, deviations = 2) {
  const output = Array(closes.length).fill(null);
  for (let index = period - 1; index < closes.length; index++) {
    const window = closes.slice(index - period + 1, index + 1);
    const middle = mean(window);
    const sigma = standardDeviation(window) ?? 0;
    output[index] = { middle, upper: middle + deviations * sigma, lower: middle - deviations * sigma };
  }
  return output;
}

function median(values) {
  return percentile(values, 0.5);
}

function rollingMedian(values, period) {
  const result = Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index++) {
    result[index] = median(values.slice(index - period + 1, index + 1));
  }
  return result;
}

function calcEwmaVariance(closes, lambda = 0.94) {
  const returns = [];
  for (let index = 1; index < closes.length; index++) returns.push(Math.log(closes[index] / closes[index - 1]));
  if (returns.length < 20) return null;
  let variance = mean(returns.slice(0, Math.min(20, returns.length)).map(value => value * value));
  for (let index = Math.min(20, returns.length); index < returns.length; index++) {
    variance = lambda * variance + (1 - lambda) * (returns[index] ** 2);
  }
  return Math.max(0, variance);
}

function getTrend(close, fastEma, slowEma) {
  if (!Number.isFinite(fastEma) || !Number.isFinite(slowEma) || !Number.isFinite(close)) return "unknown";
  const relativeGap = (fastEma - slowEma) / Math.max(Math.abs(slowEma), EPSILON);
  if (relativeGap > 0.002 && close > fastEma) return "up";
  if (relativeGap < -0.002 && close < fastEma) return "down";
  return "sideways";
}

function quantileBand(value, lowCut, highCut) {
  if (!Number.isFinite(value) || !Number.isFinite(lowCut) || !Number.isFinite(highCut)) return "unknown";
  if (value <= lowCut) return "low";
  if (value >= highCut) return "high";
  return "normal";
}

function wilsonInterval(successes, total, z = 1.96) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const proportion = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (proportion + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((proportion * (1 - proportion) / total) + (z2 / (4 * total * total)))) / denominator;
  return { lower: Math.max(0, centre - margin), upper: Math.min(1, centre + margin), confidenceLevel: 0.95 };
}

function forecastRegime(candles, derived, horizonBars) {
  const lastIndex = candles.length - 1;
  const trainCut = Math.max(60, Math.floor(lastIndex * 0.6));
  const currentTrend = getTrend(candles[lastIndex].close, derived.emaFast[lastIndex], derived.emaSlow[lastIndex]);
  // Calibrate volatility thresholds on the earlier segment, then freeze them
  // before evaluating any later forward-return observations.
  const calibrationVols = derived.realizedVol.slice(50, trainCut + 1).filter(Number.isFinite);
  const lowCut = percentile(calibrationVols, 0.25);
  const highCut = percentile(calibrationVols, 0.75);
  const currentVolBand = quantileBand(derived.realizedVol[lastIndex], lowCut, highCut);
  const samples = [];
  for (let index = trainCut; index + horizonBars <= lastIndex; index += horizonBars) {
    const trend = getTrend(candles[index].close, derived.emaFast[index], derived.emaSlow[index]);
    const volBand = quantileBand(derived.realizedVol[index], lowCut, highCut);
    const forwardReturn = candles[index + horizonBars].close / candles[index].close - 1;
    if (Number.isFinite(forwardReturn)) samples.push({ trend, volBand, forwardReturn });
  }
  let matched = samples.filter(row => row.trend === currentTrend && row.volBand === currentVolBand);
  let fallback = "same_trend_and_volatility_regime";
  if (matched.length < 30) {
    matched = samples.filter(row => row.trend === currentTrend);
    fallback = "same_trend_regime";
  }
  if (matched.length < 30) {
    matched = samples;
    fallback = "unconditional_holdout_history";
  }
  const returns = matched.map(row => row.forwardReturn);
  const positiveCount = returns.filter(value => value > 0).length;
  const probabilityPositive = returns.length ? positiveCount / returns.length : null;
  const available = returns.length >= 30;
  return {
    available,
    status: available ? "historical_analog_estimate" : "insufficient_non_overlapping_holdout_samples",
    method: "chronological_calibration_holdout_non_overlapping_horizon_analogs",
    fallback,
    horizonBars,
    sampleCount: returns.length,
    independentWindowSpacingBars: horizonBars,
    minimumSamplesRequired: 30,
    calibrationCutIndex: trainCut,
    trainingCutoffTime: candles[trainCut]?.time ?? null,
    trend: currentTrend,
    volatilityRegime: currentVolBand,
    probabilityPositive: available ? probabilityPositive : null,
    probabilityPositiveWilson95: available ? wilsonInterval(positiveCount, returns.length) : null,
    probabilityNegative: available ? 1 - probabilityPositive : null,
    medianReturnPct: available ? percentile(returns, 0.5) * 100 : null,
    p10ReturnPct: available ? percentile(returns, 0.1) * 100 : null,
    p90ReturnPct: available ? percentile(returns, 0.9) * 100 : null,
    calibrationNote: "Windows do not overlap. Serial dependence may remain; the Wilson interval is descriptive, not a calibrated guarantee."
  };
}

function strategySignals(candles, derived, currentVolBand) {
  const index = candles.length - 1;
  const candle = candles[index];
  const priorHighs = candles.slice(Math.max(0, index - 20), index).map(row => row.high);
  const prior20High = priorHighs.length ? Math.max(...priorHighs) : null;
  const priorLows = candles.slice(Math.max(0, index - 10), index).map(row => row.low);
  const prior10Low = priorLows.length ? Math.min(...priorLows) : null;
  const bands = derived.bands[index];
  const rsi = derived.rsi[index];
  const volumeMedian = derived.volumeMedian[index];
  const volumeExpansion = Number.isFinite(volumeMedian) && volumeMedian > 0 ? candle.volume / volumeMedian : null;
  const trend = getTrend(candle.close, derived.emaFast[index], derived.emaSlow[index]);
  const highVolatility = currentVolBand === "high";

  const trendSignal = trend === "up" && rsi >= 42 && rsi <= 72
    ? "BUY_CANDIDATE"
    : trend === "down" || (Number.isFinite(rsi) && rsi > 78)
      ? "EXIT_CANDIDATE"
      : "WAIT";

  const breakout = prior20High !== null && candle.close > prior20High &&
    Number.isFinite(volumeExpansion) && volumeExpansion >= 1.2;
  const breakoutSignal = breakout && !highVolatility ? "BUY_CANDIDATE" : "WAIT";
  const breakoutExitSignal = prior10Low !== null && candle.close < prior10Low
    ? "EXIT_CANDIDATE" : "WAIT";

  const meanReversionSignal = Number.isFinite(rsi) && bands
    ? rsi < 30 && candle.close < bands.lower && !highVolatility
      ? "BUY_CANDIDATE"
      : rsi > 72 && candle.close > bands.upper
        ? "EXIT_CANDIDATE"
        : "WAIT"
    : "WAIT";

  return {
    trendFollowing: { signal: trendSignal, explanation: "EMA20/EMA50 trend filter with RSI confirmation." },
    breakout: { signal: breakoutSignal, exitSignal: breakoutExitSignal,
      explanation: "Entry: close above prior 20-bar high with relative volume expansion; exit: close below prior 10-bar low. New entries are disabled in high-volatility regime." },
    meanReversion: { signal: meanReversionSignal, explanation: "RSI/Bollinger extreme; buys are disabled in high-volatility regime." },
    volumeExpansion: Number.isFinite(volumeExpansion) ? volumeExpansion : null,
    prior20High,
    prior10Low,
    highVolatility
  };
}

function forecastHasStatisticalEdge(forecast) {
  const probability = Number(forecast?.probabilityPositive);
  const medianReturnPct = Number(forecast?.medianReturnPct);
  const lowerConfidenceBound = Number(forecast?.probabilityPositiveWilson95?.lower);
  return Boolean(
    forecast?.available === true &&
    Number.isFinite(probability) && probability >= 0.55 &&
    Number.isFinite(lowerConfidenceBound) && lowerConfidenceBound > 0.5 &&
    Number.isFinite(medianReturnPct) && medianReturnPct > 0
  );
}

export function buildMarketResearch(inputCandles, options = {}) {
  const resolutionSeconds = Number(options.resolutionSeconds);
  if (!Number.isFinite(resolutionSeconds) || resolutionSeconds <= 0) throw new RangeError("resolution_seconds_required");
  const segment = latestContiguousSegment(inputCandles, resolutionSeconds);
  const candles = segment.candles;
  const horizonBars = Math.max(1, Math.min(168, Math.floor(Number(options.horizonBars) || 24)));
  const minCandles = Math.max(DEFAULT_MIN_CANDLES, Math.floor(Number(options.minCandles) || DEFAULT_MIN_CANDLES));
  if (candles.length < minCandles) {
    return {
      available: false,
      status: "insufficient_history",
      minimumCandles: minCandles,
      candleCount: candles.length,
      dataQuality: segment.quality,
      requiredNextStep: "Backfill more closed candles in the latest contiguous segment before producing a market forecast."
    };
  }
  const closes = candles.map(row => row.close);
  const volumes = candles.map(row => row.volume);
  const emaFast = emaSeries(closes, PERIODS.fast);
  const emaSlow = emaSeries(closes, PERIODS.slow);
  const rsi = rsiSeries(closes);
  const atr = atrSeries(candles);
  const realizedVol = rollingVolatility(closes, 20);
  const bands = rollingBands(closes);
  const volumeMedian = rollingMedian(volumes, PERIODS.volume);
  const latest = candles[candles.length - 1];
  const ewmaVariance = calcEwmaVariance(closes);
  const currentTrend = getTrend(latest.close, emaFast.at(-1), emaSlow.at(-1));
  const validVols = realizedVol.slice(50).filter(Number.isFinite);
  const currentVol = realizedVol.at(-1);
  const volRegime = quantileBand(currentVol, percentile(validVols, 0.25), percentile(validVols, 0.75));
  const signals = strategySignals(candles, { emaFast, emaSlow, rsi, atr, realizedVol, bands, volumeMedian }, volRegime);
  const lookback28Bars = Math.max(1, Math.ceil((28 * 86_400) / resolutionSeconds));
  const lookback84Bars = Math.max(1, Math.ceil((84 * 86_400) / resolutionSeconds));
  const momentum28ReturnPct = candles.length > lookback28Bars
    ? (latest.close / candles[candles.length - 1 - lookback28Bars].close - 1) * 100
    : null;
  const momentum84ReturnPct = candles.length > lookback84Bars
    ? (latest.close / candles[candles.length - 1 - lookback84Bars].close - 1) * 100
    : null;
  const horizons = [1, 4, horizonBars].filter((value, index, values) => values.indexOf(value) === index);
  const forecasts = horizons.map(horizon => forecastRegime(candles, { emaFast, emaSlow, realizedVol }, horizon));
  const decisionForecast = forecasts.find(item => item.horizonBars === horizonBars);
  const trendMomentumConfirmsLong = Number.isFinite(momentum28ReturnPct) &&
    momentum28ReturnPct > 0 &&
    (momentum84ReturnPct === null || momentum84ReturnPct > 0);
  const forecastConfirmsLong = forecastHasStatisticalEdge(decisionForecast) && trendMomentumConfirmsLong;
  const microstructure = options.microstructure && typeof options.microstructure === "object" ? options.microstructure : null;
  const microstructureAgeMs = microstructure?.capturedAt ? Date.now() - Date.parse(microstructure.capturedAt) : null;
  const microstructureFresh = Boolean(
    microstructure && Number.isFinite(microstructureAgeMs) &&
    microstructureAgeMs >= -60_000 && microstructureAgeMs <= 15 * 60_000
  );
  const flowImbalance = microstructureFresh && microstructure.tradeFlowReliable === true &&
    Number.isFinite(microstructure.tradeImbalancePct) ? microstructure.tradeImbalancePct : null;
  const depthImbalance = microstructureFresh && Number.isFinite(microstructure.depthImbalance10BpsPct)
    ? microstructure.depthImbalance10BpsPct : null;
  const flowCorroboratesLong = flowImbalance !== null && depthImbalance !== null &&
    flowImbalance > 5 && depthImbalance > 5;
  const flowConflictsLong = flowImbalance !== null && depthImbalance !== null &&
    flowImbalance < -10 && depthImbalance < -10;
  const horizonSigmaPct = ewmaVariance === null ? null : Math.sqrt(ewmaVariance * horizonBars) * 100;
  const nowEpochSeconds = Number.isFinite(Number(options.nowEpochSeconds))
    ? Number(options.nowEpochSeconds)
    : Math.floor(Date.now() / 1000);
  // The latest completed bar may be at most one full bar interval old.
  // A looser 2.5-bar default hid missing hourly and 4h refreshes (observed in production).
  // Fail closed when the next expected bar has already closed but has not arrived.
  // The close timestamp—not the collector's successful HTTP timestamp—is authoritative.
  const maxCandleAgeBars = Math.min(10, Math.max(1, Number(options.maxCandleAgeBars) || 1));
  const latestClosedCandleTime = latest.time + resolutionSeconds;
  const latestClosedCandleAgeSeconds = nowEpochSeconds - latestClosedCandleTime;
  const freshnessStatus = latestClosedCandleAgeSeconds < -60
    ? "future_candle_timestamp"
    : latestClosedCandleAgeSeconds > resolutionSeconds * maxCandleAgeBars
      ? "stale_candle_data"
      : null;
  const historyUsable = segment.quality.status !== "degraded_gaps_detected";
  const dataQuality = {
    ...segment.quality,
    status: freshnessStatus || segment.quality.status,
    latestClosedCandleAgeSeconds,
    maxAllowedCandleAgeSeconds: resolutionSeconds * maxCandleAgeBars
  };
  const insufficientDataQuality = !historyUsable || Boolean(freshnessStatus);
  return {
    available: true,
    instrument: String(options.symbol || "BTCIRT").toUpperCase(),
    resolutionSeconds,
    candleCount: candles.length,
    lastCandle: { time: latest.time, close: latest.close, high: latest.high, low: latest.low, volume: latest.volume },
    marketState: {
      trend: currentTrend,
      volatilityRegime: volRegime,
      rsi14: rsi.at(-1),
      atr14: atr.at(-1),
      atrPct: atr.at(-1) / latest.close * 100,
      ema20: emaFast.at(-1),
      ema50: emaSlow.at(-1),
      bollinger20: bands.at(-1),
      ewmaVolatilityPerBarPct: ewmaVariance === null ? null : Math.sqrt(ewmaVariance) * 100,
      forecastOneSigmaMovePct: horizonSigmaPct,
      timeSeriesMomentum: {
        lookback28DaysBars: lookback28Bars,
        return28DaysPct: momentum28ReturnPct,
        lookback84DaysBars: lookback84Bars,
        return84DaysPct: momentum84ReturnPct,
        available: momentum28ReturnPct !== null,
        confirmsLong: trendMomentumConfirmsLong,
        role: "slow_trend_regime_filter_not_a_price_target"
      }
    },
    forecasts,
    forecastAssessment: {
      horizonBars,
      sufficientSamples: Boolean(decisionForecast?.available),
      probabilityPositive: decisionForecast?.probabilityPositive ?? null,
      probabilityPositiveWilson95: decisionForecast?.probabilityPositiveWilson95 ?? null,
      wilsonLowerBoundAboveNeutral: Number.isFinite(Number(decisionForecast?.probabilityPositiveWilson95?.lower))
        ? Number(decisionForecast.probabilityPositiveWilson95.lower) > 0.5
        : false,
      medianReturnPct: decisionForecast?.medianReturnPct ?? null,
      mediumAndSlowMomentumConfirm: trendMomentumConfirmsLong,
      confirmsLong: forecastConfirmsLong
    },
    microstructureConfirmation: {
      available: microstructureFresh,
      ageMs: microstructureFresh ? microstructureAgeMs : null,
      tradeImbalancePct: flowImbalance,
      depthImbalance10BpsPct: depthImbalance,
      corroboratesLong: flowCorroboratesLong,
      conflictsLong: flowConflictsLong,
      role: "secondary_confirmation_only_not_a_standalone_signal"
    },
    strategySignals: signals,
    dataQuality,
    decision: insufficientDataQuality
      ? "NO_TRADE_DATA_QUALITY"
      : volRegime === "high"
        ? "REDUCE_RISK_NO_NEW_MOMENTUM_ENTRIES"
        : !decisionForecast?.available
          ? "WAIT_INSUFFICIENT_FORECAST_SAMPLE"
          : !forecastConfirmsLong
            ? "WAIT_FORECAST_OR_MOMENTUM_NOT_CONFIRMED"
            : flowConflictsLong
              ? "WAIT_MICROSTRUCTURE_CONFLICT"
              : signals.trendFollowing.signal === "BUY_CANDIDATE" || signals.breakout.signal === "BUY_CANDIDATE"
                ? "RESEARCH_BUY_CANDIDATE"
                : signals.meanReversion.signal === "BUY_CANDIDATE"
                  ? "RESEARCH_MEAN_REVERSION_CANDIDATE"
                  : "WAIT",
    execution: {
      liveTradingEnabled: false,
      paperOnly: true,
      orderCreated: false,
      note: "Research candidates are not orders. A deterministic risk engine and paper validation are required before any execution."
    }
  };
}

function indicatorBundle(candles) {
  const closes = candles.map(row => row.close);
  return {
    closes,
    emaFast: emaSeries(closes, 20),
    emaSlow: emaSeries(closes, 50),
    rsi: rsiSeries(closes),
    atr: atrSeries(candles),
    bands: rollingBands(closes),
    highs: candles.map(row => row.high),
    lows: candles.map(row => row.low)
  };
}

function signalAt(candles, indicators, index, strategy, direction = "long") {
  if (!["long", "short"].includes(direction)) throw new Error("unknown_backtest_direction");
  const close = candles[index].close;
  const rsi = indicators.rsi[index];
  const band = indicators.bands[index];
  if (strategy === "ema-trend") {
    const bullish = indicators.emaFast[index] > indicators.emaSlow[index] && close > indicators.emaFast[index];
    const bearish = indicators.emaFast[index] < indicators.emaSlow[index] && close < indicators.emaFast[index];
    const bullishExit = indicators.emaFast[index] < indicators.emaSlow[index] || close < indicators.emaSlow[index];
    const bearishExit = indicators.emaFast[index] > indicators.emaSlow[index] || close > indicators.emaSlow[index];
    return direction === "short"
      ? { enter: bearish, exit: bearishExit }
      : { enter: bullish, exit: bullishExit };
  }
  if (strategy === "donchian-breakout") {
    const priorHigh = Math.max(...indicators.highs.slice(Math.max(0, index - 20), index));
    const priorLow = Math.min(...indicators.lows.slice(Math.max(0, index - 10), index));
    return direction === "short"
      ? { enter: close < priorLow, exit: close > priorHigh }
      : { enter: close > priorHigh, exit: close < priorLow };
  }
  if (strategy === "rsi-mean-reversion") {
    if (direction === "short") {
      return { enter: Number.isFinite(rsi) && rsi > 70 && band && close > band.upper,
        exit: Number.isFinite(rsi) && rsi < 50 };
    }
    return { enter: Number.isFinite(rsi) && rsi < 30 && band && close < band.lower,
      exit: Number.isFinite(rsi) && rsi > 50 };
  }
  throw new Error("unknown_strategy");
}

function performanceMetrics(equityCurve, tradePnls, initialCapital, barSeconds, exposureBars) {
  const finalEquity = equityCurve.at(-1) ?? initialCapital;
  const returns = equityCurve.slice(1).map((equity, index) => {
    const previous = equityCurve[index];
    return previous > 0 ? equity / previous - 1 : 0;
  });
  const average = mean(returns) ?? 0;
  const deviation = standardDeviation(returns) ?? 0;
  const downside = Math.sqrt(mean(returns.map(value => Math.min(0, value) ** 2)) ?? 0);
  const annualization = Math.sqrt(31_536_000 / barSeconds);
  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const value of equityCurve) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }
  const years = Math.max(barSeconds, (equityCurve.length - 1) * barSeconds) / 31_536_000;
  const cagr = years > 0 && finalEquity > 0 ? (finalEquity / initialCapital) ** (1 / years) - 1 : null;
  const gains = tradePnls.filter(value => value > 0);
  const losses = tradePnls.filter(value => value < 0);
  const grossProfit = gains.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    initialCapital,
    finalEquity,
    totalReturnPct: (finalEquity / initialCapital - 1) * 100,
    cagrPct: cagr === null ? null : cagr * 100,
    sharpe: deviation > 0 ? (average / deviation) * annualization : null,
    sortino: downside > 0 ? (average / downside) * annualization : null,
    maxDrawdownPct: maxDrawdown * 100,
    tradeCount: tradePnls.length,
    winRatePct: tradePnls.length ? (gains.length / tradePnls.length) * 100 : null,
    expectancyPerTrade: tradePnls.length ? mean(tradePnls) : null,
    averageWin: gains.length ? mean(gains) : null,
    averageLoss: losses.length ? mean(losses) : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    exposurePct: (exposureBars / Math.max(1, equityCurve.length - 1)) * 100
  };
}

export function backtestLongOnly(inputCandles, options = {}) {
  const strategy = String(options.strategy || "ema-trend");
  if (!new Set(["ema-trend", "donchian-breakout", "rsi-mean-reversion"]).has(strategy)) throw new Error("unknown_strategy");
  const initialCapital = Number(options.initialCapital);
  const feeBps = Number(options.feeBps);
  const slippageBps = Number(options.slippageBps);
  const barSeconds = Number(options.resolutionSeconds);
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new RangeError("initial_capital_required");
  if (!Number.isFinite(feeBps) || feeBps < 0) throw new RangeError("explicit_fee_bps_required");
  if (!Number.isFinite(slippageBps) || slippageBps < 0) throw new RangeError("explicit_slippage_bps_required");
  if (!Number.isFinite(barSeconds) || barSeconds <= 0) throw new RangeError("resolution_seconds_required");
  const history = latestContiguousSegment(inputCandles, barSeconds);
  const candles = history.candles;
  if (history.quality.status === "degraded_gaps_detected") throw new RangeError("degraded_candle_gaps");
  if (candles.length < 100) throw new RangeError("at_least_100_valid_candles_required");

  const indicators = indicatorBundle(candles);
  const tradeStartIndex = Math.max(60, Math.floor(Number(options.startIndex) || 60));
  const tradeEndIndex = Math.min(candles.length - 1, Math.floor(Number(options.endIndex ?? (candles.length - 1))));
  if (tradeEndIndex <= tradeStartIndex) throw new RangeError("invalid_backtest_window");
  const riskFraction = Math.min(0.01, Math.max(0.001, Number(options.riskFraction) || 0.0025));
  const maxExposureFraction = Math.min(0.5, Math.max(0.05, Number(options.maxExposureFraction) || 0.2));
  const stopAtrMultiple = Math.min(5, Math.max(1, Number(options.stopAtrMultiple) || 2.5));
  const maxDrawdownStop = Math.min(0.2, Math.max(0.03, Number(options.maxDrawdownStop) || 0.1));
  const feeRate = feeBps / 10_000;
  const slippageRate = slippageBps / 10_000;
  let cash = initialCapital;
  let position = null;
  let peakEquity = initialCapital;
  let halted = false;
  let exposureBars = 0;
  let skippedInvalidStopCount = 0;
  const trades = [];
  const equityCurve = [initialCapital];

  function equityAt(price) {
    return cash + (position ? position.quantity * price : 0);
  }
  function closePosition(rawPrice, reason, time) {
    if (!position) return;
    const exitPrice = rawPrice * (1 - slippageRate);
    const gross = position.quantity * exitPrice;
    const fee = gross * feeRate;
    cash += gross - fee;
    const netPnl = cash - position.cashBeforeEntry;
    trades.push({
      entryTime: position.entryTime,
      exitTime: time,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      reason,
      netPnl,
      netReturnPct: position.cashBeforeEntry > 0 ? (netPnl / position.cashBeforeEntry) * 100 : null
    });
    position = null;
  }

  for (let index = tradeStartIndex; index <= tradeEndIndex; index++) {
    const current = candles[index];
    const signalIndex = index - 1;
    const signal = signalAt(candles, indicators, signalIndex, strategy);
    let exitedThisBar = false;
    if (position) {
      exposureBars++;
      if (current.open <= position.stopPrice || current.low <= position.stopPrice) {
        closePosition(Math.min(current.open, position.stopPrice), "atr_stop", current.time);
        exitedThisBar = true;
      } else if (signal.exit) {
        closePosition(current.open, "strategy_exit_next_open", current.time);
        exitedThisBar = true;
      }
    }
    let currentEquity = equityAt(current.close);
    peakEquity = Math.max(peakEquity, currentEquity);
    const drawdown = peakEquity > 0 ? (peakEquity - currentEquity) / peakEquity : 0;
    if (!halted && drawdown >= maxDrawdownStop) {
      if (position) closePosition(current.close, "max_drawdown_kill_switch", current.time);
      halted = true;
      exitedThisBar = true;
      currentEquity = equityAt(current.close);
    }
    if (!halted && !position && !exitedThisBar && signal.enter) {
      const atrValue = indicators.atr[signalIndex];
      if (Number.isFinite(atrValue) && atrValue > 0) {
        const entryPrice = current.open * (1 + slippageRate);
        const stopDistance = atrValue * stopAtrMultiple;
        const riskBudget = currentEquity * riskFraction;
        const riskQuantity = riskBudget / stopDistance;
        const exposureQuantity = (currentEquity * maxExposureFraction) / entryPrice;
        const affordableQuantity = cash / (entryPrice * (1 + feeRate));
        const quantity = Math.max(0, Math.min(riskQuantity, exposureQuantity, affordableQuantity));
        if (stopDistance >= entryPrice) {
          skippedInvalidStopCount++;
        } else if (quantity > 0) {
          const notional = quantity * entryPrice;
          const entryFee = notional * feeRate;
          cash -= notional + entryFee;
          position = {
            entryTime: current.time,
            entryPrice,
            quantity,
            stopPrice: entryPrice - stopDistance,
            cashBeforeEntry: currentEquity
          };
          // OHLC bars do not reveal intrabar path. If the entry-bar low crosses
          // the stop, assume the stop was hit and apply adverse slippage.
          if (current.low <= position.stopPrice) {
            closePosition(position.stopPrice, "same_bar_atr_stop_conservative", current.time);
            exitedThisBar = true;
          }
        }
      }
    }
    currentEquity = equityAt(current.close);
    equityCurve.push(currentEquity);
  }
  if (position) {
    const last = candles[tradeEndIndex];
    closePosition(last.close, "end_of_test", last.time);
    equityCurve[equityCurve.length - 1] = cash;
  }
  const roundTripRate = 2 * (feeRate + slippageRate);
  const benchmarkStart = candles[tradeStartIndex].open * (1 + feeRate + slippageRate);
  const benchmarkEnd = candles[tradeEndIndex].close * (1 - feeRate - slippageRate);
  const benchmarkFinal = initialCapital * (benchmarkEnd / benchmarkStart);
  const metrics = performanceMetrics(
    equityCurve,
    trades.map(trade => trade.netPnl),
    initialCapital,
    barSeconds,
    exposureBars
  );
  return {
    strategy,
    dataQuality: history.quality,
    assumptions: {
      feeBpsPerSide: feeBps,
      slippageBpsPerSide: slippageBps,
      roundTripCostApproxBps: roundTripRate * 10_000,
      longOnly: true,
      leverage: false,
      riskFractionPerTrade: riskFraction,
      maxExposureFraction,
      stopAtrMultiple,
      maxDrawdownStop,
      nextBarOpenExecution: true,
      tradeStartIndex,
      tradeEndIndex,
      sameBarStopHandling: "conservative_stop_fill_when_entry_bar_low_crosses_stop",
      liveTradingEnabled: false
    },
    metrics,
    benchmark: {
      name: "buy_and_hold",
      finalEquity: benchmarkFinal,
      totalReturnPct: (benchmarkFinal / initialCapital - 1) * 100
    },
    haltedByDrawdown: halted,
    skippedInvalidStopCount,
    trades,
    caveats: [
      "Research simulation only; not a live execution model.",
      "Signals use the previous completed candle and fill at the next candle open.",
      "ATR stops are evaluated against bar OHLC; gaps are filled conservatively.",
      "Fees and slippage are explicit assumptions and must be replaced with the account's verified fee tier and observed execution costs.",
      "A single backtest is not out-of-sample evidence. Use walk-forward and untouched holdout periods before judging an edge."
    ]
  };
}

export function backtestShortOnly(inputCandles, options = {}) {
  const strategy = String(options.strategy || "ema-trend");
  if (!new Set(["ema-trend", "donchian-breakout", "rsi-mean-reversion"]).has(strategy)) throw new Error("unknown_strategy");
  const initialCapital = Number(options.initialCapital);
  const feeBps = Number(options.feeBps);
  const slippageBps = Number(options.slippageBps);
  const positionFeeBpsPerDay = Number(options.positionFeeBpsPerDay);
  const barSeconds = Number(options.resolutionSeconds);
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new RangeError("initial_capital_required");
  if (!Number.isFinite(feeBps) || feeBps < 0) throw new RangeError("explicit_fee_bps_required");
  if (!Number.isFinite(slippageBps) || slippageBps < 0) throw new RangeError("explicit_slippage_bps_required");
  if (!Number.isFinite(positionFeeBpsPerDay) || positionFeeBpsPerDay < 0) {
    throw new RangeError("explicit_margin_position_fee_bps_per_day_required");
  }
  if (!Number.isFinite(barSeconds) || barSeconds <= 0) throw new RangeError("resolution_seconds_required");
  const history = latestContiguousSegment(inputCandles, barSeconds);
  const candles = history.candles;
  if (history.quality.status === "degraded_gaps_detected") throw new RangeError("degraded_candle_gaps");
  if (candles.length < 100) throw new RangeError("at_least_100_valid_candles_required");

  const indicators = indicatorBundle(candles);
  const tradeStartIndex = Math.max(60, Math.floor(Number(options.startIndex) || 60));
  const tradeEndIndex = Math.min(candles.length - 1, Math.floor(Number(options.endIndex ?? (candles.length - 1))));
  if (tradeEndIndex <= tradeStartIndex) throw new RangeError("invalid_backtest_window");
  const riskFraction = Math.min(0.01, Math.max(0.001, Number(options.riskFraction) || 0.0025));
  const maxExposureFraction = Math.min(0.5, Math.max(0.05, Number(options.maxExposureFraction) || 0.2));
  const stopAtrMultiple = Math.min(5, Math.max(1, Number(options.stopAtrMultiple) || 2.5));
  const maxDrawdownStop = Math.min(0.2, Math.max(0.03, Number(options.maxDrawdownStop) || 0.1));
  const feeRate = feeBps / 10_000;
  const slippageRate = slippageBps / 10_000;
  const dailyCarryRate = positionFeeBpsPerDay / 10_000;
  let cash = initialCapital;
  let position = null;
  let peakEquity = initialCapital;
  let halted = false;
  let exposureBars = 0;
  let skippedInvalidStopCount = 0;
  const trades = [];
  const equityCurve = [initialCapital];

  function equityAt(price) {
    return cash + (position ? position.quantity * (position.entryPrice - price) : 0);
  }
  function closePosition(rawPrice, reason, time) {
    if (!position) return;
    const coverPrice = rawPrice * (1 + slippageRate);
    const coverNotional = position.quantity * coverPrice;
    const exitFee = coverNotional * feeRate;
    cash += position.quantity * (position.entryPrice - coverPrice) - exitFee;
    const netPnl = cash - position.equityBeforeEntry;
    trades.push({
      entryTime: position.entryTime,
      exitTime: time,
      entryPrice: position.entryPrice,
      exitPrice: coverPrice,
      quantity: position.quantity,
      reason,
      entryFee: position.entryFee,
      exitFee,
      carryFee: position.carryFee,
      netPnl,
      netReturnPct: position.equityBeforeEntry > 0 ? (netPnl / position.equityBeforeEntry) * 100 : null
    });
    position = null;
  }

  for (let index = tradeStartIndex; index <= tradeEndIndex; index++) {
    const current = candles[index];
    const signalIndex = index - 1;
    const signal = signalAt(candles, indicators, signalIndex, strategy, "short");
    let exitedThisBar = false;
    if (position) {
      exposureBars++;
      const carryFee = position.quantity * current.open * dailyCarryRate * (barSeconds / 86_400);
      cash -= carryFee;
      position.carryFee += carryFee;
      if (current.open >= position.stopPrice || current.high >= position.stopPrice) {
        closePosition(Math.max(current.open, position.stopPrice), "atr_stop", current.time);
        exitedThisBar = true;
      } else if (signal.exit) {
        closePosition(current.open, "strategy_exit_next_open", current.time);
        exitedThisBar = true;
      }
    }
    let currentEquity = equityAt(current.close);
    peakEquity = Math.max(peakEquity, currentEquity);
    const drawdown = peakEquity > 0 ? (peakEquity - currentEquity) / peakEquity : 0;
    if (!halted && drawdown >= maxDrawdownStop) {
      if (position) closePosition(current.close, "max_drawdown_kill_switch", current.time);
      halted = true;
      exitedThisBar = true;
      currentEquity = equityAt(current.close);
    }
    if (!halted && !position && !exitedThisBar && signal.enter) {
      const atrValue = indicators.atr[signalIndex];
      if (Number.isFinite(atrValue) && atrValue > 0) {
        const entryPrice = current.open * (1 - slippageRate);
        const stopDistance = atrValue * stopAtrMultiple;
        const riskBudget = currentEquity * riskFraction;
        const riskQuantity = riskBudget / stopDistance;
        const exposureQuantity = (currentEquity * maxExposureFraction) / entryPrice;
        const quantity = Math.max(0, Math.min(riskQuantity, exposureQuantity));
        if (stopDistance >= entryPrice) {
          skippedInvalidStopCount++;
        } else if (quantity > 0) {
          const entryNotional = quantity * entryPrice;
          const entryFee = entryNotional * feeRate;
          cash -= entryFee;
          position = {
            entryTime: current.time,
            entryPrice,
            quantity,
            stopPrice: entryPrice + stopDistance,
            equityBeforeEntry: currentEquity,
            entryFee,
            carryFee: 0
          };
          // If the same bar reaches the stop, assume the worst plausible OHLC path.
          if (current.high >= position.stopPrice) {
            closePosition(position.stopPrice, "same_bar_atr_stop_conservative", current.time);
            exitedThisBar = true;
          }
        }
      }
    }
    currentEquity = equityAt(current.close);
    equityCurve.push(currentEquity);
  }
  if (position) {
    const last = candles[tradeEndIndex];
    closePosition(last.close, "end_of_test", last.time);
    equityCurve[equityCurve.length - 1] = cash;
  }
  const metrics = performanceMetrics(
    equityCurve,
    trades.map(trade => trade.netPnl),
    initialCapital,
    barSeconds,
    exposureBars
  );
  return {
    strategy,
    direction: "short",
    dataQuality: history.quality,
    assumptions: {
      marketType: "margin_shadow",
      positionDirection: "short",
      feeBpsPerSide: feeBps,
      slippageBpsPerSide: slippageBps,
      positionFeeBpsPerDay,
      roundTripExecutionCostApproxBps: 2 * (feeBps + slippageBps),
      longOnly: false,
      shortOnly: true,
      leverage: 1,
      leverageUsedForSimulation: 1,
      riskFractionPerTrade: riskFraction,
      maxExposureFraction,
      stopAtrMultiple,
      maxDrawdownStop,
      nextBarOpenExecution: true,
      tradeStartIndex,
      tradeEndIndex,
      sameBarStopHandling: "conservative_cover_at_stop_when_entry_bar_high_crosses_stop",
      carryAccrual: "simple_position_notional_times_daily_rate_times_bar_fraction",
      liveTradingEnabled: false,
      exchangeOrdersPlaced: 0
    },
    metrics,
    benchmark: { name: "cash_no_trade", finalEquity: initialCapital, totalReturnPct: 0 },
    haltedByDrawdown: halted,
    skippedInvalidStopCount,
    trades,
    caveats: [
      "Shadow-only 1x short model; it is not an exchange margin ledger or order simulator.",
      "Daily position fee is applied as a simple rate on bar-open notional; actual Nobitex tiers and accrual rules must replace this assumption.",
      "No liquidation, maintenance margin, delegated-pool exhaustion, funding variation or forced-close mechanics are modeled.",
      "Signals use the previous completed candle and execute at the next candle open with adverse slippage.",
      "Bar OHLC cannot reveal intrabar path; stop fills are conservative approximations.",
      "The model places no exchange orders and does not authorize short selling."
    ]
  };
}


export function rollingOutOfSampleBacktest(inputCandles, options = {}) {
  const barSeconds = Number(options.resolutionSeconds);
  if (!Number.isFinite(barSeconds) || barSeconds <= 0) throw new RangeError("resolution_seconds_required");
  const segments = contiguousCandleSegments(inputCandles, barSeconds);
  const initialCapital = Number(options.initialCapital);
  const trainBars = Math.max(100, Math.floor(Number(options.trainBars) || 500));
  const testBars = Math.max(30, Math.floor(Number(options.testBars) || 120));
  // Keep evaluation windows disjoint inside each independently trained data segment.
  const stepBars = Math.max(testBars, Math.floor(Number(options.stepBars) || testBars));
  // Thirty disjoint holdout windows are the minimum research acceptance floor.
  const minimumWindows = Math.max(DEFAULT_MIN_OOS_WINDOWS, Math.floor(Number(options.minimumWindows) || DEFAULT_MIN_OOS_WINDOWS));
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new RangeError("initial_capital_required");
  const direction = String(options.direction || "long");
  if (!["long", "short"].includes(direction)) throw new Error("unknown_backtest_direction");
  if (direction === "short" && (!Number.isFinite(Number(options.positionFeeBpsPerDay)) || Number(options.positionFeeBpsPerDay) < 0)) {
    throw new RangeError("explicit_margin_position_fee_bps_per_day_required");
  }

  const degradedSegments = segments.filter(segment => segment.quality.status === "degraded_gaps_detected");
  const latestSegment = segments.at(-1) ?? null;
  const latestSegmentDegraded = latestSegment?.quality.status === "degraded_gaps_detected";
  const latestSegmentTooShort = !latestSegment || latestSegment.candles.length < trainBars + 30;
  const usableSegments = segments.filter(segment =>
    segment.quality.status !== "degraded_gaps_detected" && segment.candles.length >= trainBars + 30
  );
  const minimumWindowSegments = Math.min(usableSegments.length, minimumWindows);
  const requiredCandlesForWindows = minimumWindowSegments * (trainBars + testBars) +
    Math.max(0, minimumWindows - minimumWindowSegments) * stepBars;
  const candleCount = segments.reduce((sum, segment) => sum + segment.candles.length, 0);
  const segmentSummary = segments.map(segment => ({
    segmentIndex: segment.segmentIndex,
    startTime: segment.startTime,
    endTime: segment.endTime,
    candleCount: segment.candles.length,
    qualityStatus: segment.quality.status,
    materialGapCount: segment.quality.materialGapCount,
    windowCount: 0
  }));

  if (usableSegments.length === 0 || latestSegmentDegraded || latestSegmentTooShort) {
    const reason = latestSegmentDegraded || (degradedSegments.length > 0 && usableSegments.length === 0)
      ? "degraded_candle_gaps" : "insufficient_history_for_out_of_sample_windows";
    return {
      available: false,
      reason,
      candleCount,
      minimumWindowsRequired: minimumWindows,
      requiredCandlesForWindows,
      segmentCount: segments.length,
      evaluatedSegmentCount: 0,
      excludedDegradedSegmentCount: degradedSegments.length,
      dataQuality: {
        status: degradedSegments.length ? "degraded_segments_excluded" : "insufficient_contiguous_segments",
        segmentCount: segments.length,
        evaluatedSegmentCount: 0,
        excludedDegradedSegmentCount: degradedSegments.length,
        segments: segmentSummary
      },
      windowCount: 0,
      windows: [],
      exchangeOrdersPlaced: 0
    };
  }

  const windows = [];
  let compoundedEquity = initialCapital;
  let benchmarkCompoundedEquity = initialCapital;
  for (const segment of usableSegments) {
    const candles = segment.candles;
    for (let startIndex = trainBars; startIndex + 1 < candles.length; startIndex += stepBars) {
      const endIndex = Math.min(candles.length - 1, startIndex + testBars - 1);
      if (endIndex - startIndex < 29) break;
      const result = direction === "short"
        ? backtestShortOnly(candles, { ...options, initialCapital, startIndex, endIndex })
        : backtestLongOnly(candles, { ...options, initialCapital, startIndex, endIndex });
      compoundedEquity *= result.metrics.finalEquity / initialCapital;
      benchmarkCompoundedEquity *= result.benchmark.finalEquity / initialCapital;
      windows.push({
        segmentIndex: segment.segmentIndex,
        segmentStartTime: segment.startTime,
        segmentEndTime: segment.endTime,
        startTime: candles[startIndex].time,
        endTime: candles[endIndex].time,
        startIndex,
        endIndex,
        totalReturnPct: result.metrics.totalReturnPct,
        benchmarkReturnPct: result.benchmark.totalReturnPct,
        excessReturnPct: result.metrics.totalReturnPct - result.benchmark.totalReturnPct,
        maxDrawdownPct: result.metrics.maxDrawdownPct,
        tradeCount: result.metrics.tradeCount,
        winRatePct: result.metrics.winRatePct,
        profitFactor: result.metrics.profitFactor,
        sharpe: result.metrics.sharpe,
        sortino: result.metrics.sortino,
        haltedByDrawdown: result.haltedByDrawdown
      });
      segmentSummary[segment.segmentIndex - 1].windowCount++;
    }
  }
  const returns = windows.map(window => window.totalReturnPct / 100);
  const benchmarkReturns = windows.map(window => window.benchmarkReturnPct / 100);
  const excessReturns = windows.map(window => window.excessReturnPct);
  const compoundedReturnPct = (compoundedEquity / initialCapital - 1) * 100;
  const benchmarkCompoundedReturnPct = (benchmarkCompoundedEquity / initialCapital - 1) * 100;
  const available = windows.length >= minimumWindows;
  const evaluatedCandleCount = usableSegments.reduce((sum, segment) => sum + segment.candles.length, 0);
  const dataQualityStatus = degradedSegments.length
    ? "usable_with_degraded_segments_excluded"
    : segments.length > 1
      ? "usable_multiple_contiguous_segments"
      : (segments[0]?.quality.status || "unavailable");
  return {
    available,
    reason: available ? null : "insufficient_out_of_sample_windows",
    minimumWindowsRequired: minimumWindows,
    requiredCandlesForWindows,
    method: "rolling_fixed_strategy_oos_with_independent_contiguous_segments",
    strategy: String(options.strategy || "ema-trend"),
    direction,
    trainBars,
    testBars,
    stepBars,
    candleCount,
    evaluatedCandleCount,
    segmentCount: segments.length,
    evaluatedSegmentCount: usableSegments.length,
    excludedDegradedSegmentCount: degradedSegments.length,
    dataQuality: {
      status: dataQualityStatus,
      segmentCount: segments.length,
      evaluatedSegmentCount: usableSegments.length,
      excludedDegradedSegmentCount: degradedSegments.length,
      segments: segmentSummary
    },
    windowCount: windows.length,
    initialCapital,
    compoundedFinalEquity: compoundedEquity,
    compoundedReturnPct,
    benchmarkCompoundedFinalEquity: benchmarkCompoundedEquity,
    benchmarkCompoundedReturnPct,
    compoundedExcessReturnPct: compoundedReturnPct - benchmarkCompoundedReturnPct,
    averageWindowReturnPct: returns.length ? (mean(returns) ?? 0) * 100 : null,
    averageWindowBenchmarkReturnPct: benchmarkReturns.length ? (mean(benchmarkReturns) ?? 0) * 100 : null,
    averageWindowExcessReturnPct: excessReturns.length ? mean(excessReturns) : null,
    windowsOutperformingBenchmark: windows.filter(window => window.excessReturnPct > 0).length,
    outperformanceWindowRatePct: windows.length
      ? windows.filter(window => window.excessReturnPct > 0).length / windows.length * 100
      : null,
    worstWindowReturnPct: windows.length ? Math.min(...windows.map(window => window.totalReturnPct)) : null,
    worstWindowBenchmarkReturnPct: windows.length ? Math.min(...windows.map(window => window.benchmarkReturnPct)) : null,
    worstWindowDrawdownPct: windows.length ? Math.max(...windows.map(window => window.maxDrawdownPct)) : null,
    totalTrades: windows.reduce((sum, window) => sum + window.tradeCount, 0),
    windows,
    exchangeOrdersPlaced: 0,
    caveat: `Fixed parameters are evaluated on sequential unseen windows within independently trained contiguous data segments and compared with ${direction === "short" ? "cash/no-trade" : "buy-and-hold"} over identical windows. No window crosses a detected severe gap. This does not eliminate regime dependence or multiple-testing bias and is not a live result.`
  };
}

export const researchInternals = Object.freeze({
  percentile,
  standardDeviation,
  normalizeCandles,
  latestContiguousSegment,
  contiguousCandleSegments,
  forecastHasStatisticalEdge,
  signalAt,
  emaSeries,
  rsiSeries,
  atrSeries,
  rollingVolatility,
  calcEwmaVariance,
  getTrend
});
