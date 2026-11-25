# Tabdeal AI Trader — Public Research Core

This repository is the sanitized, public research companion to a separate private operations repository.

## Scope

- Read-only access to Tabdeal public Spot market endpoints.
- Market-structure summaries (order book and recent-trade snapshots).
- Short, unauthenticated Spot order-book WebSocket sampling for spread and liquidity diagnostics.
- Read-only capture of public Tabdeal market-event signals, with explicit first-page coverage and freshness metadata.
- Research and risk-analysis functions.
- Backtest helpers and a paper-simulation engine.
- Automated syntax checks and tests on GitHub Actions.

**This repository does not contain an authenticated account client or a live order executor.** It cannot read balances, place/cancel orders, withdraw, transfer funds, or enable live trading. The scanner uses public GET endpoints only and requires no API key.

## Important data limitations

- The current public trades endpoint is queried as a single recent page (up to 1,000 records). A capped page is flagged as potentially truncated; an uncapped page is still not assumed to be complete history.
- Recent trades and a single order-book snapshot are not a validated candle history. The scanner does not fabricate OHLC candles from them. The public Spot WebSocket currently provides order-book updates only; it is used for liquidity/spread diagnostics, not trade signals.
- IRT quote-unit and settlement semantics remain unverified. The code keeps IRT marked as `IRT_UNVERIFIED` in market snapshots and Spot depth history; it must not be silently treated as RIAL or TOMAN.
- The public signal page is parsed as an HTML/Nuxt payload, not a stable official API. Only the first returned page is captured when pagination is incomplete; rows are candidate-discovery metadata, not entry signals.
- TDEX is a separate decentralized swap path and is excluded from the automatic Spot executor.
- No strategy in this project is currently certified profitable. Paper/backtest results are hypotheses, not a promise of future returns.

## Run locally

Requires Node.js 22 or later. No third-party npm dependencies are required.

```bash
npm run check
npm test
npm run market:scan
npm run signals:scan
npm run ws:spot-depth
```

The market scan writes a timestamped JSON file beneath `artifacts/tabdeal-market-data/`. The signal scan writes `artifacts/tabdeal-signal-events/latest.json`. These artifacts are ignored by Git. The scheduled signal workflow stores prospective, deduplicated observations in the separate `signal-history` branch. The Spot depth sampler listens to the official 2-second order-book stream for one minute per run and stores only aggregate microstructure summaries in the same history branch; it does not retain raw messages.

## Research and execution gates

Do not treat a strategy as eligible for real-money use until it has:
1. Timestamped, sufficiently complete market history with duplicate/gap/out-of-order controls.
2. Verified quote units, exchange fees, minimum order sizes, and execution constraints.
3. Pre-registered strategy rules and an untouched out-of-sample holdout.
4. Walk-forward and multiple-testing controls, with realistic fees, spread, slippage, partial fills, and latency.
5. A sustained forward paper record with independent reconciliation and drawdown/kill-switch tests.
6. A separately audited fail-closed execution adapter and explicit owner approval for any capped live pilot.

The preferred result may be **no trade**. No return is guaranteed.

## Public/private separation

Never place API keys, account data, private logs, Cloudflare account identifiers, database IDs, Worker URLs, or personal contact details in this repository. The private operations repository remains the canonical location for credentials and infrastructure-specific configuration.
