# Dynamic Tabdeal rotation universe

This module establishes the first dynamic universe boundary for research expansion.

## Membership

A symbol is admitted only when all of the following hold:

- It is an active Spot market quoted in USDT on Tabdeal.
- The exact same symbol is an active Spot USDT market on Binance. Binance permission sets are interpreted using the documented OR-within-set / AND-across-sets rule; a Spot permission set qualifies public market-data discovery even if an additional account group would be required to place a Binance order. Binance is not the execution venue.
- Binance 24-hour quote turnover is at least 250,000 USDT and the 24-hour trade count is at least 500.
- Tabdeal provides valid LOT_SIZE, minimum-notional and PRICE_FILTER rules.
- The base asset is not a stablecoin/fiat quote proxy or a leveraged-token suffix.

The result is sorted by Binance quote turnover for inspection. This volume is only a discovery proxy; it is not substituted for Tabdeal-local liquidity, fees, spread or executable price.

## Coverage safety

The initial research safety cap is 200 markets. It is not a hidden truncation: if more than 200 symbols qualify, the report sets `status=capacity_exceeded`, `coverageComplete=false`, and reports the number omitted. Downstream strategy research must refuse to make a complete-universe claim or authorize a trade from a capped result.

The 200-market ceiling is a practical first-stage bound for historical data and local-book collection. It should be raised only after measured API weight, runner time, data storage and local book coverage demonstrate that the full eligible intersection can be collected without gaps or rate-limit pressure.

## Historical coverage

The dynamic history collector uses public Binance Spot 4h candles for up to 730 days and fetches fresh local Tabdeal order-book snapshots for every selected market. It runs on a four-hour schedule, appends deduplicated monthly history, and checkpoints each symbol's last confirmed closed candle.

The initial tournament pool is restricted to the highest-liquidity symbols in the manifest with at least 2,000 individually stored 4h candles. The tournament then requires synchronized, gap-free contiguous candles across the selected set and admits at most 20 symbols in one comparison. A listing is not eligible just because it exists; newly listed or incomplete symbols must accumulate adequate history first.

This is a staged research universe, not a claim that every Tabdeal Spot pair is covered. Binance 24h quote turnover selects the research priority order; it is not used as Tabdeal executable liquidity.

## Boundaries

- This is not a strategy and produces no buy/sell signal.
- Binance 24-hour turnover is not Tabdeal turnover.
- Binance candles are research inputs, never Tabdeal fills.
- Each eventual Paper fill still needs a fresh Tabdeal local order book and realistic two-leg execution costs.
- Assets not cross-listed on Binance are outside this first dynamic research intersection; the all-Tabdeal watcher continues to observe the broader local Spot market separately.
- IRT remains excluded until its settlement unit is verified.
- No private account data, API secrets, exchange orders or funds are used.
