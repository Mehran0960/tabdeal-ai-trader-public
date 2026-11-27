# Tabdeal Spot execution readiness

Assessment date: 2026-11-27  
Repository: `Mehran0960/tabdeal-ai-trader-public`

## Verified with the configured API key

Read-only checks were run on the public repository. The account, open-order, and synthetic order-lookup endpoints were confirmed:

- Signed `GET /account`: HTTP 200; account type `SPOT`; `canTrade=true`. The response can contain balance fields; the audit extracts only `accountType` and `canTrade`. Balance values were not extracted into the report, persisted, or logged.
- Signed `GET /openOrders?symbol=PAXGUSDT`: HTTP 200; zero open orders at the time of the check. The audit records only the count; no order details are retained or logged.
- Signed `GET /order` using the synthetic `origClientOrderId` `audit-probe-no-order-20261127`: HTTP 404 with API error code `1204`. Tabdeal's official API error catalog defines 1204 as **order not found**, so this is the expected response for the synthetic ID and confirms that the authenticated order-read endpoint is functioning.
- All three calls use the `TRADE` authentication class and HMAC-SHA256 signing. The executor now treats a regular-order lookup as empty only for HTTP 404 plus code 1204; OCO lookup requires code 1205. Any other 404 halts before a new POST.
- No `POST`, `DELETE`, cancellation, withdrawal, transfer, or order creation was performed. Balance values and order details were not extracted into the report, stored, or logged.

The official Tabdeal Python SDK marks `account()`, `get_open_orders()`, and `get_order()` as `SecurityTypes.TRADE`. It also marks `new_order()` as `SecurityTypes.TRADE`; the Spot SDK submits `POST /order`. This confirms the documented request class, not that this specific key's POST permission has been accepted.

## Existing execution controls

The current execution client is deliberately fail-closed by default:

- `liveTradingEnabled=false`
- `killSwitch=true`
- `explicitOwnerApproval=false`
- `automaticPostRetry=false`
- Default live symbol allowlist: `BTCUSDT` only
- New orders require an explicit risk plan, positive notional cap, portfolio-risk flag, and the live/approval gates.
- Before submission, the client looks up the exact client order ID to prevent duplicates.
- On an ambiguous POST result, it reconciles by client order ID and never repeats the POST automatically.
- The risk planner rejects missing fee/slippage assumptions, invalid stop placement, daily-loss breaches, and drawdown breaches. It defaults to 0.25% risk per trade and a 10% drawdown stop; configured maxima are 1% risk per trade and 20% drawdown.
- These controls are not yet a complete live authorization boundary: the executor currently accepts a caller-supplied `riskPlan` and a caller-supplied `portfolioRiskChecksPassed` flag. These must be replaced or bound to trusted server-side portfolio state before any live integration.
- The order reconciliation lookup is fail-closed: only documented Tabdeal error codes 1204 (order not found) and 1205 (OCO order not found) are treated as safe empty results; unrelated HTTP 404 responses halt before POST.

## Remaining blockers before any live order

1. **POST permission is not verified.** `canTrade=true` and successful signed GETs do not prove `POST /order` will be accepted. No real POST test is authorized or performed.
2. **Exchange filters are not yet an enforced executor precondition.** Before live wiring, the executor must fetch fresh `exchangeInfo` and validate status, Spot permission, `LOT_SIZE`, `PRICE_FILTER`, minimum notional, quantity step, and price tick using exact decimal arithmetic.
3. **Execution-time market quality must be bound to the order intent.** A live path must require fresh order-book data, spread and two-sided depth gates, conservative fees/slippage, latency protection, and a maximum quote notional.
4. **The risk plan must come from trusted server-side portfolio state.** The live executor must not trust client-supplied booleans or a caller-created `approved=true` object as the only risk authorization.
5. **A durable order/position ledger and startup reconciliation are required.** Open orders, partial fills, balances, reserved quote funds, OCO exits, cancellation outcomes, and uncertain submissions must be reconciled before a new entry can be considered.
6. **No strategy has passed the live qualification gates.** Paper/Shadow signal quality, fees, slippage and drawdown still need forward validation before live enablement.

## Current operating decision

Paper/Shadow only. The production Worker remains separate from the authenticated API audit. Live trading remains disabled; the kill switch remains active. A future live pilot requires a separate explicit owner approval after all blockers above are closed. This document does not authorize an order.


## Forward Paper capture snapshot

Observed on 2026-11-27 around 11:59 UTC, from the production D1 database:

