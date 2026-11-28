# Signal provider execution plan — 2026-11-28

## Decision

De-prioritize Iranian stock-broker OMS/API research for the current delivery track. The user's primary requirement is high automation from signal discovery through execution. Public price data or semi-manual broker login/CAPTCHA does not meet that requirement.

**First operational lane: licensed crypto Spot signal feeds, evaluated against Tabdeal-local executable prices and fees.**

The market-neutral signal schema remains available for future sources, but the next implementation milestone is not another broker connector. It is to obtain a rights-cleared, machine-readable signal feed and validate the source prospectively.

Current implementation reference:
- Provider-neutral signal validator and scorecard: `src/signal-intelligence.js`
- Source registry: `config/signal-sources.json` (intentionally empty)
- Architecture and rights controls: `docs/SIGNAL-INTELLIGENCE-ARCHITECTURE.md`
- Current execution venue remains Tabdeal Spot; live trading remains separately disabled.

## What counts as a usable signal feed

A source is only useful for automated exploitation if it provides, or explicitly permits us to derive, all of the following:

1. Canonical symbol and quote asset (e.g. BTCUSDT, not an ambiguous ticker).
2. Direction and product type. The initial lane supports long-only Spot; futures, leverage, margin, short and liquidation-dependent calls are excluded.
3. Entry price or entry range, stop-loss, one or more take-profit levels, and a time horizon/expiry.
4. Original publication timestamp and an independently captured first-seen timestamp.
5. Updates, cancellations, edits and deleted/retracted calls as append-only events.
6. Complete history including losing, expired, missed and unfilled calls—not a curated winners-only export.
7. Explicit provider rights for automated receipt, machine processing, historical retention and performance research.
8. Stable API/webhook/export contract, rate limits, delivery latency, authentication, uptime expectations, price and support terms.

A provider's advertised win rate, social following, screenshots or a few successful calls is not evidence of profitability.

## Existing candidate channels: current disposition

The existing human-review shortlist was checked in the project's social-signal policy. None is presently qualified for automated Spot execution:

| Candidate | Current disposition | Reason |
|---|---|---|
| Shayan Bakhtiari / Crypto Academy | Reject for current execution scope | The visible sample included leveraged futures/short calls and exchange-referral promotion; not compatible with long-only Spot. |
| Khaneh Mali Tosee | Unqualified | Complete timestamped signal history and independently reconciled net results were not available. |
| Cheragh | Unqualified | Visible examples were short-timeframe futures calls on a partner venue; self-reported performance and referral-gated access are not independent proof. |
| Behrooz Ahmadi | Macro context only | No reliable flow of complete, executable Spot entry/stop/target plans was established. |

These are not permanent judgments about the people or their broader services. A provider can be reassessed if it supplies an authorized Spot-only feed with complete history and suitable data rights. Do not buy VIP access, register through referral links, or deposit at partner exchanges for this project.

## Telegram and source rights

Telegram's current Bot Developer Terms section 4.3 prohibits using a bot to collect, store, aggregate or process data beyond what is essential for the service, including public channel/group scraping to create datasets and AI products. It allows directly and voluntarily submitted data only when the intended use is clearly disclosed and each user gives explicit, active and revocable consent. Telegram's Content Licensing Terms separately prohibit scraping/indexing/harvesting/aggregation or AI/ML use of platform data, subject to narrow consent requirements.

Therefore:
- No MTProto/user-session scraper, bulk Telegram channel collector, browser polling loop, or public-channel archive is to be built for this project.
- Public visibility, channel membership, or the user's own Telegram session is not a content licence.
- A source may be reconsidered through a provider-operated API/export/webhook with explicit data rights and terms, or a separately reviewed, explicitly consented submission flow.
- A provider's own external API is a different integration path, but its API/data terms must still authorize retention and research before we create a historical signal dataset.

Official terms:
- https://telegram.org/tos/bot-developers
- https://telegram.org/tos/content-licensing

## Pullmol: live read-only API probe

Pullmol is a potentially useful *machine-readable market/signal service*, not a verified third-party signal channel. Its documentation advertises public market data, candles, indicators, analysis, event-style signals, strategy backtests and outbound webhooks. It also says routes may require an API key and that documentation responses are examples; API access is explained through its dashboard. See:
- https://pullmol.ir/docs
- https://pullmol.ir/education/pullmol-api-for-developers
- https://pullmol.ir/strategy
- https://pullmol.ir/privacy

A live, unauthenticated GET-only spot check was performed on 2026-11-28 against `pool.pullmol.ir`:

