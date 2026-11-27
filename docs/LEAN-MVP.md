# Lean Tabdeal Spot MVP

Last reviewed: 2026-11-27

## Decision

Stop expanding the research universe and stop using the private Nobitex repository's GitHub Actions runner as a dependency for the Tabdeal MVP.

The first operational lane is deliberately narrow:

- Venue: **Tabdeal Spot only**.
- Instrument: **BTCUSDT only** (USDT quote; no IRT conversion).
- Decision timeframe: **closed 4h candles**.
- Shadow trend context: **Kraken Spot XBT/USD closed 4h OHLC only** (USD reference; never an execution price). The offline/research history screen remains based on Binance Spot USDT candles collected by the public GitHub runner.
- Execution confirmation: **fresh Tabdeal Spot REST order book and current Spot market metadata only**.
- Order type for the first adapter: **LIMIT only**.
- Default mode: **Paper / no order**. The live adapter is fail-closed and is not deployed or enabled by this PR.

Kraken Spot `XBTUSD` is the current Shadow trend-context source because the Cloudflare Worker runtime returned HTTP 451 from `api.binance.com` and HTTP 403 from `data-api.binance.vision`; those Binance hosts are therefore excluded from the Worker runtime. Kraken's official OHLC API returns up to 720 entries and includes the current uncommitted candle; the Worker discards that candle, requires a fresh contiguous 4h series, and treats Kraken's quote as USD. EMA trend ratios are used only as context; the USD price is never compared with or substituted for Tabdeal's USDT price. Nobitex UDF candles remain archived/research-only until pair-level unit, freshness and gap checks are repeated. Do not use Tabdeal's single-page recent-trades endpoint as a candle or strategy source: a page at the 1,000-row cap is potentially truncated, and there is no documented cursor/sequence completeness contract.

## Research reduction

The previous 180-hypothesis/four-timeframe report remains useful as a one-time diagnostic, but hourly re-running all horizons is unnecessary. The scheduled screen is reduced to **one daily 4h-only report** (45 fixed rows: 5 registered symbols × 3 existing long-only rules × 3 cost cases). No new indicators, assets, timeframes, social channels or auxiliary API keys are added for the MVP.

A recent 4h screen found no candidate that remained profitable in all three provisional cost cases. In fact, none of the 4h rows was positive in the severe-cost case. This is the reason the MVP must remain Shadow/Paper for now; lowering the thresholds to manufacture a live signal would be a false shortcut. The purpose of the reduced screen is to detect a change, not to keep searching indefinitely.

## Source failure policy

| Source / dataset | MVP treatment | Reason |
|---|---|---|
| Kraken Spot XBTUSD 4h OHLC | Live Shadow trend context only | Public, no-key; current/open candle is excluded; USD is not converted to USDT |
| Binance Spot BTCUSDT 4h OHLCV | Offline research/history only | The research dataset was captured by public GitHub Actions; direct Worker fetch returned 451/403 and is not used in the live Shadow runtime |
| Tabdeal BTCUSDT Spot /depth | Required local execution check | Must be fetched fresh at decision/submit time; external prices are never executable quotes |
| Tabdeal exchangeInfo | Required local market-rule check | Verify active Spot pair and filters before any Paper/live request |
| Tabdeal /trades 1,000-row page | Excluded from signal history | Potential truncation; no documented completeness cursor |
| Tabdeal Spot WebSocket depth summaries | Diagnostic only | Snapshot/delta and recovery semantics remain insufficiently specified |
| Nobitex UDF candles | Excluded from active MVP | Historical data is stale and pair-specific unit/freshness checks need refresh |
| Kraken Spot | Optional cross-check only | Different quote currency (USD); not an executable Tabdeal price |
| Telegram channels / paid feeds / CoinGecko / auxiliary feeds | Not in MVP | Not required for the first signal/execution path; rights, latency or incremental value are not established |

If Kraken retrieval is unavailable or the returned candle series is stale/gapped, output **WAIT**. Do not silently convert Kraken USD to USDT or treat it as a Tabdeal price. If the Tabdeal book is stale, crossed, too wide or has insufficient depth, output **WAIT**. A missing source is a veto, not a reason to fabricate or blend prices.

