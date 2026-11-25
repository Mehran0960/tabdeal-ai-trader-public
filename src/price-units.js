export const CANONICAL_PRICE_UNIT = "RIAL";
export const UDF_SOURCE_PRICE_UNIT = "TOMAN";
export const UDF_TO_RIAL_MULTIPLIER = 10;
export const PRICE_UNIT_MIGRATION_VERSION = "4";

export function getCanonicalPriceUnitStatus(settings = {}) {
  const canonicalPriceUnit = String(settings.canonical_price_unit || "").toUpperCase();
  const sourcePriceUnit = String(settings.udf_source_unit || "").toUpperCase();
  const multiplier = Number(settings.udf_to_rial_multiplier);
  const migrationVersion = String(settings.price_unit_migration_version || "");
  const ready = canonicalPriceUnit === CANONICAL_PRICE_UNIT &&
    sourcePriceUnit === UDF_SOURCE_PRICE_UNIT &&
    multiplier === UDF_TO_RIAL_MULTIPLIER &&
    migrationVersion === PRICE_UNIT_MIGRATION_VERSION;
  return {
    ready,
    canonicalPriceUnit: canonicalPriceUnit || null,
    sourcePriceUnit: sourcePriceUnit || null,
    conversionMultiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : null,
    migrationVersion: migrationVersion || null
  };
}

export function normalizeUdfCandleToRial(candle = {}) {
  if (candle.priceUnit && String(candle.priceUnit).toUpperCase() !== UDF_SOURCE_PRICE_UNIT) {
    throw new TypeError("unexpected_or_already_normalized_udf_price_unit");
  }
  const values = ["open", "high", "low", "close"];
  const normalized = {};
  for (const key of values) {
    const value = Number(candle[key]);
    if (!Number.isFinite(value) || value <= 0) throw new TypeError("invalid_udf_" + key);
    normalized[key] = value * UDF_TO_RIAL_MULTIPLIER;
  }
  const volume = Number(candle.volume);
  if (!Number.isFinite(volume) || volume < 0) throw new TypeError("invalid_udf_volume");
  if (normalized.high < Math.max(normalized.open, normalized.close, normalized.low) ||
      normalized.low > Math.min(normalized.open, normalized.close, normalized.high)) {
    throw new RangeError("invalid_udf_ohlc_relationship");
  }
  return { ...normalized, volume, priceUnit: CANONICAL_PRICE_UNIT, sourcePriceUnit: UDF_SOURCE_PRICE_UNIT, conversionMultiplier: UDF_TO_RIAL_MULTIPLIER };
}
