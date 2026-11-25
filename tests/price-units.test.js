import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_PRICE_UNIT,
  UDF_SOURCE_PRICE_UNIT,
  UDF_TO_RIAL_MULTIPLIER,
  getCanonicalPriceUnitStatus,
  normalizeUdfCandleToRial
} from "../src/price-units.js";

test("canonical settings open the price-unit gate only for Rial + UDF Toman × 10 + migration 4", () => {
  assert.equal(getCanonicalPriceUnitStatus({
    canonical_price_unit: "RIAL",
    udf_source_unit: "TOMAN",
    udf_to_rial_multiplier: "10",
    price_unit_migration_version: "4"
  }).ready, true);
  assert.equal(getCanonicalPriceUnitStatus({ canonical_price_unit: "RIAL" }).ready, false);
  assert.equal(getCanonicalPriceUnitStatus({
    canonical_price_unit: "RIAL",
    udf_source_unit: "TOMAN",
    udf_to_rial_multiplier: "1",
    price_unit_migration_version: "4"
  }).ready, false);
  assert.equal(getCanonicalPriceUnitStatus({
    canonical_price_unit: "TOMAN",
    udf_source_unit: "TOMAN",
    udf_to_rial_multiplier: "10",
    price_unit_migration_version: "4"
  }).ready, false);
});

test("normalizes each UDF OHLC price exactly 10x into Rials and leaves volume unchanged", () => {
  const candle = normalizeUdfCandleToRial({
    open: 100, high: 110, low: 90, close: 105, volume: 0.25
  });
  assert.deepEqual(candle, {
    open: 1000, high: 1100, low: 900, close: 1050, volume: 0.25,
    priceUnit: CANONICAL_PRICE_UNIT,
    sourcePriceUnit: UDF_SOURCE_PRICE_UNIT,
    conversionMultiplier: UDF_TO_RIAL_MULTIPLIER
  });
});

test("refuses an already-normalized or unexpected source unit to prevent double conversion", () => {
  assert.throws(() => normalizeUdfCandleToRial({
    open: 1000, high: 1100, low: 900, close: 1050, volume: 1, priceUnit: "RIAL"
  }), /unexpected_or_already_normalized/);
});

test("rejects malformed or non-positive prices and invalid OHLC relationships", () => {
  assert.throws(() => normalizeUdfCandleToRial({
    open: 0, high: 100, low: 1, close: 50, volume: 1
  }), /invalid_udf_open/);
  assert.throws(() => normalizeUdfCandleToRial({
    open: 100, high: 90, low: 80, close: 85, volume: 1
  }), /invalid_udf_ohlc_relationship/);
  assert.throws(() => normalizeUdfCandleToRial({
    open: 100, high: 110, low: 90, close: 105, volume: -1
  }), /invalid_udf_volume/);
});
