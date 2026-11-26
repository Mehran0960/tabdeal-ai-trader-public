# Verified auxiliary data sources — Tabdeal Spot research

Status: **Binance/Kraken/Tabdeal market-data lanes are active; Alternative.me daily Bitcoin Fear & Greed is the only new auxiliary source cleared for scheduled context capture.** Coin Metrics Community and DefiLlama passed one-off technical probes but are excluded from recurring collection and strategy use until data-use rights are explicitly cleared. No new paid subscription or API key is added.

## Data roles — do not confuse context with execution

| Role | Source | Intended use | Status |
|---|---|---|---|
| Global Spot OHLCV/trades/depth | Binance Spot Market Data Only | Primary external research history and market structure | Already integrated and runner-tested |
| Independent Spot cross-check | Kraken Spot public REST/WebSocket | Cross-venue validation and independent historical check | Already integrated and runner-tested |
| Local executable market | Tabdeal Spot public API/book | Symbol availability, quote unit, spread, local depth and final local-price confirmation | Partial; IRT meaning and depth sequence semantics remain unresolved |
| Network/on-chain metrics | Coin Metrics Community API | Slow regime / network-flow context | Excluded from automation: Community data is non-commercial only |
| DeFi / stablecoin context | DefiLlama free API | Daily/weekly ecosystem TVL and stablecoin regime context | Excluded from automation pending written permission |
| Broad crypto sentiment | Alternative.me Fear & Greed API | Daily BTC-oriented sentiment context; never a stand-alone entry signal | Daily history capture added in PR; commercial use requires attribution |
| Independent asset metadata/market overview | CoinGecko Demo API | Asset identity, aggregate market-cap/volume sanity check; not local execution pricing | Optional; free Demo key required |
| Alternative asset metadata | CoinMarketCap Basic | Fallback metadata/market overview if CoinGecko coverage is inadequate | Redundant alternative; do not integrate both without a demonstrated need |
| Macro-economic series | FRED API | Slow macro regime context (rates/liquidity); not intraday entry timing | Later; free registration/API key required |
| Derivatives positioning | CoinGlass API | Optional futures OI/funding/liquidation context only; no derivatives trading | Deferred: paid API; lowest Hobbyist tier is limited to 4h interval and 30 requests/minute |

## One-off technical source probe — 2026-11-26

Run [45866076255](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45866076255) from GitHub Actions verified that Binance, Kraken, CoinGecko's public ping, Coin Metrics Community, DefiLlama and Alternative.me returned valid narrow response shapes. The one-off tests were diagnostic only. Because the current Coin Metrics Community and DefiLlama terms do not clear this intended automated trading use, those two sources are not in the scheduled probe list and are not used as strategy inputs. CoinGecko's full market-data API was not tested. Alternative.me is the only additional provider cleared for recurring context capture under its published commercial-attribution rule.

The new daily collector is implemented in [PR #20](https://github.com/Mehran0960/tabdeal-ai-trader-public/pull/20); it is not considered operational until the PR is merged and a scheduled capture is observed.

## Priority sources

### Already active — market data
- **Binance Spot Market Data Only:** official unauthenticated public endpoints include klines, trades/aggregate trades, depth, book ticker and exchange metadata. The public research pipeline already uses Spot USDT candles. See [official endpoint scope](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md).
- **Kraken Spot:** independent Spot market data for OHLC/trades/order-book cross-checking. Apply endpoint-specific rate limits and preserve Kraken's native symbols/units. See [official API reference](https://docs.kraken.com/api/).
- **Tabdeal:** only source for the final local quote, order book, symbol rules, account fee tier and order eligibility. An external quote must never become a Tabdeal fill price.

### Excluded pending data-use rights and approved low-frequency context
- **Coin Metrics Community (excluded pending rights):** a one-off endpoint/schema probe passed in run [45866076255](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45866076255). The Community tier is explicitly described as free for non-commercial use; this trading project must not use the data in scheduled collection or strategy features unless Coin Metrics confirms the intended use in writing. See [official API access terms](https://github.com/coinmetrics/product-docs/blob/master/docs/access-our-data/api/README.md) and [Community package limits](https://github.com/coinmetrics/product-docs/blob/master/docs/packages/coin-metrics-community-data.md). No recurring probe is enabled.
- **DefiLlama free API (excluded pending rights):** a one-off endpoint/schema probe passed and returned 3,285 daily rows in run [45866076255](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45866076255), but its current Terms grant personal, non-commercial access and restrict commercial copying/harvesting without prior written consent. Public API availability does not override those data-use terms. See [DefiLlama Terms of Use, clauses 7–8](https://defillama.com/terms). No recurring probe or strategy use is enabled.
- **Alternative.me Fear & Greed (approved for context capture):** public GET endpoint at https://api.alternative.me/fng/ returns daily 0–100 Bitcoin sentiment observations. The provider explicitly allows commercial use when the source is attributed next to any displayed data; it also prohibits presenting the index as its own service. Its methodology is a composite of volatility, momentum/volume, social activity, surveys, dominance and search trends, so it is correlated context, not independent confirmation or an entry signal. The page describes the current live index as Bitcoin-oriented. Respect the published 60 requests/minute limit and its daily update cadence. See [index methodology and attribution rule](https://alternative.me/crypto/fear-and-greed-index/) and [API documentation and terms](https://alternative.me/crypto/api/).

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

1. Capture Alternative.me's full daily FNG history once per day through its official public API, preserve provider attribution and append-only provenance, and make the historical feature available only after a conservative 24-hour lag. The collector uses one unauthenticated GET and no API key.
2. For any metric used, document exact definition, asset coverage, units, frequency, historical depth, update latency, methodology changes, attribution and free-tier limitations.
3. Run an ablation study: baseline market-data strategy versus baseline plus exactly one context feature at a time. Use the existing fixed train/OOS/holdout split, global multiple-testing correction and realistic costs. Reject features that merely restate price/volume or fail to improve net outcome and drawdown.
4. Keep external data as research context. Confirm all eligible candidates on fresh Tabdeal Spot quotes and local order books; IRT remains disabled for execution until denomination/settlement are verified.
5. Do not add CoinGecko/CMC/FRED/CoinGlass secrets or paid subscriptions until a concrete evidence gap is identified and the owner opts into that specific additional dependency.

## Non-negotiable project boundary
- Spot only; long-only; no leverage, margin, futures, shorts, loans, withdrawals or transfers.
- Public repository stays credential-free; API keys, account data, private logs and Telegram account sessions never belong here.
- No data provider or channel is "trusted" merely because it is popular, paid, or well-known.
- No signal source creates an order. Paper and live promotion require the same independent evidence and risk gates as any other strategy.
