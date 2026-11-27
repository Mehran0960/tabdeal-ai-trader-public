# Tabdeal one-shot Spot buy — 1 USDT quote input

This is an isolated, user-authorized, one-time execution path. It is not the automatic trading strategy and does not change the main live-trading defaults.

## Fixed scope

- Venue/account: Tabdeal Spot only.
- Pair: `BTCUSDT` only.
- Side: BUY only.
- Quote amount entered by the strategy: exactly `1.00000000 USDT`, matching the exchange form's "total order amount" input.
- The exchange API's Spot LIMIT order requires a base-asset `quantity` and `price`, not the UI's quote-amount field. The runner reproduces the UI conversion by calculating BTC quantity from the current limit price, then rounding the quantity **up** to the next valid `LOT_SIZE.stepSize` so the requested quote amount and exchange minimum are met.
- As a result, the resulting quote notional can be slightly greater than 1 USDT. This is intentional and was explicitly authorized by the user. It is never allowed to exceed the account's live free USDT after reserving the higher of the account's Maker/Taker commission rates.
- The limit price is capped at no more than 5 bps above the current best ask, rounded down to `PRICE_FILTER.tickSize`. The current spread must be no more than 30 bps.
- The runner requires current `MIN_NOTIONAL`, `LOT_SIZE`, `PRICE_FILTER`, account Spot trading permission, current free USDT, commission values, zero existing BTCUSDT open orders and sufficient visible ask depth.
- If the rounded quantity plus estimated commission cannot be paid from the live free quote balance, no order is submitted. The script never increases the order size beyond the amount supported by the actual available balance.
- Stable client order ID: `t1shot-btcusdt-20261127`. Permanent execution lock: `refs/tags/tabdeal-one-shot-1usdt-20261127`. A second order is blocked.
- Credentials remain in GitHub Actions secrets only.

## Pre-submit hard stops

Before any order POST, the runner fetches public exchange metadata and the live book, then performs signed Spot account, open-order and previous-order reads. It stops before POST if any information is missing, malformed, contradictory or outside limits.

The one-shot lock is claimed only after all preflight checks pass and immediately before the single order POST. The calculated order amount is then constrained by the exact venue tick/lot filters and the live free balance.

## Order submission and recovery

- BTCUSDT currently reports `quoteOrderQtyMarketAllowed=false`, so the runner uses a price-capped LIMIT order, not a quantity-based MARKET fallback.
- The runner sends one signed `POST /api/v1/order` at most.
- A 4xx rejection is reported without retry.
- A timeout, network failure or 5xx triggers one read-only lookup using the same stable client order ID. If the result remains ambiguous, the runner halts and does not repeat the POST.
- The permanent one-shot lock is fail-closed. Once claimed, it cannot be automatically reset.
- The result report includes the exchange order ID/status, executed BTC amount, cumulative quote amount and exchange-reported fills when returned. A successful HTTP response alone is not treated as proof of a fill.

## Limit order monitoring

A separate GitHub Actions workflow checks the same order ID every five minutes using signed GET only. It stops polling after the exchange reports a terminal state or a documented order-not-found result. Monitoring never sends a new order, cancellation, sell, withdrawal or transfer.

Tabdeal's documented Spot LIMIT order interface defaults to the exchange's GTC behavior when no time-in-force is supplied. Therefore an order may remain open if it is not immediately matched. It is not silently cancelled or repriced.

## Strategy context

The strategy research has not produced a candidate that passed all out-of-sample and risk gates. This is a discretionary one-time execution test, not a strategy-approved entry or evidence of profitability. No return is guaranteed.
