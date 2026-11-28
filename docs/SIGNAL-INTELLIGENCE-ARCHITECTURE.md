# Multi-market signal intelligence

Status: **Phase 1 schema and validation code only. No third-party channel collector, AI model call, signal-to-order route, or live execution is enabled.**

## Objective

Create one provider-neutral signal intelligence layer that can accept structured trade ideas from permission-cleared sources across markets, preserve their original timing, normalize entry/stop/targets, independently resolve outcomes, and compare providers using net results rather than advertised hit rates.

This layer is separate from market-data collection, strategy research, and execution. A parsed signal is a research observation, not an instruction to trade.

## Current implementation in this change

- The source module validates a source's rights and market scope before accepting structured signals.
- Supported market families are crypto Spot, crypto derivatives, equities, ETFs, gold funds, commodities, FX, physical gold, and fixed income.
- The signal schema carries publication time, first-seen time, expiry, instrument, quote unit, side, entry range, stop, ordered TP levels, timeframe, parser confidence, and a SHA-256 hash of the source content.
- Raw message bodies are not stored by the normalizer. Keep the source content only when the feed contract explicitly permits it and a separate retention review approves it.
- Cross-source fingerprints identify likely copied plans without counting the same call as independent evidence.
- Source scoring calculates descriptive win rate, expectancy in R, profit factor, cumulative net R, maximum drawdown in R, missed/no-entry count, and unresolved count from separately resolved observations.
- Promotion output is always livePromotionEligible=false. A positive screen only nominates a source for further chronological holdout review.
- Automated collection is intentionally not enabled in this phase.

## Source permission gate

A source is accepted only if its registry record includes:
1. An approved ingestion mode: licensed_api, provider_export, direct_authorized_feed, or user_authorized_submission.
2. rights.status = verified.
3. Explicit scopes for capture, model_processing, historical_storage, and research.
4. A review timestamp and an evidence reference (contract, provider permission, or documented consent).

Public visibility is not permission. In particular:
- Do not scrape, bulk collect, archive, or aggregate Telegram public-channel content for this AI/ML research without the specific permissions and consents required by Telegram and the applicable content rights holders.
- Do not automate browser scraping of signal groups, paid/VIP rooms, private groups, or channels with unclear access/retention rights.
- A public webpage or API is not automatically licensed for historical storage or model training. Check its current terms and provider permission.
- Do not use sources whose access is conditional on referral deposits, leveraged trading, copy trading, or custody transfer.
- Never put Telegram sessions, personal phone data, exchange secrets, or account credentials in this public repository.

Relevant project policy: Social signal discovery and validation policy (docs/SOCIAL-SIGNAL-DISCOVERY.md).

## Canonical signal contract

The AI extractor, provider adapter, or human-authorized submission must produce structured fields:

| Field | Requirement |
|---|---|
| market | One supported market family |
| instrument.symbol | Canonical instrument symbol |
| instrument.quoteUnit | Exact quote unit (for example USDT, IRT, IRR, or a provider-defined unit) |
| instrument.productType | Spot, equity, ETF, fund, certificate, FX, etc. |
| side | LONG or SHORT |
| entry.min, entry.max | Positive prices; min must not exceed max |
| stopLoss | Positive, directionally valid price |
| targets[] | Ordered, uniquely labelled TP levels |
| publishedAt | Source publication time with timezone |
| firstSeenAt | First time our system actually received the observation |
| expiresAt | Explicit signal expiry |
| timeframe | A supported interval or horizon label |
| parser.confidence | Numeric confidence from 0 to 1 |
| rawContentHash | SHA-256 only; not raw message text |

The schema rejects missing or directionally inconsistent price plans. It does not invent an entry, stop, target, instrument, or timestamp. Low-confidence extraction can be retained as a parsed observation but is excluded from research scoring.

Publication time and first-seen time are distinct. A delayed signal must never be backtested as though it had been received at publication time. The simulated entry must use the first realistically executable market quote after firstSeenAt, including latency, spread, fees, and fill constraints.

Later edits, cancellations, and deletions must be appended as new observation events referencing the original observation. Never overwrite the first-seen record or erase a losing call.

## Market coverage and execution readiness

