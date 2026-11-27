# Tabdeal AI Trader — Public Research Core

> **Lean MVP direction — 2026-11-27:** the active path is being reduced to Tabdeal Spot BTCUSDT, 4h closed Binance Spot candles for signal context, and a fresh Tabdeal-local Spot book for execution checks. Broad research is reduced to one daily 4h screen; the 15m/1h/daily research profiles are no longer on the active schedule. The report read 124,639 historical records and selected 95,330 closed Binance Spot USDT candles across BTC/ETH/SOL/XRP/DOGE; 19 of 20 asset/timeframe profiles were research-ready (daily SOL history remains short). Two historically early-closed daily candles were explicitly excluded and their gap preserved. **180 hypotheses produced 171 available OOS results, 32 net-positive cases, and zero candidates passing all gates. Paper promotion and live trading remain disabled.** [Final report](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45884191273) · [JSON artifact](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45884191273/artifacts/15148638461) · [CI 134/134](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45884191277).

This repository is becoming the canonical public source for credential-free Tabdeal Spot MVP code, including the fail-closed execution adapter. Private credentials and Cloudflare bindings remain outside GitHub source. See [Lean MVP](docs/LEAN-MVP.md).


## Relationship to the private core project

The private [nobitex-ai-trader](https://github.com/Mehran0960/nobitex-ai-trader) repository is retained as a legacy/private Nobitex and Cloudflare operations archive. It still contains the previously deployed private Worker and D1 configuration, so that runtime is not automatically migrated by this PR. However, its GitHub Actions runner is no longer a prerequisite for the Tabdeal MVP's public CI, research or adapter unit tests. Cloudflare secrets and D1 bindings remain outside this repository. The audited code relationship and security boundary are documented in [Repository relationship and shared components](docs/REPOSITORY-RELATIONSHIP.md).

Some venue-neutral research and risk modules remain mirrored for compatibility. Shared files must be synchronized deliberately; the Tabdeal execution adapter in this repository is new and is not copied from the private repository.

## Signal discovery is international; execution remains Tabdeal Spot

The active Shadow runtime now uses Kraken Spot XBTUSD closed 4h candles only as USD trend context, plus a fresh Tabdeal BTCUSDT Spot book for local execution checks. Binance remains in offline research history captured through GitHub Actions; direct Cloudflare Worker requests to Binance returned 451/403 and are excluded from the runtime. Kraken USD is never converted to USDT or used as a Tabdeal execution price. Match quote currencies, timestamps, pair identity and local basis; do not convert IRT to RIAL/TOMAN or infer an executable local price without verified semantics. The source reachability/terms/rate-limit matrix must be tested from the actual GitHub Actions runtime. See [Lean MVP](docs/LEAN-MVP.md), [Operating plan](docs/OPERATING-PLAN.md) and [Issue #10](https://github.com/Mehran0960/tabdeal-ai-trader-public/issues/10). Social-channel names are human-review leads only. Telegram bulk scraping/aggregation for AI/ML research is blocked by Telegram's current terms absent the explicit permissions/consents they require; use only licensed provider APIs/feeds or other data sources with explicit rights. See [Social signal discovery policy](docs/SOCIAL-SIGNAL-DISCOVERY.md). Alternative.me daily Bitcoin Fear & Greed is the only new auxiliary feed cleared for scheduled capture; its collector has completed an initial history load and applies attribution plus a conservative 24-hour lag. Coin Metrics Community and DefiLlama passed narrow technical probes but remain excluded from recurring collection and strategy use pending written data-use rights. See [Auxiliary data sources](docs/AUXILIARY-DATA-SOURCES.md).

## Scope

- Read-only access to Tabdeal public Spot market endpoints.
- Market-structure summaries (order book and recent-trade snapshots).
- One-minute, public Spot recent-trade polling that builds exchange-local OHLCV candles from unseen trades only; no account key is used.\n- Short, unauthenticated Spot order-book WebSocket sampling for spread and liquidity diagnostics.
- Read-only capture of public Tabdeal market-event signals, with explicit first-page coverage and freshness metadata.
- Research and risk-analysis functions.
- Backtest helpers and a paper-simulation engine.
- Automated syntax checks and tests on public GitHub Actions.
- Scheduled public market-history capture every 15 minutes; the active strategy screen is reduced to one daily 4h-only run.

**The Spot execution adapter is fail-closed and not deployed or enabled.** It builds signed requests only for allowlisted BTCUSDT Spot LIMIT orders, order lookup and cancellation; sending a live request requires a separately approved capped-pilot configuration, a risk-approved position plan, and a verified local book/fee/unit preflight. No account key or secret is stored in this repository. The scanner uses public GET endpoints only and requires no API key. Daily Bitcoin Fear & Greed history from Alternative.me is captured separately with explicit attribution and a one-day conservative historical availability lag; it is context only, not an entry signal.

## Important data limitations

- The public trades endpoint still has no historical cursor and returns at most 1,000 recent records. The Shadow Worker polls BTCUSDT every minute and stores deduplicated 1m OHLCV aggregates. It may bootstrap the latest 240 minutes only when the returned page includes a real trade before the window start and a recent trade within 10 minutes; minutes with no trades are explicitly marked `no_trade` and carry forward the prior close with zero volume. Quote volume is derived from execution price × base quantity rather than the inconsistent raw `quoteQty` field. This is a bounded recent-window backfill, not arbitrary historical access.
- A single recent-trades page or order-book snapshot is not a validated candle history. The scanner does not fabricate OHLC candles; the separate forward collector builds bars only from captured Spot trades. The public Spot WebSocket documentation lists order-book updates only. A passive probe of the Binance-style `@trade` and `@aggTrade` topics on 2026-11-25 returned `INVALID_FORMAT` for both; these are not usable Spot streams. The depth feed is used for provisional liquidity/spread diagnostics, not trade signals; the docs do not fully specify snapshot-vs-delta synchronization, so these metrics are not execution-grade yet.
- IRT quote-unit and settlement semantics remain unverified. The code keeps IRT marked as `IRT_UNVERIFIED` in market snapshots and Spot depth history; it must not be silently treated as RIAL or TOMAN.
- Alternative.me Fear & Greed is a daily Bitcoin-oriented composite index, not an altcoin-specific trade signal. Historical observations are conservatively treated as unavailable until 24 hours after their source timestamp, and any displayed use retains the required `Data from Alternative.me` attribution.
- The public signal page is parsed as an HTML/Nuxt payload, not a stable official API. Only the first returned page is captured when pagination is incomplete; rows are candidate-discovery metadata, not entry signals. The latest observed scheduled capture ([run 45784659336](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45784659336)) found the source page about 18h 55m old and returned only 10/14 rows; it was correctly marked stale and ineligible for trade research. This workflow does not collect Telegram signals.
- TDEX is a separate decentralized swap path and is excluded from the automatic Spot executor.
- No strategy in this project is currently certified profitable. The latest 180-hypothesis four-horizon screen produced zero research candidates after global false-discovery, out-of-sample, drawdown and untouched-holdout gates. Paper/backtest results are hypotheses, not a promise of future returns.

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

The market scan writes a timestamped JSON file beneath `artifacts/tabdeal-market-data/`. The signal scan writes `artifacts/tabdeal-signal-events/latest.json`. The Shadow Worker stores only one-minute OHLCV aggregates in D1 and reports capture continuity at `/market-data/health`; the first poll establishes a baseline, and at least 240 consecutive closed minutes are required for a local 4h candle window. The scheduled signal workflow stores prospective, deduplicated observations in the separate `signal-history` branch. The Spot depth sampler listens to the official 2-second order-book stream for one minute per run and stores only aggregate microstructure summaries; it does not retain raw messages.

## Local Tabdeal indicators and forward-paper signal validation

The one-minute trade-candle stream now feeds a separate, explicitly exploratory BTCUSDT Spot signal monitor. On each new closed minute it validates a continuous 240-bar local window, calculates 1m EMA(9/21/50), Wilder RSI(14), ATR(14), MACD(12/26/9), and aligned 5m EMA(12/26), then records a pre-registered long-only signal or WAIT. Explicit `no_trade` bars remain in the time series with zero volume; missing or mixed-epoch bars block the evaluation.

A `BUY_CANDIDATE` is eligible for a forward-paper observation only if a contemporaneous public Tabdeal Spot order book also passes the existing conservative spread (≤30 bps) and two-sided depth (≥1,000 USDT per side within 0.25%) gates. The reference paper size is 50 USDT, not user capital. Each eligible signal is marked out 5, 15 and 60 minutes after the actual virtual-entry observation time. The first real-trade closed 1m candle at or after each horizon is used, with at most 3 minutes of measurement delay; no-trade carry-forward bars are excluded, and actual elapsed time is stored. Exit costs include the entry spread proxy and a 5 bps latency buffer; round-trip commission sensitivity is reported at 10, 20 and 40 bps per side because the user's actual fee tier has not yet been verified.

This is **fixed-horizon forward signal validation**, not a full stop/target position simulator and not the historical 4h strategy. It is deliberately separated from the existing historical OOS/FDR promotion gate. It does not read private account data, use API credentials, submit orders, move funds, or enable live trading. A positive short sample cannot qualify a strategy; the 1m experiment must build a sufficiently large prospective sample and then undergo separate holdout, costs, drawdown and risk validation.

The Worker exposes the recorded monitor at `/market-data/local-paper`. Records are deduplicated by symbol, strategy version and closed candle time and retained for 30 days.

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
