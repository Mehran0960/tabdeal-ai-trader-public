# Tabdeal one-shot Spot buy — 1 USDT cap

This is a deliberately isolated, manually-triggered execution path for the owner's separately authorized one-time test purchase. It is not the automatic trading bot and it does not change the live-trading defaults in `src/tabdeal-spot-execution.js`.

## Fixed scope

- Venue and account: Tabdeal Spot only.
- Pair: `BTCUSDT` only. BTCUSDT is the only symbol currently allowed by the existing Spot execution adapter and is selected for liquidity/execution reliability, not because the strategy has a BUY signal.
- Side and type: one `BUY MARKET` order, using `quoteOrderQty=1.00000000` USDT.
- Hard cap: 1.00000000 USDT quote notional. Symbol, side, type and amount are constants in the runner, not workflow inputs.
- Trigger: the user-authorized one-time activation marker pushed to `main` (`ops/tabdeal-one-shot-buy.activate`); the workflow also retains a guarded manual-dispatch path.
- Idempotency: before the only order POST, the runner atomically creates the permanent Git ref `refs/tags/tabdeal-one-shot-1usdt-20261127`. An existing tag or an ambiguous tag-creation result blocks the order; reruns cannot spend again.
- Credentials: existing repository Actions secrets `TABDEAL_API_KEY` and `TABDEAL_API_SECRET`; never print or persist their values.

## Pre-submit hard stops

The runner fetches current public exchange metadata and the live order book, then performs signed Spot account and open-order reads. It will not POST unless all checks pass:

1. BTCUSDT is `TRADING`, Spot trading is enabled, and MARKET orders are listed.
2. The exchange explicitly reports `quoteOrderQtyMarketAllowed=true`. No quantity-based market-order fallback is used because it cannot enforce the same quote-notional cap under price movement.
3. The current `MIN_NOTIONAL` is present and no greater than 1 USDT; market lot-size constraints and visible ask depth are sufficient.
4. The live spread is at most 30 bps; the visible ask book can absorb 1 USDT within a 5 bps modeled price impact.
5. The signed account is a tradable SPOT account, the USDT free balance is at least 1 USDT, and no existing BTCUSDT open order is present.
6. A pre-submit lookup for this run's unique client order ID conclusively returns Tabdeal's documented order-not-found code 1204.

Any missing, malformed, stale-looking, or ambiguous response fails closed. A minimum order of 1 USDT does not guarantee that the order can be placed: pair-specific filters, available balance, fees, API permission and market conditions may still block it.

## Submission and recovery

- At most one signed `POST /api/v1/order` is attempted.
- The unique client order ID is deterministic for the GitHub workflow run. Re-running the same workflow run reconciles the prior ID and does not create a duplicate order.
- A 4xx response is reported as rejected without retry.
- A timeout, network failure or 5xx triggers only one read-only lookup by the same client order ID. If the state remains unclear, execution halts; no second POST is sent.
- The permanent one-shot lock is intentionally fail-closed. If execution reaches the lock but cannot submit, the authorization is considered consumed until an operator deliberately reviews and resets the lock.
- The workflow never submits a SELL, cancellation, withdrawal or transfer and never turns on recurring/live strategy automation.
- Actual order ID, status, filled BTC quantity, quote quantity and reported fill commissions are included in the Actions summary. Never infer a fill merely from a successful HTTP response.

## Strategy context

The strategy research currently has no candidate that passed all out-of-sample and risk gates. This one-off purchase is therefore an explicitly discretionary execution test, not a strategy-approved entry and not evidence of profitability. The purchased BTC remains in Spot; this workflow does not place an exit order.