| Market family | Initial treatment | Execution gate |
|---|---|---|
| Crypto Spot | First signal-research and Paper candidate | Tabdeal Spot adapter only after independent strategy and account-risk approval; currently disabled |
| Crypto derivatives | Research-only metadata; no user capital | Excluded from the current no-leverage Spot execution scope |
| Iranian equities | Research-only until broker and data access are verified | A broker-specific OMS/API and user account permissions must be demonstrated |
| ETFs and gold funds | Research-only; separately classify each fund and quote unit | Broker-specific order API, market hours, fees, minimum order, and settlement must be verified |
| Commodity certificates | Research-only | Exact exchange instrument, broker order route, settlement, and trading session must be verified |
| FX and physical gold | Price/context research only | No automated execution route is approved |
| Fixed income | Research/context only | Validate instrument type, liquidity, early-exit rules, and broker route before any automation |

The existing domestic-exchange-probe checks public market data from Exir, Wallex, and Tabdeal. It is not proof of authenticated order placement, withdrawals, custody safety, or a profitable signal source. Do not equate public market-data API access with an execution API.

The current MVP's execution venue remains Tabdeal Spot. Cross-market order routing is not implemented. Do not connect a signal feed directly to the live order adapter.

## Provider evaluation

Measure each source using the complete prospective observation set, not a marketing-selected sample:
- signal count, independently resolved count, unresolved count, no-entry/missed count;
- win rate, net expectancy in R, profit factor, cumulative net R, maximum drawdown, worst rolling window;
- fees, bid/ask spread, slippage, latency, partial fills, realistic entry delay, minimum order size and quote-unit validity;
- duplicate/copy clusters across providers;
- deleted/edited/retracted calls and source outages;
- results by market, instrument, timeframe, direction, and market regime.

Source scoring is a descriptive screen only. The default sample threshold is 100 resolved trades; a configurable smaller threshold is useful for unit tests, not production promotion. Every provider × instrument × horizon comparison requires pre-registration, multiple-testing correction, chronological walk-forward testing, and an untouched holdout. A 100-trade sample is a starting floor, not proof.

If stop and target are both crossed inside the same unresolved candle, use tick/order-book data where available; otherwise resolve conservatively against the strategy and flag the event as ambiguous. Do not infer intrabar ordering from OHLC alone.

## Delivery sequence

### Phase 1 — schema and controls (this PR)
- Permission-aware source registry validation.
- Provider-neutral signal normalization.
- Content hashing and cross-source fingerprinting.
- Descriptive source scoring with an explicit no-live-promotion invariant.
- Unit tests for invalid permissions, stale observations, price-direction errors, target order, copied signals, and loss-inclusive metrics.

### Phase 2 — source discovery and rights review
- Build an inventory of signal providers and market-data APIs by market.
- Request formal API/export terms, retention rights, timestamps, rate limits, historical coverage, and pricing.
- Add a source only after its rights registry has been reviewed.
- Keep social-channel names as human-review leads unless a provider grants an authorized feed/export.

### Phase 3 — licensed ingestion and AI extraction
- Add provider-specific adapters only for approved feeds.
- Use schema-constrained model output; persist model/version/confidence and a content hash.
- Quarantine ambiguous or low-confidence messages.
- Capture edits, cancellations, retractions, and provider downtime as append-only events.

### Phase 4 — market-specific Paper resolution
- Resolve signals against the correct local venue and quote unit.
- Use bid/ask or trades, not an unrelated exchange's mid-price.
- Apply market-specific session calendars, fees, taxes, tick sizes, lot sizes, min notionals, spread, latency, and fill assumptions.
- Keep each market's performance ledger independent.

### Phase 5 — gated promotion
- Require an untouched holdout and sufficient forward-Paper observations.
- Verify source rights and API reliability again.
- Promote a source as a research feature first; it does not automatically become a trading strategy.
- Live execution requires a separate risk-approved proposal and explicit authorization. This PR grants neither.

## Safety invariants

- No live order is created by this module.
- No account endpoint or API credential is used.
- No source can bypass existing strategy, freshness, price-unit, cost, liquidity, and drawdown gates.
- No public channel is assumed to be a licensed feed.
- The accepted signal does not imply the trade should be taken.
- A zero-qualified-sources outcome is acceptable and preferable to false confidence.
