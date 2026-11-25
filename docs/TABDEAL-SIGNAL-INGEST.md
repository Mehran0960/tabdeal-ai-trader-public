# Tabdeal public signal-page observations

## What is captured

The collector fetches the public `https://tabdeal.org/crypto-price/signal` page with an unauthenticated GET and reads only the `marketEventsData` section embedded in the Nuxt server-rendered payload. It stores market-event fields only: symbol, event type, event time as displayed by the page, current price, event detail, available IRT/USDT spot-market identifiers, and public capability flags.

Comments, public trader leaderboards, usernames, account data and private API details are deliberately discarded. No order, swap, account request or funds movement is possible in this collector.

## Coverage and limitations

- The first server-rendered page may contain fewer rows than the reported total. The collector records `totalEventCount`, `numberOfPages`, `rowsReturned`, and `allPagesCaptured`; it must not imply complete pagination.
- The page HTML and Nuxt payload are not a versioned, official data API contract. Markup, schema, cache behaviour, event names or availability may change. Structural changes fail closed.
- `sourceRenderedAt` describes the rendered page payload; each run also records local capture time. The Jalali event-time string is kept verbatim and is not silently converted to UTC.
- Events are candidate-discovery metadata, not standalone entry/exit signals. Verify the market independently, then check current order-book depth, spread, executable price, fees and unit mapping.
- A page event is not an auditable historical strategy label unless its event-generation methodology, timestamps, survivorship and complete historical coverage are independently established.
- The first page of data may be incomplete, and a snapshot series only starts when this workflow is enabled. It is not a backfill.

## History storage

The hourly workflow saves one compact JSONL snapshot per new source-rendered payload in the public `signal-history` branch, grouped by UTC month under `data/tabdeal-signal-events/`. Identical source snapshots are deduplicated by content-derived snapshot ID. This creates a prospective observation history; it does not recover events that occurred before capture began.

## TDEX exclusion

TDEX is a separate decentralized swap path for selected early-stage tokens, not an order-book Spot market. Quotes may change before execution, the delivered amount may differ, completion can take several minutes, and the exchange warns about low liquidity and high volatility. TDEX assets are excluded from the automatic Spot executor and can only be tracked separately for research. A TDEX quote must never be treated as a firm executable price or as proof of a Spot market listing.
