# Strategy-family tournament — fixed research screen

## Purpose

Compare three pre-registered, long-only Spot strategy families on identical synchronized 4h history and identical execution-cost assumptions:

1. Relative-value rotation — selects a relatively weak asset only after its longer trend remains positive and a short-term reversal begins.
2. Cross-sectional momentum — selects the strongest positive-trend asset by volatility-adjusted 60-bar momentum.
3. Hybrid — uses a broad-market risk-on filter, requires positive trend and short-term reversal, and combines momentum rank with a penalty for excessive relative outperformance.

All families may hold USDT cash when no eligible asset exists. None uses leverage, shorts, borrow, or derivatives.

## Data and execution assumptions

- Signal source: closed Binance Spot USDT 4h candles.
- Universe: the latest dynamic manifest of active Tabdeal/Binance cross-listed USDT Spot markets, ordered by Binance 24h quote turnover; only symbols with at least 2,000 stored closed 4h candles are eligible, and up to 20 highest-priority symbols are compared on a synchronized gap-free contiguous segment.
- Dynamic history is backfilled up to 730 days and refreshed every four hours. The manifest has a 200-market first-stage cap; if more than 200 qualify, the report marks coverage incomplete and blocks Paper review.
- Simulated fills: next 4h candle open after the signal candle closes. The signal candle close is never used as a fill.
- Portfolio: long-only, at most 100% in one selected asset, otherwise cash.
- Initial virtual capital: 1,000 USDT.
- Costs are charged on every order:
  - Base: 40 bps fee + 10 bps slippage.
  - Moderate: 50 bps fee + 25 bps slippage.
  - Severe: 75 bps fee + 50 bps slippage.
- These costs remain provisional and are not confirmed account-specific Tabdeal fees.

## Validation and promotion gates

- One chronological 70% discovery/warm-up and 30% fixed out-of-sample split.
- Identical history and test bars for all strategies and all cost cases.
- Non-overlapping 30-bar OOS windows compare each strategy with an equal-weight hold benchmark.
- Benjamini-Hochberg correction is applied across the nine strategy/cost hypotheses.
- A family is eligible for a separate prospective Paper review only if all three cost cases independently have: positive net return, positive excess vs equal-weight, max drawdown no greater than 20%, at least six switches, at least 20 OOS windows, at least 60% winning windows, and FDR q no greater than 0.05.
- No family is automatically selected or promoted. Choosing among models is itself model selection; a future prospective forward-Paper period is required even if a historical family passes.

## Known limitations

- The dynamic collector covers only active Tabdeal/Binance cross-listed USDT Spot markets, up to 200 by discovery liquidity. It does not cover IRT markets or Tabdeal-only markets.
- Binance candle prices are not Tabdeal executable quotes.
- Historical order-book replay, account-specific fees, fee rebates, partial fills and latency are not included in this screen.
- Early-closed exchange candles are excluded individually. Their missing interval remains a gap; the engine never fabricates or forward-fills an OHLC candle. The cross-market tournament still requires a sufficiently long synchronized contiguous segment.
- The model is a research comparison, not a forecast or expected daily return.
- No private account data or credentials are read; no exchange orders are submitted; no funds move; live trading and Paper trading remain disabled by this tournament.
