# Tabdeal one-shot Spot buy — maximum 1 USDT order amount

This is an isolated, user-authorized one-time execution path. It is not the automatic trading strategy and does not change the main live-trading defaults.

## Fixed scope

- Venue/account: Tabdeal Spot only.
- Pair: `BTCUSDT` only.
- Side: BUY only.
- User-visible quote order amount: exactly `1.00000000 USDT`; the runner does **not** subtract maker/taker commission rates from this amount.
- The Spot order API expects base-asset `quantity` and, for LIMIT, `price`. The runner converts the 1 USDT quote target into the largest base quantity aligned to the live `LOT_SIZE` step, while keeping the calculated quote notional at or below 1 USDT.
- If live pair metadata explicitly allows quote-sized MARKET buys, the runner uses MARKET with `quoteOrderQty=1.00000000`. The current BTCUSDT metadata reports `quoteOrderQtyMarketAllowed=false`, so the runner uses a price-capped LIMIT order.
- LIMIT price is no more than 5 bps above current best ask, rounded down to `PRICE_FILTER.tickSize`. Quantity is rounded down to `LOT_SIZE.stepSize`; exact integer arithmetic is used.
- Spread ceiling: 30 bps. The visible ask book must cover the proposed quantity.
- The account must show at least 1 USDT free, Spot trade enabled, and no existing BTCUSDT open order.
- Minimum notional is checked against the actual calculated order notional, not against an invented fee reserve. If quantity-step rounding makes the notional lower than the exchange minimum, the runner halts and reports the exact price, quantity, calculated notional, min notional, tick and step.
- Exchange-reported commissions and `commissionAsset` are recorded from the order fills; the runner does not assume the fee must be added on top of the 1 USDT order amount.
- Stable client order ID: `t1shot-btcusdt-20261127`. Permanent execution lock: `refs/tags/tabdeal-one-shot-1usdt-20261127`. A second order is blocked.
- Credentials remain in GitHub Actions secrets only.

## Pre-submit hard stops

Before any order POST, the runner reads current public exchange metadata and order book, then signed Spot account and open-order data. It stops before POST if any information is missing, malformed, contradictory or outside limits. The same stable client order ID is checked before submission.

## Limit order and monitoring

A separate GitHub Actions workflow checks the same order ID every five minutes using signed GET only. It stops polling after the exchange reports a terminal state or a documented order-not-found result. Monitoring never sends a new order, cancellation, sell, withdrawal or transfer.

The Spot API's documented order interface accepts LIMIT price and base quantity; it does not expose a Spot time-in-force parameter in its basic order method. Therefore the order uses the exchange default (GTC). This means a LIMIT order may remain open and reserve its quote balance while waiting for a matching seller. It is not silently cancelled or repriced.

## Submission and recovery

- At most one signed `POST /api/v1/order` is attempted.
- A 4xx rejection is reported without retry.
- A timeout, network failure or 5xx triggers one read-only lookup using the same stable client order ID. If the result is still ambiguous, the runner halts and does not repeat the POST.
- The permanent one-shot lock is fail-closed. Once claimed, it cannot be automatically reset.
- The result report includes exchange order ID/status, executed BTC amount, cumulative quote amount and exchange-reported fills/commission asset when returned. A successful HTTP response alone is not treated as proof of a fill.

## Strategy context

The strategy research has not produced a candidate that passed all out-of-sample and risk gates. This is a discretionary one-time execution test, not a strategy-approved entry or evidence of profitability. No return is guaranteed.
