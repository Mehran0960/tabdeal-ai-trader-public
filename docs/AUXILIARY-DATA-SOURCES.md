# Verified auxiliary data sources — Tabdeal Spot research

Status: **source shortlist approved for read-only evaluation; only Binance/Kraken/Tabdeal market-data lanes are currently integrated and observed.** No new paid subscription, API key or automated account action is required by this shortlist.

## Data roles — do not confuse context with execution

| Role | Source | Intended use | Status |
|---|---|---|---|
| Global Spot OHLCV/trades/depth | Binance Spot Market Data Only | Primary external research history and market structure | Already integrated and runner-tested |
| Independent Spot cross-check | Kraken Spot public REST/WebSocket | Cross-venue validation and independent historical check | Already integrated and runner-tested |
| Local executable market | Tabdeal Spot public API/book | Symbol availability, quote unit, spread, local depth and final local-price confirmation | Partial; IRT meaning and depth sequence semantics remain unresolved |
| Network/on-chain metrics | Coin Metrics Community API | Slow regime / network-flow context; only metrics confirmed in its free coverage | Candidate, endpoint probe required |
| DeFi / stablecoin context | DefiLlama free API | Daily/weekly ecosystem TVL, chain and stablecoin regime context | Candidate, endpoint probe required |
| Broad crypto sentiment | Alternative.me Fear & Greed API | Daily risk-regime feature; never a stand-alone entry signal | Candidate, endpoint probe required |
| Independent asset metadata/market overview | CoinGecko Demo API | Asset identity, aggregate market-cap/volume sanity check; not local execution pricing | Optional; free Demo key required |
| Alternative asset metadata | CoinMarketCap Basic | Fallback metadata/market overview if CoinGecko coverage is inadequate | Redundant alternative; do not integrate both without a demonstrated need |
| Macro-economic series | FRED API | Slow macro regime context (rates/liquidity); not intraday entry timing | Later; free registration/API key required |
| Derivatives positioning | CoinGlass API | Optional futures OI/funding/liquidation context only; no derivatives trading | Deferred: paid API; lowest Hobbyist tier is limited to 4h interval and 30 requests/minute |

## Priority sources

### Already active — market data
- **Binance Spot Market Data Only:** official unauthenticated public endpoints include klines, trades/aggregate trades, depth, book ticker and exchange metadata. The public research pipeline already uses Spot USDT candles. See [official endpoint scope](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md).
- **Kraken Spot:** independent Spot market data for OHLC/trades/order-book cross-checking. Apply endpoint-specific rate limits and preserve Kraken's native symbols/units. See [official API reference](https://docs.kraken.com/api/).
- **Tabdeal:** only source for the final local quote, order book, symbol rules, account fee tier and order eligibility. An external quote must never become a Tabdeal fill price.

