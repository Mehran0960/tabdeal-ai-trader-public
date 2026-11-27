# Continuous Tabdeal Spot market watch

## Purpose and current boundary

This module expands market observation beyond the earlier fixed five-symbol, 4h research screen. It dynamically discovers active Spot markets in exchangeInfo, watches supported USDT- and BTC-quoted markets through the official public Spot depth WebSocket, maintains short rolling minute bars, and reports provisional relative-value watch candidates.

It is a **market watcher and candidate scanner only**. It does not read account balances, use private credentials, create orders, cancel orders, transfer funds, or enable live trading.

## Dynamic universe and resource controls

At each run the watcher:
- Reads public GET /exchangeInfo.
- Admits only status=TRADING, isSpotTradingAllowed=true, and permissions containing SPOT.
- Includes USDT and BTC quote assets only.
- Excludes IRT because the quote/settlement denomination is not verified for this strategy.
- Caps the internal selection at 1,000 markets; if the exchange returns more eligible markets, the report shows the omitted count.
- Sorts USDT-quoted markets ahead of BTC-quoted markets.
- Reports quote-asset counts, selected markets, and how many selected markets have the public LOT_SIZE, minimum-notional and PRICE_FILTER fields.

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
2. Prefers a direct USDT market when the same base asset has both USDT- and BTC-quoted markets.
3. Requires at least 16 recent minute bars and a fully contiguous 15-minute window.
4. Requires a recent order-book update, valid market filters, spread no greater than 35 bps, and at least 1,000 USDT equivalent top-five depth on each side.
5. Compares 15-minute performance across assets using a cross-sectional median and robust median-absolute-deviation scale.
6. Reports a provisional laggard only when relative underperformance is at least 100 bps, robust relative z-score is at most -2, and the last 1- and 5-minute returns have turned positive.

The displayed source asset is the strongest recent liquid market in the watch universe; it is illustrative, not proof that the user's account currently owns that asset. The reported historical performance gap is **not a forecast of future return**. Candidate detection is a research heuristic, not evidence of mean reversion or expected profit.

Cost reporting currently uses provisional assumptions of 40 bps fee and 10 bps slippage per order, plus half-spread estimates on the two legs. The actual Tabdeal fee tier, market impact and fills are not yet account-verified. A candidate remains tradeAuthorized=false.

## GitHub Actions cadence and limits

The workflow schedule is every five minutes. A scheduled run is configured to observe for 335 minutes, safely below the six-hour runner ceiling, then persist its rolling state and finish. The concurrency group allows one active run and retains only one pending run; repeated scheduled runs can replace older pending runs while a long run is active. The latest pending run can start after the current run completes.

This design aims for near-continuous observation within GitHub-hosted-runner constraints. GitHub scheduled workflows are best-effort: start times may be delayed, scheduled jobs may be dropped under platform load, and a gap is possible between runner sessions. It is not a guaranteed 24/7 daemon or hard real-time feed. The artifact records actual connection duration, received updates, symbols with no updates, subscription acknowledgements/rejections, lag, reconnects and checkpoint results so coverage can be measured rather than assumed.

## Promotion and live-trading gates

The previous five-asset 4h relative rotation strategy failed its untouched holdout: all three registered cost scenarios were net-negative and maximum drawdown exceeded 20%. It remains research-only. The continuous watch does not override that result.

Before any actual swap is considered, separately require:
1. Written confirmation from Tabdeal of Spot depth message semantics and the correct snapshot/recovery procedure.
2. Account-specific maker/taker fees, minimum order amounts and permissions.
3. A strategy independently validated on fresh out-of-sample and forward data after all costs.
4. A separately audited two-leg execution path with order idempotency, fill reconciliation, partial-fill and second-leg failure handling, restart recovery, and a kill switch.
5. A permitted and tested independent live SELL workflow. The current public repository has a read-only SELL preflight; the live SELL workflow is not active in this assistant environment.
6. Explicit approval before a real-money pilot.

Until all gates pass, real orders remain disabled and the watcher is not an auto-trader.
