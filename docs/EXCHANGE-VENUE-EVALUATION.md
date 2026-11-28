# Domestic exchange venue assessment (read-only)

Last reviewed: 2026-11-28.

## Purpose

This is a non-trading comparison of the public BTC/USDT market interfaces of Exir, Wallex and Tabdeal. It is designed to answer whether an alternative venue is worth an account-level, owner-controlled evaluation for the existing bot.

## Scope and safety boundary

- Uses public, unauthenticated HTTP GET endpoints only.
- Does not use API keys, private account endpoints, user balances, order endpoints, cancellation endpoints or withdrawal endpoints.
- Does not submit, simulate by POST, replace, cancel or amend any exchange order.
- Does not transfer or withdraw assets.
- Uses a fixed illustrative comparison quantity of 0.000033 BTC from an earlier Tabdeal preflight. This is not a current balance query or a recommendation to sell.
- Market-data snapshots are point-in-time and can change immediately.

## Public endpoints sampled

### Exir

- \`GET https://api.exir.io/v2/health\`
- \`GET https://api.exir.io/v2/constants\`
- \`GET https://api.exir.io/v2/ticker?symbol=btc-usdt\`
- \`GET https://api.exir.io/v2/orderbook?symbol=btc-usdt\`
- \`GET https://api.exir.io/v2/trades?symbol=btc-usdt\`

The API docs show HMAC-SHA256 private authentication and describe balance, order, order lookup and cancellation capabilities. They also show a \`btc-usdt\` pair metadata sample with \`min_size\` and \`increment_size\`; the sample's timestamps are old, so the live \`/v2/constants\` response is required before judging whether a tiny trade is possible. No private action is exercised by this probe.

### Wallex

- \`GET https://api.wallex.ir/v1/markets\`
- \`GET https://api.wallex.ir/v1/depth?symbol=BTCUSDT\`
- \`GET https://api.wallex.ir/v1/otc/markets\`
- \`GET https://api.wallex.ir/v1/trades?symbol=BTCUSDT\`

The public market metadata exposes minimum quantity and minimum notional. The OTC market metadata may have a separate minimum and sell availability. The documented \`stepSize\` and \`tickSize\` fields are precision counts; they are not literal quantity/price increments.

### Tabdeal reference

- \`GET https://api1.tabdeal.org/r/api/v1/exchangeInfo\`
- \`GET https://api1.tabdeal.org/r/api/v1/depth?symbol=BTCUSDT&limit=5\`

Tabdeal is included as the control venue for like-for-like market metadata and book spread/depth.

## Interpretation

A venue is not approved merely because public endpoints respond. Before an owner-controlled account evaluation, the following must be separately verified: current pair minimum and lot rules, fees and fee asset, authenticated read access, account and KYC eligibility, IP restrictions, private order status semantics, idempotency/reconciliation, partial-fill behaviour, operational uptime, and actual network reachability from the intended runtime.

The report's \`referenceQuantityMeetsKnownMinimum\` is only a comparison against public metadata and the previous illustrative quantity; it does not assert that the user owns that quantity now or that an order would be accepted.

No venue migration should occur until current public data and an account-specific, read-only eligibility check pass. Do not grant withdrawal permissions to a trading bot.
