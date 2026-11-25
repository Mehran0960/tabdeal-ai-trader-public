# Tabdeal public Spot depth stream

## Officially documented capability

The official Spot market WebSocket is `wss://api1.tabdeal.org/stream/`. The documented topic is `[symbol]@depth@2000ms`; the exchange says the market order-book list is sent every two seconds. The supported Spot WebSocket page documents OrderBook only. The example payload includes `b` and `a` arrays but does not document sequence IDs or an explicit snapshot-vs-delta synchronization procedure.

The separate `special_margin/broadcast` real-time trade stream belongs to the leveraged/FAPI product. It is not a Spot market data substitute and must not be used to fabricate Spot trade history or candles.

The official Spot REST market methods documented in the current API guide are:
- `GET /r/api/v1/depth`
- `GET /r/api/v1/trades` (up to 1,000 recent records, no documented cursor in the market endpoint)
- `GET /r/api/v1/exchangeInfo`
- `GET /r/api/v1/ping` and `GET /r/api/v1/time`

No public Spot kline/candle endpoint or public Spot trade WebSocket channel is listed in the current Spot API guide / SDK reviewed. This is a documentation boundary, not proof that no private or undocumented endpoint exists.

## What this collector records

Every 15 minutes, GitHub Actions connects to the public Spot order-book WebSocket for the allowlisted symbols and samples for 60 seconds. It stores only aggregated per-symbol metrics:
- update count and event-time coverage;
- minimum/mean/maximum number of bid and ask levels present in each received message;
- whether the payload exposed any common sequence/update-ID fields (`U`, `u`, `lastUpdateId`, etc.);
- minimum, mean and maximum spread in basis points;
- average top-five bid/ask quote depth and imbalance;
- event timestamp lag and latest best bid/ask.

Raw update messages are not committed to the long-term history branch. Short-lived JSON summary artifacts are kept for one day. Aggregates are recorded in the public `signal-history` branch under `data/tabdeal-spot-depth/YYYY-MM.jsonl`.

## Research limitations

- These are order-book observations, not executed trades, OHLC candles or fill records.
- The official example describes a periodic order-book list, but does not specify whether each message is a complete snapshot or an incremental delta, nor provide a sequence/recovery contract. The collector therefore records level-count ranges and presence of common update-ID fields. Until Tabdeal confirms the payload semantics, spread/depth/imbalance summaries are provisional research diagnostics and must not be treated as execution-grade book state or reliable transaction-cost estimates.
- Top-five quote depth is a snapshot metric; it does not prove available executable size at later order arrival.
- The collector is a short burst and GitHub scheduled jobs are best effort; it does not provide uninterrupted 24/7 tick data.
- Each symbol record carries `quoteAsset` and `quoteUnitCode`; IRT is explicitly stored as `IRT_UNVERIFIED`, while USDT is stored as `USDT`. IRT quote depth must not be combined with USDT depth or converted without unit evidence.
- Use this feed for liquidity/spread screening and microstructure research only. It is not an entry/exit signal and cannot by itself validate a profitable strategy.
- No API credentials, account endpoints, orders, transfers or withdrawals are used.