| Symbol | Trades in latest 60m | No-trade minutes | Latest Paper decision |
|---|---:|---:|---|
| BTCUSDT | 35 | 38 / 60 | WAIT — trend alignment not confirmed |
| ETHUSDT | 5 | 56 / 60 | WAIT — insufficient activity/coverage |
| PAXGUSDT | 9 | 54 / 60 | WAIT — insufficient activity/coverage; latest trade was stale |
| SOLUSDT | 11 | 51 / 60 | WAIT — insufficient activity/coverage |
| XRPUSDT | 24 | 46 / 60 | WAIT — no-trade ratio above the registered gate |

At that snapshot, all five symbols had zero Paper-eligible entries, zero completed markouts, and zero exchange orders. BTC data passed the local data-quality gate but did not produce a buy candidate. The other four symbols failed the registered activity/coverage gate.

The collector has a one-minute Cloudflare Cron schedule and maintains up to 90 days of local candles. A GET-only public scout also confirmed DOGEUSDT as an active Spot market in one snapshot (22.16 bps spread, approximately 226.7k USDT top-five bid depth and 133.9k USDT top-five ask depth; newest trade about 3.2 seconds old). DOGEUSDT is added to the Paper observation watchlist only; it is not added to the live execution allowlist. The market scout returned 1,000 trades for all ten tested pairs, so each page was capped and is not a complete volume sample. The scout's quote-volume calculation has been corrected to use price × base quantity rather than raw quoteQty.

The current candle history is only about 6–8 hours old, so it is too early to claim strategy profitability or stable out-of-sample performance. Accumulating more observations does not relax any entry gate.

## Operational snapshot — 2026-11-27 12:20 UTC

### Cloudflare Paper collector

- Worker: `tabdeal-mvp-shadow`
- Active version: `151b3fd9-54ee-4952-a3ae-14dc55893e59`
- Active deployment: `1fdbdcde-8926-4281-a03b-6975b213ca2b` (100% traffic)
- Cron: `* * * * *` (one-minute cadence)
- D1 binding: the existing `DB` binding remains attached.
- Paper observation watchlist: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, PAXGUSDT, DOGEUSDT.
- Live order placement remains disabled; the Worker uses public market endpoints and no exchange API secret is bound to it.

### Forward Paper results from D1

At this snapshot, 407 evaluations had been recorded across the six symbols:

| Symbol | Evaluations | Buy candidates | Paper entries | 5m markouts | 15m markouts | 60m markouts |
|---|---:|---:|---:|---:|---:|---:|
| BTCUSDT | 186 | 0 | 0 | 0 | 0 | 0 |
| DOGEUSDT | 5 | 0 | 0 | 0 | 0 | 0 |
| ETHUSDT | 27 | 0 | 0 | 0 | 0 | 0 |
| PAXGUSDT | 58 | 0 | 0 | 0 | 0 | 0 |
| SOLUSDT | 82 | 0 | 0 | 0 | 0 | 0 |
| XRPUSDT | 49 | 0 | 0 | 0 | 0 | 0 |

DOGEUSDT had a 240-bar rolling candle window with 49 trades and 208 no-trade minutes. Its latest Paper evaluation remained `WAIT`: 8 trades in 60 minutes, 52 no-trade minutes (86.7%), and a 240-minute no-trade ratio of 86.7%. The configured local activity/coverage gate therefore rejected it. Its live execution allowlist was not changed.

BTCUSDT also remained `WAIT`: the recent 15-minute trade count was below its gate, with bearish five-minute trend alignment and ATR percentage below the registered band. The other symbols remain subject to the same pre-registered data-quality, freshness and book-quality gates.

**Interpretation:** the data collector and Paper evaluation loop are operational, but there are no qualified entries, no completed markouts, and no measured strategy return yet. This snapshot is not evidence of profitability and must not be presented as a successful trading result.

### Recurring public-market scout

The canonical read-only market scan is scheduled every six hours (`13 */6 * * *`) and retains its snapshot artifacts for seven days. Its latest run processed 10 preselected Spot pairs with 10 valid orderbooks and 10 parsed trade snapshots. All 10 recent-trade pages were capped at 1,000 rows and all newest-trade timestamps were older than 60 seconds; these snapshots are useful for screening, not complete trade history or current execution authorization.

### User action currently required

No new credential or repository change is needed for Paper operation. Do not paste API credentials into chat or enable withdrawal permissions. Before any live pilot, the remaining user-side step is to obtain confirmation from Tabdeal support that this specific key is permitted to submit Spot `POST /order` requests and to authorize a separate, tightly capped live pilot after the strategy and executor gates pass.

