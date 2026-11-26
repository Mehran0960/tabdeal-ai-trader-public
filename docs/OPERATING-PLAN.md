# Operating plan

## Project boundary

Tabdeal Spot is the intended execution venue. International public market data is the next-stage signal-discovery and historical-research input. These roles must stay separate: a Binance/Kraken/CoinGecko observation is not an executable Tabdeal quote or an order instruction.

The shared research, risk, price-unit and paper-simulation core is maintained in coordination with the private nobitex-ai-trader repository. See [Repository relationship and shared components](REPOSITORY-RELATIONSHIP.md). Do not duplicate or silently fork shared logic.

## Verified current state — 2026-11-26

- **International source reachability:** initial Binance Spot and Kraken Spot public probes passed from GitHub Actions. CoinGecko remains optional only.
- **Historical research input:** the history branch contains 4h Binance Spot USDT candles for BTC, ETH, SOL and XRP. The latest screen validated 4,379 candles per asset (17,516 total), with zero detected duplicates or gaps and a fresh latest closed bar.
- **Strategy screen:** 36 fixed hypotheses (4 assets × 3 long-only strategies × 3 cost scenarios), 108 non-overlapping OOS windows per asset, an 80/20 discovery/untouched-holdout split, exact binomial sign test and Benjamini-Hochberg correction. The final report found **zero candidates passing all gates**.
- **Decision:** forward Paper for Tabdeal is **blocked by research evidence**, not merely awaiting a scheduler. Do not force a Paper trade or loosen gates to create activity. Live execution is not implemented and remains disabled.
- **Latest report:** [GitHub Actions run 45792326631](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45792326631) · [report artifact](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45792326631/artifacts/15102109708). The research workflow runs daily and can also be started manually.

## Stage 1 — international source discovery (initial reachability complete; ongoing quality monitoring)

Build a read-only source matrix and probe the sources from the actual GitHub Actions runtime:

1. **Binance Spot public market data** — start with public klines/OHLCV, trades or aggregate trades, book ticker/depth and public historical files where useful. Prefer market-data-only/no-key endpoints. Reuse the documented context-only Binance reference in the private project as a code/reference starting point, not as proof that the whole pipeline is already operational.
2. **Kraken Spot public REST/WebSocket** — evaluate OHLC, trades and order-book feeds as an independent source and cross-check against Binance.
3. **CoinGecko** — optional broad-market regime, asset metadata and independent sanity checks; current free Demo access requires a Demo API key. Do not rely on it as a substitute for exchange-grade intraday trades or order books.

For each provider, record official documentation, terms, rate limits, authentication requirements, symbol coverage, quote currency, timestamp units, historical depth, pagination, data freshness, GitHub Actions reachability, failure modes and fallback behaviour. The core discovery path uses no-key Binance Spot Market Data Only and Kraken public Spot market-data endpoints. CoinGecko is optional; its current free Demo access requires a Demo API key, so defer it unless a concrete research need justifies it. No paid API, account, transfer or private exchange secret is required for the initial path. Network reachability must be demonstrated in the real workflow runtime; do not assume that browser access or local access proves runner access.

## Stage 2 — normalize and cross-check against Tabdeal (partially complete)

Persist timestamped source observations with immutable provenance and explicit units. Validate candle close times, OHLCV invariants, gaps, duplicates, out-of-order rows, pagination completeness, reconnect behaviour and source freshness. Never fill missing bars merely to make a continuous chart.

Map only the same underlying asset and quote currency when comparing venues. Keep USDT, USD, IRT, RIAL and TOMAN distinct. Where quote currencies differ, require a separately verified conversion/reference and measure the local basis; otherwise mark the comparison unusable. Use external feeds to discover candidates, then confirm the candidate on Tabdeal with a fresh local Spot book, spread, depth, fees, minimum notional/lot size and verified price units. An external price must never be passed to the Tabdeal executor as if it were local.

Continue collecting Tabdeal public Spot order-book observations for local validation. Current depth-stream diagnostics remain provisional until Tabdeal confirms snapshot/delta and sequence semantics. The currently tested Binance-style Spot @trade/@aggTrade topic names were rejected; do not guess undocumented Tabdeal topics or substitute a leveraged/FAPI stream.

## Stage 3 — pre-registered strategy research (first fixed screen completed; no pass)

Evaluate deterministic hypotheses on sufficiently complete, timestamp-aligned multi-source history. Compare against simple trend/momentum and matched naive baselines. Use chronological train/validation/untouched holdout splits, walk-forward evaluation, multiple-testing correction, and realistic fees, spread, slippage, latency, partial fills and liquidity constraints. Order Block/SMC concepts remain optional unproven hypotheses; they are not a predetermined strategy or a reason to relax evidence requirements.

## Stage 4 — forward paper trading (blocked pending a research-qualified candidate)

Only promote independently validated candidates. Run a continuous forward Paper ledger using Tabdeal-local prices and order-book evidence, with restart/reconciliation, stale-data, duplicate-order, daily-loss, drawdown and kill-switch tests. Report net return, drawdown, trade count, exposure, costs and comparison to suitable benchmarks. A no-trade result is valid.

## Stage 5 — capped live pilot (not implemented and not authorized)

Requires all data and strategy gates to pass, written verification of Tabdeal account/API permissions and terms, a separately audited fail-closed execution adapter, independent reconciliation, hard risk limits and explicit owner approval. No live order path is present in this public repository. Never enable leverage, shorting, margin, transfers or withdrawals as part of this Spot project.
