# Operating plan

## Project boundary

Tabdeal Spot is the intended execution venue. International public market data is the next-stage signal-discovery and historical-research input. These roles must stay separate: a Binance/Kraken/CoinGecko observation is not an executable Tabdeal quote or an order instruction.

The shared research, risk, price-unit and paper-simulation core is maintained in coordination with the private nobitex-ai-trader repository. See [Repository relationship and shared components](REPOSITORY-RELATIONSHIP.md). Do not duplicate or silently fork shared logic.

## Verified current state — 2026-11-26

- **International sources:** Binance Spot and Kraken Spot public GET probes work from GitHub Actions. Kraken's DOGE/USD pair uses the XDGUSD alias; no USD/USDT price conversion is inferred. CoinGecko remains optional.
- **History capture:** configured every 15 minutes at minute 05/20/35/50. After DOGE was registered, the auto-mode selector correctly chose a full backfill because one or more asset/timeframe series were missing. Backfill run [45797397256] completed successfully: 80,085 Binance closed candles, 10,800 Kraken closed candles, 5/5 Tabdeal USDT books, 10,800 cross-venue return comparisons, zero source/series errors. The append step added 35,050 records and identified 66,640 as duplicates already in the append-only history. This was a push-triggered backfill; scheduled cron delivery must still be monitored independently.
- **Research cadence:** configured hourly at minute 12. Latest post-backfill report [run 45797841288] completed successfully and read 101,806 historical records.
- **Research coverage:** 80,189 closed Binance Spot USDT candles across BTC, ETH, SOL, XRP and DOGE: 14,475 (15m), 43,815 (1h), and 21,899 (4h). All 15 asset/timeframe series were fresh; no gaps or duplicates were detected.
- **Strategy screen:** 135 fixed hypotheses (5 assets × 3 timeframes × 3 long-only strategies × 3 cost scenarios), one global Benjamini-Hochberg correction, exact sign tests, and an 80/20 discovery/untouched-holdout split. **Zero candidates passed.**
- **Net-positive OOS cases:** 15m 0/45; 1h 1/45 (XRP Donchian base +0.398%, but worst-window drawdown 1.595% breached the 1% gate and the untouched holdout returned -1.190%); 4h 4/45 (3 base, 1 moderate). The best 4h case was XRP Donchian base +2.445%, but its q-value was 0.09035 (>0.05) and benchmark-outperformance window rate was 57.41% (<60%). All severe-cost cases were unprofitable. DOGE was net-negative in all 27 of its hypotheses.
- **Decision:** forward Paper for Tabdeal remains **blocked by research evidence and local execution-data gaps**. Do not force a Paper trade or loosen gates to create activity. Live execution is not implemented and remains disabled.
- **Tabdeal signal-page freshness:** the latest observed scheduled run [45784659336](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45784659336) succeeded operationally but its source page was ~18h 55m old and only 10/14 rows were returned; it was correctly marked stale and excluded from trading research. This source is not a social-channel feed.
- **Social-channel lane:** research-only policy is recorded in [SOCIAL-SIGNAL-DISCOVERY.md](SOCIAL-SIGNAL-DISCOVERY.md). A public tracker such as Litmusignals may assist channel screening, but its hit-rate/fingerprint archive is not a Tabdeal net-P&L record and does not replace prospective message capture. No Telegram source is allowlisted or enabled.
- **Latest evidence:** [research run 45797841288](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45797841288) · [report artifact](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45797841288/artifacts/15106840785) · [backfill run 45797397256](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45797397256) · [public CI 120/120](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45797841439).

## Stage 1 — international source discovery (initial reachability complete; ongoing quality monitoring)

Build a read-only source matrix and probe the sources from the actual GitHub Actions runtime:

