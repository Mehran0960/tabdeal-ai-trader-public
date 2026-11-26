# Tabdeal AI Trader — Public Research Core

> **Current automated status — 2026-11-26:** the research collector now pre-registers four horizons (15m/1h/4h/1d). The latest completed report still covers the original three intraday horizons: 80,189 Binance Spot candles across five assets and 135 hypotheses; **zero candidates passed**. The new daily profile is being added with 60 non-overlapping 30-day OOS windows and a strict minimum of 2,563 closed daily candles per symbol before its 80/20 research split can qualify; a full 3,650-day backfill is triggered on merge, followed by a fresh research run. Paper promotion and live trading remain disabled. [Previous completed report](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45797841288) · [Previous report artifact](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45797841288/artifacts/15106840785).

This repository is the sanitized, public research companion to the private operations repository [nobitex-ai-trader](https://github.com/Mehran0960/nobitex-ai-trader).


## Relationship to the private core project

This repository is the sanitized public research companion to the private [nobitex-ai-trader](https://github.com/Mehran0960/nobitex-ai-trader) repository. The two repositories are related parts of one engineering effort, not independent bots. The private repository contains the broader shared research/risk code and operational integration; this repository exposes a credential-free, reviewable Tabdeal research slice. The audited shared-file list, exact Git blob IDs, update/synchronization rule and security boundary are documented in [Repository relationship and shared components](docs/REPOSITORY-RELATIONSHIP.md).

As audited on 2026-11-26, eight source modules and eight test files (including one test file stored under src) in the two repositories have identical Git blob IDs. This proves byte-for-byte identity for those files at the audit point; it does not mean every file, venue adapter, workflow or deployment is shared.

## Signal discovery is international; execution remains Tabdeal Spot

The active research lane now collects international public market history and screens pre-registered candidate strategies from Binance Spot USDT data. Binance Spot and Kraken Spot remain source inputs; each candidate still requires independent confirmation against fresh Tabdeal Spot data before any paper order is considered. External prices are research inputs, never Tabdeal execution prices. Match quote currencies, timestamps, pair identity and local basis; do not convert IRT to RIAL/TOMAN or infer an executable local price without verified semantics. The source reachability/terms/rate-limit matrix must be tested from the actual GitHub Actions runtime. See [Operating plan](docs/OPERATING-PLAN.md) and [Issue #10](https://github.com/Mehran0960/tabdeal-ai-trader-public/issues/10). Social-channel names are human-review leads only. Telegram bulk scraping/aggregation for AI/ML research is blocked by Telegram's current terms absent the explicit permissions/consents they require; use only licensed provider APIs/feeds or other data sources with explicit rights. See [Social signal discovery policy](docs/SOCIAL-SIGNAL-DISCOVERY.md). Alternative.me daily Bitcoin Fear & Greed is the only new auxiliary feed cleared for scheduled capture; its collector has completed an initial history load and applies attribution plus a conservative 24-hour lag. Coin Metrics Community and DefiLlama passed narrow technical probes but remain excluded from recurring collection and strategy use pending written data-use rights. See [Auxiliary data sources](docs/AUXILIARY-DATA-SOURCES.md).

## Scope

- Read-only access to Tabdeal public Spot market endpoints.
- Market-structure summaries (order book and recent-trade snapshots).
- Short, unauthenticated Spot order-book WebSocket sampling for spread and liquidity diagnostics.
- Read-only capture of public Tabdeal market-event signals, with explicit first-page coverage and freshness metadata.
- Research and risk-analysis functions.
- Backtest helpers and a paper-simulation engine.
- Automated syntax checks and tests on GitHub Actions.
- Scheduled international Spot history capture every 15 minutes and hourly fixed-cost multi-timeframe out-of-sample strategy research across pre-registered 15m/1h/4h/daily profiles; daily backfill is bounded at 3,650 days.

**This repository does not contain an authenticated account client or a live order executor.** It cannot read balances, place/cancel orders, withdraw, transfer funds, or enable live trading. The scanner uses public GET endpoints only and requires no API key. Daily Bitcoin Fear & Greed history from Alternative.me is captured separately with explicit attribution and a one-day conservative historical availability lag; it is context only, not an entry signal.

## Important data limitations

- The current public trades endpoint is queried as a single recent page (up to 1,000 records). A capped page is flagged as potentially truncated; an uncapped page is still not assumed to be complete history.
- Recent trades and a single order-book snapshot are not a validated candle history. The scanner does not fabricate OHLC candles from them. The public Spot WebSocket documentation lists order-book updates only. A passive probe of the Binance-style `@trade` and `@aggTrade` topics on 2026-11-25 returned `INVALID_FORMAT` for both; these are not usable Spot streams. The depth feed is used for provisional liquidity/spread diagnostics, not trade signals; the docs do not fully specify snapshot-vs-delta synchronization, so these metrics are not execution-grade yet.
- IRT quote-unit and settlement semantics remain unverified. The code keeps IRT marked as `IRT_UNVERIFIED` in market snapshots and Spot depth history; it must not be silently treated as RIAL or TOMAN.
- Alternative.me Fear & Greed is a daily Bitcoin-oriented composite index, not an altcoin-specific trade signal. Historical observations are conservatively treated as unavailable until 24 hours after their source timestamp, and any displayed use retains the required `Data from Alternative.me` attribution.
- The public signal page is parsed as an HTML/Nuxt payload, not a stable official API. Only the first returned page is captured when pagination is incomplete; rows are candidate-discovery metadata, not entry signals. The latest observed scheduled capture ([run 45784659336](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45784659336)) found the source page about 18h 55m old and returned only 10/14 rows; it was correctly marked stale and ineligible for trade research. This workflow does not collect Telegram signals.
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
npm run international:research
npm run sentiment:collect
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

The preferred result may be **no trade**. No return is guaranteed. Third-party social-channel recommendations are not executable instructions; they remain research-only until the full policy in [Social signal discovery](docs/SOCIAL-SIGNAL-DISCOVERY.md) is satisfied.

## Public/private separation

Never place API keys, account data, private logs, Cloudflare account identifiers, database IDs, Worker URLs, or personal contact details in this repository. The private operations repository remains the canonical location for credentials and infrastructure-specific configuration.
