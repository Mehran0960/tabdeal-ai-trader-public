# One-time public Spot trade-stream capability probe

The current official Spot documentation reviewed here documents the public `symbol@depth@2000ms` WebSocket topic, but does not document a Spot trade stream. The trade stream described in the separate `special_margin/broadcast` section belongs to the leveraged/FAPI product and is not used as a Spot substitute.

This one-time, unauthenticated capability probe tests only:
- `btcusdt@trade`
- `btcusdt@aggTrade`

It uses the official public Spot WebSocket base URL, with no API credentials, account access, or write capability. It records acknowledgements, message counts, event types, field names, timestamps and trade-ID monotonicity diagnostics. It deliberately does not retain raw trades, prices, quantities, account data, or user identifiers.

A positive observation does **not** turn an undocumented topic into a supported/stable API. Before any production use, confirm the topic and schema with Tabdeal in writing, then test sequence continuity, duplicates, gaps, reconnect/resume behaviour, rate limits and data timestamps. A short negative probe is not proof of absence.

This workflow is manual/one-time and is not part of the periodic Spot depth collector.


## Observed result (2026-11-25)

A 30-second unauthenticated probe tested `btcusdt@trade` and `btcusdt@aggTrade` on the official public Spot WebSocket base URL. The server returned a one-item result array for each request. Each item contained the matching `param` and `error: INVALID_FORMAT`. No trade messages, price/quantity payload fields or trade IDs were received.

The collector classifies both tested topic strings as `topic_rejected_by_server`. This is strong evidence that these two Binance-style topic names are not valid on the current Tabdeal Spot stream. It does not rule out a different, officially supported Spot trade endpoint or another undocumented format; do not guess additional topics or use a leveraged/FAPI stream as a replacement. Obtain the correct Spot market-data contract from Tabdeal before implementing a production trade feed.
