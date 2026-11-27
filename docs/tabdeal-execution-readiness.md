# Tabdeal Spot execution readiness

Assessment date: 2026-11-27  
Repository: `Mehran0960/tabdeal-ai-trader-public`

## Verified with the configured API key

A read-only GitHub Actions audit on the public repository completed successfully:

- Signed `GET /account`: HTTP 200; account type `SPOT`; `canTrade=true`.
- Signed `GET /openOrders?symbol=PAXGUSDT`: HTTP 200; the endpoint returned zero open orders at the time of the check.
- Signed `GET /order`: queried only with a synthetic `origClientOrderId` reserved for this audit. The expected result is “not found”; no account order details are logged.
- All three calls use the `TRADE` authentication class and HMAC-SHA256 signing.
- No `POST`, `DELETE`, cancellation, withdrawal, transfer, or balance read/print was performed.

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

## Remaining blockers before any live order

1. **POST permission is not verified.** `canTrade=true` and successful signed GETs do not prove `POST /order` will be accepted. No real POST test is authorized or performed.
2. **Exchange filters are not yet an enforced executor precondition.** Before live wiring, the executor must fetch fresh `exchangeInfo` and validate status, Spot permission, `LOT_SIZE`, `PRICE_FILTER`, minimum notional, quantity step, and price tick using exact decimal arithmetic.
3. **Execution-time market quality must be bound to the order intent.** A live path must require fresh order-book data, spread and two-sided depth gates, conservative fees/slippage, latency protection, and a maximum quote notional.
4. **The risk plan must come from trusted server-side portfolio state.** The live executor must not trust client-supplied booleans or a caller-created `approved=true` object as the only risk authorization.
5. **A durable order/position ledger and startup reconciliation are required.** Open orders, partial fills, balances, reserved quote funds, OCO exits, cancellation outcomes, and uncertain submissions must be reconciled before a new entry can be considered.
6. **No strategy has passed the live qualification gates.** Paper/Shadow signal quality, fees, slippage and drawdown still need forward validation before live enablement.

## Current operating decision

Paper/Shadow only. The production Worker remains separate from the authenticated API audit. Live trading remains disabled; the kill switch remains active. A future live pilot requires a separate explicit owner approval after all blockers above are closed. This document does not authorize an order.