## Minimal operating flow

1. Read closed Kraken XBTUSD 4h candles; validate time ordering, closure, duplicates and the latest contiguous segment. Keep the data labelled USD and use only percentage-based trend context.
2. Calculate the fixed EMA20/EMA50 trend rule already implemented in the shared research core. No parameter search.
3. Fetch current Tabdeal BTCUSDT Spot exchangeInfo and /depth; verify quote asset, active Spot status, spread, depth, order filters and local timestamp.
4. Apply the deterministic portfolio risk plan. Existing project defaults are 0.25% risk per trade, 20% maximum gross exposure, 2% daily-loss stop and 20% portfolio drawdown stop; no leverage or shorting.
5. Until forward Paper is separately enabled and reconciled, report the signal and local execution feasibility only. Never create a live order from the research workflow.

## Execution adapter

src/tabdeal-spot-execution.js adds a small signed Spot LIMIT request adapter based on the exchange's official SDK contract. It supports only:
- submit LIMIT order with caller-supplied unique newClientOrderId;
- query an order by exchange ID or client order ID;
- cancel one order by ID.

It intentionally excludes market orders, futures, margin, withdrawal, deposit, transfers and bulk cancellation. It never retries a POST. If a submit times out or returns an uncertain server response, it queries the same client order ID once and returns unknown_submission_state_halt if it cannot reconcile. The adapter does not read, print or store credentials.

Live submission requires all of the following at runtime: explicit live flag, kill switch off, separate owner approval, portfolio risk checks passed, a positive max-notional cap and an approved risk plan matching the submitted quantity. Defaults make live submission impossible. Tests use fake credentials and mocked network responses; they do not call Tabdeal.

Official interface references:
- Kraken public Spot OHLC (4h, max 720 entries; last candle uncommitted): https://docs.kraken.com/api-reference/market-data/get-ohlc-data
- https://github.com/Tabdeal-Exchange/tabdeal-python/blob/master/tabdeal/spot.py
- https://github.com/Tabdeal-Exchange/tabdeal-python/blob/master/tabdeal/client.py
- https://github.com/Tabdeal-Exchange/tabdeal-api-postman/blob/master/Tabdeal-API-Postman.postman_collection.json

The official SDK documents Spot order submission at POST /api/v1/order, private order query on the signed read API, and cancellation at DELETE /api/v1/order. No official Spot testnet endpoint has been established in the sources reviewed. Therefore no live order is sent to "test" the adapter.

## Repository and deployment boundary

- This public repository is the source for public market data, reusable strategy/risk code and the sanitized adapter.
- Cloudflare Worker secrets and D1 bindings stay in Cloudflare; none are copied into GitHub source.
- The existing private nobitex-ai-trader repository is now a legacy/private operations and Nobitex archive. It must not be required for routine public-data collection, research or adapter unit tests.
- The current deployed Cloudflare market-ingest Worker is a separate runtime from GitHub Actions and continues to collect public Tabdeal snapshots on its own one-minute Cron. It is not an order executor.
- This PR does **not** migrate or redeploy that Worker, add a new Cron, alter D1, install secrets, or enable any order. A separate reviewed deployment change is still required to run the adapter in a Cloudflare Worker.

## Acceptance gates

A positive historical result is not a guarantee. The next acceptance sequence is:
1. Public CI passes the adapter signature/parameter/recovery tests.
2. Read-only Tabdeal account preflight verifies API scope, actual Spot eligibility, pair filters and fee schedule without printing balances or credentials.
3. A forward Shadow/Paper record confirms signals against fresh local Tabdeal books and reconciles simulated fills and fees.
4. A separate deployment review moves the public Worker source to Cloudflare with the API credentials stored only as Worker secrets; live order code remains off.
5. Only after a stable Paper record and explicit dated owner approval may a small capped live pilot be enabled.

No order, account read, deposit, withdrawal, transfer, D1 write, Worker deployment or schedule change is authorized by this source PR.
