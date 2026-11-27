# Continuous Tabdeal Spot market watch

## Purpose and current boundary

This module expands market observation beyond the earlier fixed five-symbol, 4h research screen. It dynamically discovers active Spot markets in exchangeInfo, watches USDT-quoted and IRT-quoted Spot markets in separate quote-unit groups, can normalize BTC-quoted markets to USDT when a matching BTCUSDT minute bar exists, maintains short rolling minute bars, and reports provisional relative-value watch candidates.

It is a **market watcher and candidate scanner only**. It does not read account balances, use private credentials, create orders, cancel orders, transfer funds, or enable live trading.

## Dynamic universe and resource controls

At each run the watcher:
- Reads public GET /exchangeInfo.
- Admits only status=TRADING, isSpotTradingAllowed=true, and permissions containing SPOT.
- Includes USDT, BTC and IRT quote assets.
- Excludes IRT when it appears as the base asset.
- Treats IRT as an **unverified quote unit**. IRT markets are observed and compared only with other IRT-quoted assets; no IRT price or depth is converted to USDT, USD or TOMAN.
- Caps the internal selection at 1,200 markets. The live exchangeInfo snapshot on 2026-11-27 contained 1,017 active Spot entries: 510 USDT-quoted and 507 IRT-quoted. The post-expansion probe must verify subscription coverage across this larger universe.
- Sorts USDT-quoted markets ahead of BTC-quoted, then IRT-quoted markets.
- Reports quote-asset counts, selected markets, omitted markets, quote-unit verification flags, and how many selected markets have public LOT_SIZE, minimum-notional and PRICE_FILTER fields.

The subscription builder batches no more than 25 symbols per frame and waits for each acknowledgement. If a batch is rejected or times out, it recursively splits the batch down to individual symbols and records the rejected symbols. This is a conservative adaptive strategy, not a claim that Tabdeal documents a 25-symbol limit.

## Live data feed

The watcher uses the documented public Spot endpoint wss://api1.tabdeal.org/stream/ and topic symbol@depth@2000ms.

For each accepted message it records:
- event time and local receive time;
- best bid/ask and spread;
- top-five bid/ask quote depth and imbalance;
- number of levels present in the message;
- any common sequence/update-ID fields exposed by the payload.

Messages with malformed books, crossed books, invalid event timestamps or absolute event lag above 10 seconds are rejected. A book older than eight seconds is not used for a candidate. The process reconnects with exponential backoff if the connection closes or errors.

**Important exchange-documentation limitation:** the reviewed Spot documentation describes periodic order-book messages but does not define whether every message is a complete snapshot or an incremental delta, nor does it provide a complete snapshot/delta resynchronization contract. The watcher therefore labels the book semantics as unverified. It does not reconstruct or claim a sequence-consistent full order book, and the measurements are only observation/diagnostic inputs. Do not treat them as execution-grade depth until Tabdeal confirms the payload semantics and recovery procedure.

The reviewed public Spot guide documents recent trades through REST, with a bounded page and no documented cursor, but no public Spot trade WebSocket topic or public kline endpoint. The leveraged/FAPI trade broadcast is not a Spot substitute and is not used here. Minute bars are built only from received Spot depth midpoints; no missing minute is filled and these are not exchange trade candles.

## Minute history and continuity

- Minute OHLC summaries are derived from received midpoint observations.
- The most recent 30 bars per symbol are retained.
- A missing minute is preserved as a gap; candidate logic rejects a lookback window with missing intervals.
- Only rolling bars are checkpointed to signal-history hourly and at orderly job completion.
- Latest order books are never restored from history; they must become fresh from the current WebSocket session before being used.
- Concurrent history updates are rebased before writing. A failed checkpoint is logged and the watcher continues monitoring, but that run reports the persistence failure.

This is bounded rolling state, not a full tick archive. The repository branch remains the storage mechanism for continuity; it is not intended as a high-frequency time-series database.

## Opportunity watch logic

The initial watch logic is deliberately conservative and does not issue trade instructions. It:
1. Converts BTC-quoted assets to a USDT-equivalent minute-price series only when a same-minute BTCUSDT bar exists.
2. Keeps USDT and IRT comparisons in distinct groups. Returns are dimensionless and can be compared within a common quote group even while the exact IRT unit is unresolved; absolute price levels are never joined across IRT and USDT.
3. Prefers direct USDT markets when the same base asset also has a BTC-quoted market.
4. Requires at least 16 recent minute bars and a fully contiguous 15-minute window.
5. Requires a recent order-book update, valid market filters, and spread no greater than 35 bps.
6. For USDT-equivalent groups, requires at least 1,000 USDT equivalent top-five depth on each side. For IRT, uses a conservative relative threshold of ten times that market's published minimum notional in IRT units; this is only an observation filter, not an execution-risk conversion.
7. Compares 15-minute performance within each quote group using a cross-sectional median and robust median-absolute-deviation scale.
8. Reports a provisional laggard only when relative underperformance is at least 100 bps, robust relative z-score is at most -2, and the last 1- and 5-minute returns have turned positive.

