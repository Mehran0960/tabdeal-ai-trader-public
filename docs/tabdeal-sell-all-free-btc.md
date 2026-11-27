# Tabdeal BTC → USDT one-shot exit

This is a separate manual exit path. It does not change or trigger the existing BTC purchase workflows.

## Read-only dry run

Run **Tabdeal BTC sell preflight (read-only)** from GitHub Actions. The job reads public exchange filters/order-book depth and signed account/open-order data. It sends no order, cancels nothing, and transfers/withdraws nothing.

The report shows free and locked BTC, the sell quantity rounded down to the exchange LOT_SIZE step, any sub-step remainder, the protected limit price, estimated proceeds/fees, and expected slippage.

## Sale design and hard stops

- Symbol: BTCUSDT only.
- Direction: Spot SELL, no leverage, no shorting.
- Order design: LIMIT with IOC time-in-force, rather than an uncapped market order.
- Price floor: best bid less at most 50 basis points, rounded down to the exchange tick size.
- Spread ceiling: 30 basis points.
- Quantity: free BTC rounded **down** to the LOT_SIZE step. The sub-step remainder is reported and not sold.
- Existing BTCUSDT open orders or any locked BTC cause a hard stop. The script never cancels orders to unlock funds.
- The script checks an exact client order ID before an authorized submission and uses a unique per-run Git tag as an execution lock.
- An uncertain POST is reconciled by client order ID. It is never automatically repeated.
- A successful workflow run is not proof of a fill. Exchange order status, executed BTC and cumulative USDT must be reviewed separately.

## IOC limitation

IOC can fill partially if the order book changes between preflight and exchange matching. The runner distinguishes FILLED, PARTIALLY_FILLED and accepted-but-not-fully-filled states. It never submits an automatic follow-up order.

The read-only workflow requires the existing repository secrets `TABDEAL_API_KEY` and `TABDEAL_API_SECRET`. Credentials and full account payloads are not logged.
