# Repository relationship and shared components

Last audited: **2026-11-26**.

## Two repositories, one project lineage

- **Private integration/core repository:** [Mehran0960/nobitex-ai-trader](https://github.com/Mehran0960/nobitex-ai-trader). It holds the broader research/risk codebase, Tabdeal-specific private ingestion/operations, and infrastructure-specific configuration. Access is private; credentials, account data, Worker/D1 details and operational logs stay there.
- **Public research companion:** [Mehran0960/tabdeal-ai-trader-public](https://github.com/Mehran0960/tabdeal-ai-trader-public) (this repository). It is a sanitized, credential-free, publicly reviewable research slice for the Tabdeal Spot lane. It deliberately has no authenticated account client or live order executor.

Do not describe these as independent trading systems. Their reusable research and risk components are related and must remain traceable across repositories.

## Verified byte-identical files

The following paths were compared between the default main branches on 2026-11-26. Each listed file had the exact same Git blob SHA in both repositories at the time of audit; identical blob IDs mean byte-for-byte identical file contents.

| Shared source path | Git blob SHA |
|---|---|
| src/research.js | 5542124690384a8eb9ccf57b21e4e5e7436777e3 |
| src/risk.js | 1cbfeb4f1faca14420413d7b4c9d344e279aa8f8 |
| src/paper-engine.js | 6e963b562e6e89ced034cc9a711b2202984934e3 |
| src/paper-simulate.js | 1846b88b8458bd7e0ff9823068617ef54c2a5ddf |
| src/paper-candidate-policy.js | c886b2e93b616106ea7645a5b2d1dabf6378131b |
| src/market-intelligence.js | 67ec49e2c8518612973b8b5ace6d7ded46578c97 |
| src/price-units.js | 73fd6c5ca31c2e3c2bcc2e7c169daf72a0dc5735 |
| src/tabdeal-public-api.js | dd3787a3aa1e85abf63500e782f002ccd6707ebb |

The eight identical test files are src/paper-candidate-policy.test.js plus tests/research.test.js, tests/risk.test.js, tests/paper-engine.test.js, tests/paper-simulate.test.js, tests/market-intelligence.test.js, tests/price-units.test.js and tests/tabdeal-public-api.test.js. The extra test under src has blob SHA c1abfed4ee4360d04883bef0724f81fc1e1c1e1a.

This is an audited snapshot, not a claim that all repository files are the same. In particular, market-data collectors, Tabdeal ingestion, workflows and private operational code differ by repository and venue responsibility. Recheck blob IDs when syncing changes.

## Ownership and synchronization rule

1. Treat the private repository as the coordination point for the reusable research/risk core and the private Tabdeal operational integration.
2. When a shared, venue-neutral module changes, run its tests in the private repository, then mirror only the sanitized shared file and matching tests into this public repository. Record the upstream repository, source commit SHA, file path and blob SHA in the change/PR description.
3. Do not copy private credentials, account output, secret names/values, private logs, Worker URLs, D1 identifiers or operational configuration into this repository.
4. Keep venue-specific adapters separate. A matching file path does not prove a matching contract; inspect source, market rules and tests before reusing any exchange adapter.
5. If a shared file is changed here for a Tabdeal-specific reason, explicitly record the divergence and decide whether the generic core or the Tabdeal adapter owns the change. Never let silent drift accumulate.

## Signal discovery and execution boundary

**Signal discovery should use reliable, reachable international public market data. Tabdeal remains the intended execution venue.** The planned source order is:

- **Binance Spot public market data:** first candidate for liquid-market OHLCV, trades/aggregate trades, order-book context and public historical files. The private repository already contains src/global-reference.js for a narrow Binance BTCUSDT context reference; it is not a complete multi-source discovery pipeline.
- **Kraken Spot public REST/WebSocket:** independent OHLC, trades and order-book source for cross-validation and resilience.
- **CoinGecko:** optional broad-market regime and asset metadata context, not a substitute for exchange-grade intraday tape or a local execution book. Current free Demo access requires a Demo API key, so it is not part of the no-key core path.

Official source references: [Binance Market Data Only](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md), [Binance Spot REST](https://developers.binance.com/docs/binance-spot-api-docs/rest-api), [Kraken Spot REST OHLC](https://docs.kraken.com/api-reference/market-data/get-ohlc-data), [Kraken Recent Trades](https://docs.kraken.com/api-reference/market-data/get-recent-trades), [Kraken Spot WebSocket v2 ticker](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker), and [CoinGecko Demo key setup](https://support.coingecko.com/articles/9471335603-user-guide-how-to-sign-up-for-coingecko-demo-api-and-generate-an-api-key).

Before relying on any provider, verify official terms, no-key availability, quotas, pagination, timestamp semantics, asset/quote mapping and actual reachability from the GitHub Actions runner. Do not require a paid API for the initial path.

The intended pipeline is:

**International public feeds → normalized, quality-checked history → candidate signal discovery → local Tabdeal Spot confirmation → forward Paper → separately reviewed live gate**

A foreign venue's price is never an executable Tabdeal price. Compare like-for-like symbols and quote assets, align timestamps, quantify cross-venue basis/latency/liquidity divergence, and confirm the signal with a fresh Tabdeal Spot book, local fee schedule, minimum order constraints and verified quote units. Do not silently convert USD/USDT/IRT/RIAL/TOMAN. If any required local fact is unresolved, the result is WAIT/no-trade.

## Current evidence blockers to keep visible

- The documented Tabdeal Spot depth stream currently lacks a confirmed snapshot-vs-delta/sequence-recovery contract; depth-derived metrics are provisional.
- The two probed Binance-style Tabdeal Spot trade topics (@trade and @aggTrade) were rejected with INVALID_FORMAT. Do not guess a different undocumented topic or use a leveraged/FAPI feed as a Spot substitute.
- The public Tabdeal signal page is not a versioned official API and currently returns only a subset of its reported events.
- IRT denomination/settlement semantics remain unverified.
- The international history now contains quality-checked Binance Spot 4h OHLCV for BTC/ETH/SOL/XRP over the collected period; this is research-grade historical input for those specific series, not a complete multi-source execution feed. Tabdeal-local depth/trade history remains sparse/provisional and is not yet execution-grade.

These limitations are why international public OHLCV/trade sources are the next signal-discovery priority rather than spending more time guessing Tabdeal endpoints.


## Current research outcome — 2026-11-26

The public companion's scheduled architecture now covers five pre-registered assets (BTC, ETH, SOL, XRP, DOGE) across 15m/1h/4h. After adding DOGE, the automatic history-mode selector detected missing series and performed a full backfill. Capture run [45797397256](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45797397256) recorded 80,085 Binance closed candles, 10,800 Kraken closed candles (including DOGE/USD via XDGUSD), 5/5 Tabdeal USDT books, 10,800 cross-venue comparisons and zero source errors. It appended 35,050 records to the history branch.

The latest strategy screen ([45797841288](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45797841288)) read 101,806 history records and evaluated 135 fixed hypotheses on 80,189 selected Binance Spot USDT candles. All 15 asset/timeframe series were fresh; no duplicates or missing intervals were detected. Zero candidates passed OOS net return, benchmark consistency, drawdown, global multiple-testing and untouched-holdout gates. DOGE was net-negative in all 27 of its hypotheses.

Public CI passed 120/120 tests ([45797841439](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45797841439)). No forward Paper candidate currently exists. The public repository remains credential-free, has no account client or live executor, and has placed no exchange orders. Do not lower gates or create simulated positions just to produce activity.

## Relationship to paused automation

The private repository's current D-109 direction paused unrelated automatic Nobitex/Binance/alternative-provider workflows when they do not support the Tabdeal lane. This record does **not** authorize reactivating those old workflows. Use the reusable research code and data-source findings as references, and build a separately scoped, read-only Tabdeal international-source scout with its own reachability and quality evidence. Keep current execution scope Spot-only and live trading disabled until all gates pass.

## Next implementation milestones

1. Add a small, read-only international-source capability/reachability probe in this repository, starting with Binance Spot and Kraken Spot.
2. Record a source matrix with terms, rate limits, timestamp/quote units, historical coverage, pagination and runtime reachability.
3. Build normalized multi-source OHLCV/trade history with provenance, gap/duplicate/order checks and independent cross-source comparisons.
4. Discover and pre-register candidate signals from that history; compare against robust baselines with realistic costs and multiple-testing controls.
5. Confirm any candidate using Tabdeal Spot-local data, then run forward Paper. No candidate is live-approved merely because an external venue produced a signal.