### Add as low-frequency context after read-only probes
- **Coin Metrics Community:** no API key is needed for Community endpoints. Its free offering is a subset of paid metrics: Atlas Community has limited assets and 30 days of history; Community reference rates at granular intervals are limited to the latest seven points; the Community HTTP API documents 10 requests per 6-second sliding window per IP. The public community archive is licensed CC BY-NC 4.0, so treat it as non-commercial-only unless Coin Metrics confirms otherwise in writing; do not use it in a monetized product or redistribute it without appropriate rights. Probe exact metric/asset coverage before adding any feature. Do not assume a paid exchange-flow metric is part of the free tier. See [official Community package and limits](https://github.com/coinmetrics/product-docs/blob/master/docs/packages/coin-metrics-community-data.md), [community archive license](https://github.com/coinmetrics/data/blob/master/README.md), and [getting started](https://docs.coinmetrics.io/getting-started).
- **DefiLlama free API:** public free hosts do not require a key for their documented free endpoints. Useful endpoints include protocol/chain TVL and stablecoin data, subject to each endpoint's current availability/terms. Use weekly/daily changes as broad ecosystem context only; TVL can move because of token prices, bridge accounting or methodology revisions, so it is not a direct measure of directional buy pressure. Do not silently use the paid host or treat a 402/429 as permission to bypass limits. See [official free API documentation](https://github.com/DefiLlama/api-docs/blob/main/llms-free.txt).
- **Alternative.me Fear & Greed:** public GET endpoint at https://api.alternative.me/fng/ returns dated 0–100 index observations. Its index is a composite of volatility, momentum/volume, social activity, surveys, dominance and search trends; use it as a coarse, correlated regime feature, not independent confirmation of all those components. Attribute Alternative.me when displaying its values; respect the published 60 requests/minute limit and API update cadence. See [index methodology and API rules](https://alternative.me/crypto/fear-and-greed-index/) and [API documentation](https://alternative.me/crypto/api/).

### Optional identity/market overview — no execution use
- **CoinGecko Demo:** free Demo access currently documents 100 calls/minute and 10,000 calls/month, but requires a registered Demo API key. Public unauthenticated access can have lower variable limits. Consider only if global symbol mapping, market-cap/volume or cross-source sanity checks offer material added value. Store any key only as a secret in the private operations repository; never in this public repository. See [official pricing and API FAQ](https://www.coingecko.com/en/api/pricing).
- **CoinMarketCap Basic:** official FAQ documents a free Basic tier with 15,000 monthly call credits and 65 endpoints. This is an alternative to CoinGecko, not a reason to pay for both. Use only if its coverage or ID mapping materially improves the current asset-universe screen. See [official API FAQ](https://coinmarketcap.com/api/faq/).

### Deferred / no paid spend yet
- **CoinGlass:** useful coverage includes open interest, funding, liquidations and Spot order-flow data, but access requires an API subscription; the official lowest Hobbyist plan is personal-use, 4h finest candle interval and 30 requests/minute. Derivatives metrics can be used to understand leverage/crowding risks, never as tradeable Spot prices or a direction command. Do not subscribe until a controlled ablation test shows incremental net benefit over free inputs. See [official API overview and plan table](https://docs.coinglass.com/reference/getting-started-with-your-api).
- Glassnode, CryptoQuant, Santiment and other paid providers remain **unapproved** until exact endpoints, data rights, cost, history depth, request limits and runner reachability are verified. Brand reputation alone is not a sufficient reason to pay.

## Social channels and Telegram — compliance gate

The following are **human-review leads only**, not verified or approved trading sources:
- Shayan Bakhtiari / Crypto Academy — [@ShayanFX_Crypto](https://t.me/ShayanFX_Crypto)
- Khaneh Mali Tosee — [main channel](https://t.me/khanemalii), [Crypto VIP channel](https://t.me/vipcryptokm)
- Cheragh — [@cheragh](https://t.me/cheragh), [signal product page](https://cheragh.com/crypto-signal)
- Bitycle — [@bityclecom](https://t.me/bityclecom); currently categorized as platform/content lead, not a verified signal stream
- Behrooz Ahmadi (owner-confirmed intended channel) — [@behroozahmadieco](https://t.me/behroozahmadieco); treat as macro/market commentary unless complete Spot-long calls are demonstrated

**Do not scrape, bulk collect, index, archive or aggregate Telegram public-channel messages for this AI/ML trading research.** Telegram's Bot Developer Terms prohibit using a bot to collect/aggregate public group or channel content to build datasets and AI/ML products. Telegram's API/content-licensing terms also restrict scraping/harvesting/indexing/aggregation and AI/ML use; the stated exception requires explicit, informed, affirmative and continuing consent from each relevant user for the specific content/context. A publicly visible channel is not itself a license to harvest its contents.

Permitted routes to evaluate, subject to terms and copyright review:
1. A provider-operated API or data export whose license explicitly permits automated collection, retention, analysis and this intended research use.
2. A direct signal feed from the provider under written permission and explicit data rights.
3. A user voluntarily submits an individual message to a bot after clear notice and explicit, active, revocable consent; this is not a workaround for bulk collection and does not itself establish the author's rights to redistribute the message.

Official terms: [Telegram Bot Developer Terms, section 4.3](https://telegram.org/tos/bot-developers); [Telegram Content Licensing and AI Scraping Terms](https://telegram.org/tos/content-licensing); [Telegram API Terms](https://core.telegram.org/api/terms). Re-check terms before implementation because they can change.

## Integration sequence

1. Probe Coin Metrics Community, DefiLlama and Alternative.me from the actual GitHub Actions runner using unauthenticated, bounded GET requests. Store only source name, endpoint ID, capture time, HTTP/schema result, latency, record count and freshness metadata; avoid storing high-volume payloads until data rights and quality are reviewed.
2. For any metric used, document exact definition, asset coverage, units, frequency, historical depth, update latency, methodology changes, attribution and free-tier limitations.
3. Run an ablation study: baseline market-data strategy versus baseline plus exactly one context feature at a time. Use the existing fixed train/OOS/holdout split, global multiple-testing correction and realistic costs. Reject features that merely restate price/volume or fail to improve net outcome and drawdown.
4. Keep external data as research context. Confirm all eligible candidates on fresh Tabdeal Spot quotes and local order books; IRT remains disabled for execution until denomination/settlement are verified.
5. Do not add CoinGecko/CMC/FRED/CoinGlass secrets or paid subscriptions until a concrete evidence gap is identified and the owner opts into that specific additional dependency.

## Non-negotiable project boundary
- Spot only; long-only; no leverage, margin, futures, shorts, loans, withdrawals or transfers.
- Public repository stays credential-free; API keys, account data, private logs and Telegram account sessions never belong here.
- No data provider or channel is "trusted" merely because it is popular, paid, or well-known.
- No signal source creates an order. Paper and live promotion require the same independent evidence and risk gates as any other strategy.
