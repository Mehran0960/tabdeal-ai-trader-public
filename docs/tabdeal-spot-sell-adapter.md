# Tabdeal Spot BTC-to-USDT sell adapter

This adapter implements separate, documented Tabdeal Spot sell requests for the `BTCUSDT` market.

## Official Spot contract

Reference: https://docs.tabdeal.org/

- Submit order: `POST https://api1.tabdeal.org/api/v1/order` with `TRADE` authentication.
- Required authentication: `X-MBX-APIKEY` header and HMAC-SHA256 `signature` over the request query parameters, including `timestamp`.
- Required order fields: `symbol` (or `tabdealSymbol`), `side`, `type`, `quantity`, `timestamp`, and `signature`.
- `MARKET`: sends `type=MARKET`, quantity, and no price or time-in-force.
- `LIMIT`: sends `type=LIMIT`, quantity, and required `price`; no undocumented `timeInForce` is sent.
- Client-generated `newClientOrderId` is included to support idempotency and order reconciliation.
- Signed order lookup uses `GET /r/api/v1/order`.

## Exchange metadata and account balance

- Spot exchange metadata is read from `GET /r/api/v1/exchangeInfo`.
- The public Spot order book is read from `GET /r/api/v1/depth`.
- The Spot account endpoint documents BTC balances with `free` and `freeze` fields. The adapter now reads `freeze` (and accepts legacy `locked` in fixtures for compatibility).
- `LIMIT` quantity is rounded down using `LOT_SIZE`.
- `MARKET` quantity is rounded down using `MARKET_LOT_SIZE`, falling back to `LOT_SIZE` only when the market-specific filter is absent.
- Market notional filters honor `applyToMarket` / `applyMinToMarket` / `applyMaxToMarket` where supplied.
- Both order types are screened against spread, displayed bid depth, and a configured slippage guard before any live order could be submitted.

## Safety and execution state

The GitHub workflow `.github/workflows/tabdeal-btc-sell-preflight.yml` remains read-only:
- `TABDEAL_SELL_MODE` is fixed to `dry_run`.
- `TABDEAL_SELL_CONFIRM` is fixed to `false`.
- `TABDEAL_SELL_CONFIRM_QUANTITY` is empty.
- Manual workflow dispatch can select `LIMIT` or `MARKET`, but only to run a preflight.
- It does not submit orders, cancel orders, transfer funds, or withdraw assets.

The live executor retains a separate explicit confirmation check and a one-run execution lock, but this change does not add or enable a live GitHub workflow. A successful preflight is not a trade; market depth and estimates can change before any later order submission. A Market sell may execute at prices different from the preflight estimate.