An IRT candidate is explicitly marked quoteUnitVerified=false. It cannot be promoted to a real trading instruction until Tabdeal confirms the unit and settlement conventions. The displayed source asset is the strongest recent liquid market within the same quote group; it is illustrative, not proof that the user's account currently owns that asset. The reported historical performance gap is **not a forecast of future return**. Candidate detection is a research heuristic, not evidence of mean reversion or expected profit.

Cost reporting currently uses provisional assumptions of 40 bps fee and 10 bps slippage per order, plus half-spread estimates on the two legs. The actual Tabdeal fee tier, market impact and fills are not yet account-verified. A candidate always remains tradeAuthorized=false.

## GitHub Actions cadence and limits

The workflow schedule is every five minutes. A scheduled run is configured to observe for 335 minutes, safely below the six-hour runner ceiling, then persist its rolling state and finish. The concurrency group allows one active run and retains only one pending run; repeated scheduled runs can replace older pending runs while a long run is active. The latest pending run can start after the current run completes.

This design aims for near-continuous observation within GitHub-hosted-runner constraints. GitHub scheduled workflows are best-effort: start times may be delayed, scheduled jobs may be dropped under platform load, and a gap is possible between runner sessions. It is not a guaranteed 24/7 daemon or hard real-time feed. The artifact records actual connection duration, received updates, symbols with no updates, subscription acknowledgements/rejections, lag, reconnects and checkpoint results so coverage can be measured rather than assumed.

## Live probe results — 2026-11-27

The first 3-minute probe, before IRT monitoring was enabled, selected all 510 USDT-quoted active Spot markets from 1,017 exchangeInfo entries. All 510 subscription requests were acknowledged, all 510 markets emitted valid messages, and 40,782 depth messages were received with a mean event lag of about 120 ms, maximum lag 532 ms, zero malformed messages and zero reconnects. At the final snapshot, 85 markets met the provisional spread and both-side depth filters (spread <=35 bps and top-five bid/ask depth >=1,000 USDT). No market emitted sequence/update-ID metadata, so snapshot/delta semantics remain unresolved. The 3-minute probe was too short to warm the 16-minute opportunity history, and no candidate was produced.



## Promotion and live-trading gates

The previous five-asset 4h relative rotation strategy failed its untouched holdout: all three registered cost scenarios were net-negative and maximum drawdown exceeded 20%. It remains research-only. The continuous watch does not override that result.

Before any actual swap is considered, separately require:
1. Written confirmation from Tabdeal of Spot depth message semantics and the correct snapshot/recovery procedure.
2. Confirmed IRT quote/settlement denomination before any IRT order or cross-quote comparison.
3. Account-specific maker/taker fees, minimum order amounts and permissions.
4. A strategy independently validated on fresh out-of-sample and forward data after all costs.
5. A separately audited two-leg execution path with order idempotency, fill reconciliation, partial-fill and second-leg failure handling, restart recovery, and a kill switch.
6. A permitted and tested independent live SELL workflow. The current public repository has a read-only SELL preflight; the live SELL workflow is not active in this assistant environment.
7. Explicit approval before a real-money pilot.

Until all gates pass, real orders remain disabled and the watcher is not an auto-trader.


## Expanded full-universe probe — 2026-11-27

The post-IRT implementation probe [run 46049725106](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/46049725106) observed for 182.3 seconds and successfully selected all **1,017 / 1,017** active Spot markets returned by exchangeInfo: 510 USDT-quoted and 507 IRT-quoted. All 1,017 subscriptions were acknowledged across 41 batches; all 1,017 symbols emitted messages, with 80,766 valid depth messages, zero invalid/ignored messages, zero rejected subscriptions, zero reconnects, and no symbols without updates. Mean event lag was 139.6 ms and maximum observed lag was 709 ms. No symbol exposed a recognized sequence/update-ID field.

At the final snapshot:
- USDT group: 91 / 510 had spread <=35 bps; 415 / 510 had at least 1,000 USDT-equivalent top-five quote depth on each side; 87 / 510 passed both spread and depth filters.
- IRT group: 32 / 507 had spread <=35 bps. IRT depth is screened relative to each market's published minimum notional in IRT units; do not compare IRT depth to USDT depth or infer a toman/rial conversion.
- No quote unit or order-book sequence semantics were inferred for IRT.
- The scanner remained warming_up, with no opportunity candidate, because the 3-minute probe is shorter than the required 16-minute contiguous history. This was expected; no real or virtual order was authorized.
- Rolling history for 1,017 symbols was checkpointed successfully to signal-history.

This verifies public feed reachability and broad observation coverage, not profitable strategy performance or execution readiness.