| Endpoint | Observed result | Interpretation |
|---|---|---|
| `GET /services` | HTTP 200 | API catalogue reachable |
| `GET /markets?exchange=tabdeal` | HTTP 200 | Tabdeal market list returned |
| `GET /ticker?exchange=tabdeal&symbol=BTC-USDT` | HTTP 200 | BTC/USDT ticker returned |
| `GET /candles?...&timeframe=1hour&limit=5` | HTTP 200, 3 bars returned | Data returned, but fewer rows than requested; completeness and closed-candle semantics need verification |
| `GET /signals/BTC-USDT?...&timeframe=1hour` | HTTP 200, one EMA Cross event with direction SELL and confidence 80 | Indicator event, not a complete entry/SL/TP trade plan |
| `GET /analysis/BTC-USDT?...&timeframe=1hour` | HTTP 500 | Analysis route failed in the probe |

The ticker response carried source-age metadata around 140 seconds while marking the response fresh against a seven-day stale threshold (604,800,000 ms). That threshold is not suitable for intraday execution. The system must apply its own strict freshness checks, independently of a provider's broad cache TTL.

### Pullmol decision

**Keep as an experimental market-data/indicator feed; do not promote as a signal provider or execution dependency yet.**

Before storing its signals or using its webhook/strategy service, ask the provider to confirm in writing:
- whether API access is permitted for automated trading research and long-term signal-history retention;
- applicable API key, pricing, limits, rate limits and uptime;
- whether the API can emit a complete Spot trade plan with entry, stop, TP levels, expiry and immutable event timestamps;
- whether edits, cancellations and full historical signal outcomes are available;
- precise source timestamp semantics, candle closure, stale thresholds, quote units and market coverage;
- whether webhook delivery can be signed and retried with stable event IDs.

Even after confirmation, Pullmol is only one candidate input. Its live signal output must be independently resolved against Tabdeal's local bid/ask, liquidity, fees, latency and fills.

## Next implementation sequence

### 1. Acquire one authorized Spot signal feed
Start with written API/webhook/export terms from a source. Prefer structured JSON over parsing prose or screenshots. Do not use manual reposting as a substitute for complete source history.

### 2. Connect to the existing normalizer
Use the already-merged signal schema. Add a provider adapter only after rights are documented. Reject signals without a valid entry, stop, expiry, timestamp and quote asset. Keep raw content out of the public repository.

### 3. Capture prospectively
Keep immutable first-seen time, provider timestamp, edits, cancellations, parsing confidence, source version and content hash. Never backdate a signal or remove a loser.

### 4. Paper-resolve on Tabdeal
For each eligible Spot call, simulate the earliest possible Tabdeal-local fill after receipt. Include spread, taker/maker fees, slippage, latency, partial fills, minimum notional and missed entries. Resolve TP/SL order conservatively when market data cannot prove which happened first.

### 5. Rank providers
Use net expectancy in R, profit factor, maximum drawdown, worst rolling window, sample sufficiency, unfilled/missed ratio, delay sensitivity and source reliability. Apply chronological walk-forward and untouched holdout checks. A source score cannot by itself unlock live trading.

### 6. Enable execution only as a separate approval
A source that passes research is still not an order strategy. It must pass portfolio risk, position sizing, market-book, quote-unit, account permission and execution reconciliation checks. Keep long-only Spot and the existing drawdown protections. No leverage.

## Message to request a machine-readable feed

Send this short request to a candidate provider:

> سلام. برای ارزیابی و اتصال سیگنال‌های معاملاتی شما به یک سامانه خودکار Spot، آیا API، وب‌هوک یا خروجی ساختاریافته دارید که همه سیگنال‌ها (شامل موارد ناموفق، منقضی، ویرایش یا لغوشده) را همراه با زمان انتشار، نماد، بازار Spot، محدوده ورود، حد ضرر، TPها و زمان انقضا ارائه کند؟ همچنین لطفاً شرایط استفاده ماشینی، ذخیره تاریخچه، پردازش هوش مصنوعی و ارزیابی آماری، محدودیت درخواست، هزینه و مستندات فنی را اعلام کنید. اتصال فقط برای دریافت و Paper Trading خواهد بود و هیچ حساب یا وجهی به سرویس شما منتقل نمی‌شود.

## Safety invariants

- No stock-broker connector is on the critical path for this signal-first milestone.
- No Telegram scraping or public-channel dataset creation.
- No VIP purchase, referral deposit, copy-trading account or third-party custody.
- No raw signal text, user sessions, phone data or credentials in the public repository.
- No signal can bypass Tabdeal market-data, execution, fee and risk gates.
- Live order submission remains disabled until independent evidence and a separate approval are in place.
