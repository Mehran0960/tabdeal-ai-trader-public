# One-time public Spot trade-stream capability probe

The current official Spot documentation reviewed here documents the public `symbol@depth@2000ms` WebSocket topic, but does not document a Spot trade stream. The trade stream described in the separate `special_margin/broadcast` section belongs to the leveraged/FAPI product and is not used as a Spot substitute.

This one-time, unauthenticated capability probe tests only:
- `btcusdt@trade`
- `btcusdt@aggTrade`

It uses the official public Spot WebSocket base URL, with no API credentials, account access, or write capability. It records acknowledgements, message counts, event types, field names, timestamps and trade-ID monotonicity diagnostics. It deliberately does not retain raw trades, prices, quantities, account data, or user identifiers.

A positive observation does **not** turn an undocumented topic into a supported/stable API. Before any production use, confirm the topic and schema with Tabdeal in writing, then test sequence continuity, duplicates, gaps, reconnect/resume behaviour, rate limits and data timestamps. A short negative probe is not proof of absence.

This workflow is manual/one-time and is not part of the periodic Spot depth collector.
