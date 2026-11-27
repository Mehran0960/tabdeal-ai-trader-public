# Relative-asset rotation research and forward Paper

## Scope

This module evaluates a single, pre-registered relative-value rotation strategy across the initial Tabdeal USDT Spot universe:

- BTCUSDT
- ETHUSDT
- SOLUSDT
- XRPUSDT
- DOGEUSDT

The direct ETHBTC Spot pair was not present in the active Tabdeal Spot market snapshot captured on 2026-11-27. A BTC-to-ETH conversion therefore requires two markets: sell BTCUSDT, then buy ETHUSDT. The IRT markets are excluded because their denomination/settlement unit is not verified. Expanding beyond the five-asset universe requires matching historical candles and Tabdeal local books, not merely a market listing.

## Signal and execution separation

- Signal discovery uses closed Binance Spot 4h USDT candles stored in the append-only signal-history branch.
- Tabdeal Spot is the intended execution venue. Its local order books are stored separately and used only for Paper fills/readiness.
- Binance prices are never represented as Tabdeal executable quotes.
- The model requires synchronized 4h candles for all five symbols, keeps only the latest contiguous aligned segment, and fails closed on stale or insufficient history.
- No missing candle is fabricated or forward-filled.

## Fixed strategy

The strategy ID is relative-underperformance-with-trend-confirmation. It uses:

1. Each asset's 60-bar log return relative to the equal-weight geometric return of the other assets.
2. A z-score against the preceding 120 observations of that relative-return measure.
3. An absolute trend confirmation: EMA20 above EMA50, close above EMA50, and positive 12-bar absolute momentum.
4. Entry only when the relative z-score is at or below -1.0.
5. Exit when the held asset's z-score mean-reverts to +0.25 or its trend confirmation fails.
6. Rotation to another qualifying asset only when its z-score is at least 0.75 lower than the held asset's score and the minimum holding period has passed.

The signal is calculated at a closed 4h candle. Historical trades are conservatively modeled at the next candle open; the engine does not use the signal candle's close as an executable fill. Parameters are fixed in code and are not optimized on the holdout.

## Historical validation

- Chronological discovery/untouched-holdout split: 70% / 30%.
- Holdout starts with cash; the discovery sample is used only for indicator warm-up and does not carry a position into the holdout.
- Three per-order cost cases:
  - Base: 40 bps fee + 10 bps slippage.
  - Moderate: 50 bps fee + 25 bps slippage.
  - Severe: 75 bps fee + 50 bps slippage.
- A full asset-to-asset rotation incurs two orders (sell plus buy), so the estimated round-trip switch cost is 100 / 150 / 250 bps across the three cases.
- Each holdout case must have positive net return, outperform equal-weight buy-and-hold, keep max drawdown at or below 20%, and generate at least six rotations before forward Paper is promoted.
- BTC buy-and-hold is reported as a second benchmark, but the registered promotion gate is the equal-weight benchmark.
- The fee values are conservative provisional assumptions; exact account fee tiers/rebates have not been independently confirmed.

These thresholds are gates, not evidence that a persistent edge exists. Passing a backtest does not authorize live trading.

## Forward Paper

Forward Paper runs no more frequently than once per new closed 4h signal candle. It is promoted only after all three historical cost cases pass. The virtual account starts with 100 USDT; this is a simulation amount, not the user's exchange balance.

Paper entry/switch fills use the latest Tabdeal Spot top-five bid/ask levels, with:
- Maximum local book age: 30 minutes.
- Maximum spread: 35 bps.
- Minimum top-five quote depth on each side: 1,000 USDT.
- Maximum book-walk slippage: 25 bps plus a 5 bps latency buffer.
- Market LOT_SIZE, minimum quantity and minimum notional checks.
- Provisional fee: 40 bps per order.
- A 20% drawdown kill switch.

The market-history collector preserves only the best five book levels, not the full order book, to keep the append-only public history bounded. If a target or current-position book is unavailable, stale, too wide, too thin, or lacks valid market filters, the relevant Paper trade is blocked. If the sell leg succeeds but the buy leg cannot be filled, Paper remains in USDT and records the outcome rather than pretending the rotation completed.

Paper state and virtual trade events are stored on signal-history under data/relative-asset-rotation/state.json. It is idempotent by closed signal candle; repeated workflow runs cannot process the same signal twice.

## Safety boundary

This module:
- Uses public candle and public order-book history only.
- Does not read balances, API keys, private account endpoints, or exchange permissions.
- Does not submit, cancel, or reconcile exchange orders.
- Does not move real funds.
- Never enables live trading.

A separate execution adapter, verified account fees/permissions, realistic partial-fill handling, restart/ledger reconciliation, and an independent security review would be required before any real-money pilot could even be considered.
