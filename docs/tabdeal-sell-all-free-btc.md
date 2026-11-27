# Tabdeal BTC → USDT sell runner

This is a one-run-at-a-time Spot BTC exit path. It does not change or trigger the existing BTC purchase workflows.

## Sell lock scope: per workflow run, not lifetime

There is **no permanent/global sell lock** that prevents future sales.

For each GitHub Actions run, the runner derives:
- Client order ID: `sellbtc-<run_id>`
- Execution lock tag: `refs/tags/tabdeal-sell-all-btc-<run_id>`

A later, distinct workflow run receives a different client order ID and lock and can make a new sell after fresh preflight succeeds. Replaying the same workflow run is blocked. This per-run lock must remain: removing it could cause a retry or uncertain network submission to send the same sell twice.

## Current workflow status

The currently installed `Tabdeal BTC sell preflight (read-only)` workflow only checks account state and market conditions. It sends no order. The live SELL runner exists in code and is guarded, but a live order workflow is not currently installed.

## Read-only dry run

The preflight reads public exchange filters/order-book depth and signed account/open-order data. It sends no order, cancels nothing, and transfers/withdraws nothing. The report shows free and locked BTC, the sell quantity rounded down to the exchange LOT_SIZE step, any sub-step remainder, the protected limit price, estimated proceeds/fees, and expected slippage.

## Sale design and hard stops

- Symbol: BTCUSDT only.
- Direction: Spot SELL, no leverage, no shorting.
- Order design: LIMIT with IOC time-in-force, rather than an uncapped market order.
- Price floor: best bid less at most 50 basis points, rounded down to the exchange tick size.
- Spread ceiling: 30 basis points.
- Quantity: free BTC rounded **down** to the LOT_SIZE step. The sub-step remainder is reported and not sold.
- Existing BTCUSDT open orders or any locked BTC cause a hard stop. The script never cancels orders to unlock funds.
- The script checks the exact client order ID before an authorized submission.
- An uncertain POST is reconciled by client order ID. It is never automatically repeated.
- A successful workflow run is not proof of a fill. Exchange order status, executed BTC and cumulative USDT must be reviewed separately.

## IOC limitation

IOC can fill partially if the order book changes between preflight and exchange matching. The runner distinguishes FILLED, PARTIALLY_FILLED and accepted-but-not-fully-filled states. It never submits an automatic follow-up order.

The read-only workflow requires the existing repository secrets `TABDEAL_API_KEY` and `TABDEAL_API_SECRET`. Credentials and full account payloads are not logged.