1. **Binance Spot public market data** — start with public klines/OHLCV, trades or aggregate trades, book ticker/depth and public historical files where useful. Prefer market-data-only/no-key endpoints. Reuse the documented context-only Binance reference in the private project as a code/reference starting point, not as proof that the whole pipeline is already operational.
2. **Kraken Spot public REST/WebSocket** — evaluate OHLC, trades and order-book feeds as an independent source and cross-check against Binance.
3. **CoinGecko** — optional broad-market regime, asset metadata and independent sanity checks; current free Demo access requires a Demo API key. Do not rely on it as a substitute for exchange-grade intraday trades or order books.
4. **Public social-signal monitors (exploratory only)** — use Litmusignals and comparable public archives to discover public Telegram channels and detect edit/delete/copy-paste/pump risk. Their headline hit rates and external-venue prices are screening metadata, not net Tabdeal returns. The current Litmus archive contains hashes, timestamps and short text fragments rather than complete message bodies; any candidate channel must be captured prospectively from a terms-compliant public source and independently replayed. See [Social signal discovery policy](SOCIAL-SIGNAL-DISCOVERY.md).

For each provider, record official documentation, terms, rate limits, authentication requirements, symbol coverage, quote currency, timestamp units, historical depth, pagination, data freshness, GitHub Actions reachability, failure modes and fallback behaviour. The core discovery path uses no-key Binance Spot Market Data Only and Kraken public Spot market-data endpoints. CoinGecko is optional; its current free Demo access requires a Demo API key, so defer it unless a concrete research need justifies it. No paid API, account, transfer or private exchange secret is required for the initial path. Network reachability must be demonstrated in the real workflow runtime; do not assume that browser access or local access proves runner access.

## Stage 2 — normalize and cross-check against Tabdeal (partially complete)

Persist timestamped source observations with immutable provenance and explicit units. Validate candle close times, OHLCV invariants, gaps, duplicates, out-of-order rows, pagination completeness, reconnect behaviour and source freshness. Never fill missing bars merely to make a continuous chart.

Map only the same underlying asset and quote currency when comparing venues. Keep USDT, USD, IRT, RIAL and TOMAN distinct. Where quote currencies differ, require a separately verified conversion/reference and measure the local basis; otherwise mark the comparison unusable. Use external feeds to discover candidates, then confirm the candidate on Tabdeal with a fresh local Spot book, spread, depth, fees, minimum notional/lot size and verified price units. An external price must never be passed to the Tabdeal executor as if it were local.

Continue collecting Tabdeal public Spot order-book observations for local validation. Current depth-stream diagnostics remain provisional until Tabdeal confirms snapshot/delta and sequence semantics. The currently tested Binance-style Spot @trade/@aggTrade topic names were rejected; do not guess undocumented Tabdeal topics or substitute a leveraged/FAPI stream.

## Stage 3 — pre-registered strategy research (135-hypothesis five-asset multi-timeframe screen completed; no pass)

Evaluate deterministic hypotheses on sufficiently complete, timestamp-aligned multi-source history. Compare against simple trend/momentum and matched naive baselines. Use chronological train/validation/untouched holdout splits, walk-forward evaluation, multiple-testing correction, and realistic fees, spread, slippage, latency, partial fills and liquidity constraints. Order Block/SMC concepts remain optional unproven hypotheses; they are not a predetermined strategy or a reason to relax evidence requirements.

## Stage 4 — forward paper trading (blocked pending a research-qualified candidate)

Only promote independently validated candidates. Run a continuous forward Paper ledger using Tabdeal-local prices and order-book evidence, with restart/reconciliation, stale-data, duplicate-order, daily-loss, drawdown and kill-switch tests. Report net return, drawdown, trade count, exposure, costs and comparison to suitable benchmarks. A no-trade result is valid.

## Stage 5 — capped live pilot (not implemented and not authorized)

Requires all data and strategy gates to pass, written verification of Tabdeal account/API permissions and terms, a separately audited fail-closed execution adapter, independent reconciliation, hard risk limits and explicit owner approval. No live order path is present in this public repository. Never enable leverage, shorting, margin, transfers or withdrawals as part of this Spot project.
