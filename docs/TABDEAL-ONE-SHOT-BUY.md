# Tabdeal one-shot Spot buy — maximum 1 USDT all-in

This is an isolated, user-authorized one-time execution path. It is not the automatic trading strategy and does not change the main live-trading defaults.

## Fixed scope

- Venue/account: Tabdeal Spot only.
- Pair: `BTCUSDT` only.
- Side: BUY only.
- Absolute maximum total debit: 1.00000000 USDT, including a conservative commission reserve based on the larger of the account's maker/taker commission rates.
- If the live pair metadata explicitly allows quote-sized market buys, the runner may use MARKET with a reduced `quoteOrderQty` so the fee reserve still fits inside the 1 USDT cap.
- The current live BTCUSDT metadata reported `quoteOrderQtyMarketAllowed=false`. In that case the runner uses a price-capped LIMIT order only when the exact current LOT_SIZE, PRICE_FILTER and MIN_NOTIONAL filters allow a valid quantity under the fee-adjusted quote budget. Quantity is rounded down to the venue step size. No market-order quantity fallback is used.
- The limit price is capped at no more than 5 bps above the current best ask, rounded down to the valid price tick. The spread must be no more than 30 bps.
- The fixed client order ID is `t1shot-btcusdt-20261127`; the permanent execution lock is `refs/tags/tabdeal-one-shot-1usdt-20261127`. A second execution is blocked.
- Credentials remain in GitHub Actions secrets only.

## Pre-submit hard stops

Before any order POST, the runner checks current public exchange metadata, the book, signed Spot account data, commission rates, free USDT, open orders and the same client order ID. It stops before POST if any information is missing, malformed, contradictory or outside limits.

The one-shot order is sent only after the permanent lock is successfully claimed. The order's estimated quote notional is reduced to reserve the maximum maker/taker fee shown by the account response. If the exchange minimum is greater than the fee-adjusted budget, the runner will not trade—even though the account may have 1 USDT and the nominal minimum may itself be 1 USDT.

## Limit order monitoring

The current BTCUSDT setting does not allow quote-sized MARKET orders. A valid fallback is a LIMIT order with a fixed maximum price and a base quantity rounded down so that:

`limit price × base quantity + conservative fee reserve ≤ 1 USDT`

The Spot SDK's documented order interface accepts LIMIT price and quantity but does not expose a Spot time-in-force parameter. Therefore the order uses the exchange default (GTC). This means the order may remain open and reserve its quote balance while waiting for a matching seller. It is not silently cancelled or repriced.

A separate GitHub Actions workflow checks the same order ID every five minutes using signed GET only. It stops polling after the exchange reports a terminal state or a documented order-not-found result. Monitoring never sends a new order, cancellation, sell, withdrawal or transfer.

## Submission and recovery

- At most one signed `POST /api/v1/order` is attempted.
- A 4xx rejection is reported without retry.
- A timeout, network failure or 5xx triggers one read-only lookup using the same stable client order ID. If the result is still ambiguous, the runner halts and does not repeat the POST.
- The permanent one-shot lock is fail-closed. Once claimed, it cannot be automatically reset.
- The result report includes the exchange order ID/status, executed BTC amount, cumulative quote amount and exchange-reported fills when returned. A successful HTTP response alone is not treated as proof of a fill.

## Strategy context

The strategy research has not produced a candidate that passed all out-of-sample and risk gates. This is a discretionary one-time execution test, not a strategy-approved entry or evidence of profitability. No return is guaranteed.
