# Social signal discovery and validation policy

Status: **approved for research-only exploration; no social channel has been promoted, no channel collector is enabled, and no social signal can create a Paper or live order.** This is an auxiliary source lane, not a replacement for exchange-market data.

## Decision

Use public crypto signal channels as **hypothesis-discovery and crowd-positioning data only**. Do not copy-trade them, treat follower counts or advertised win rates as proof, or allow a channel post to bypass the existing strategy, data-quality, quote-unit, cost and risk gates.

The scientific case is plausible but narrow. A 2025 *Electronic Markets* study analyzed more than 28,000 explicit recommendations across X, Reddit, Stocktwits and Telegram and found statistically significant short-horizon effects, strongest around the signal publication hour. The paper also notes that the effect can be too brief for retail execution, that results vary by asset, and that its illustrative strategy did not include slippage. This supports testing social signals as a supplement; it does **not** establish that any particular Telegram channel is profitable or actionable on Tabdeal. See [Haase et al. (2025)](https://link.springer.com/article/10.1007/s12525-025-00815-6).

## Telegram-specific compliance gate — higher priority than the collection design below

**Do not scrape, bulk collect, index, archive or aggregate Telegram public-channel messages for this AI/ML trading research.** Telegram's Bot Developer Terms prohibit using a bot to collect/aggregate public group or channel content to build datasets and AI/ML products. Telegram's API/content-licensing terms also restrict scraping/harvesting/indexing/aggregation and AI/ML use; the stated exception requires explicit, informed, affirmative and continuing consent from each relevant user for the specific content/context. Public visibility is not a data license.

This supersedes any earlier suggestion to automatically capture a Telegram channel feed. Channel names below are leads for human review only. Automated ingestion may be reconsidered only after legal/terms review and either (a) a provider-operated API/export with explicit rights for this use, or (b) a direct provider feed with written permission and data rights. A user may voluntarily submit an individual message to a bot after clear notice and explicit, active, revocable consent; this does not authorize bulk collection or resolve the original author's copyright by itself.

Official terms: [Telegram Bot Developer Terms, section 4.3](https://telegram.org/tos/bot-developers); [Content Licensing and AI Scraping Terms](https://telegram.org/tos/content-licensing); [Telegram API Terms](https://core.telegram.org/api/terms).

## Confirmed human-review leads (not verified signal providers)

- Shayan Bakhtiari / Crypto Academy — [@ShayanFX_Crypto](https://t.me/ShayanFX_Crypto)
- Khaneh Mali Tosee — [main channel](https://t.me/khanemalii), [Crypto VIP](https://t.me/vipcryptokm)
- Cheragh — [@cheragh](https://t.me/cheragh), [signal product page](https://cheragh.com/crypto-signal)
- Bitycle — [@bityclecom](https://t.me/bityclecom); currently categorized as a platform/content lead, not a verified signal stream
- Behrooz Ahmadi — [@behroozahmadieco](https://t.me/behroozahmadieco); owner-confirmed intended channel, currently a macro/market-commentary lead unless complete Spot-long calls are demonstrated

## Initial external screening reference

[Litmusignals](https://litmusignals.com/) may be viewed manually as a **third-party channel-discovery reference**, not an approved trade-signal provider. Its public methodology describes tracking signals and flags such as edits/deletions, copy-paste networks and pump-related activity. It also publishes an [archive](https://github.com/Litmusignals-dev/Litmus), but because that archive contains data derived from Telegram, **do not download, ingest, index or use the archive as an AI/ML dataset** unless the required Telegram permissions/consents and the archive's own data rights have been independently established.

Limitations in its published methodology:
- Its headline metric is hit rate, not net profitability or risk-adjusted return.
- Its outcome checks use Bybit and Bitget one-minute candles, not Tabdeal executable bids/asks, fees or fills.
- Some unpriceable signals are excluded, and a post deleted before the monitor captures it may be missed.
- A hash and short preview do not provide a complete, independently reproducible trade plan.

Therefore the tracker may help a human discover names for review, but its archive, rankings and hit rates cannot qualify a source for this bot. See the [published methodology and limitations](https://www.litmusignals.com/disclaimer).

## Required pipeline before a source is usable

1. **Source registry.** Record the exact public channel identifier, canonical name, URL, language, first-seen date, collection method, access/terms status and any known ownership or commercial conflicts. Do not infer legitimacy from subscriber count.
2. **Licensed immutable first-seen capture only.** For provider-authorized APIs/exports or direct permitted feeds, preserve publication time and first-seen time separately, identifiers, normalized fields and a cryptographic content hash. Retain later edits/deletions as additional events; never overwrite the original observation. A late capture must never be backdated to the author's publication time for simulated entry. This step does not authorize scraping Telegram.
3. **Strict extraction.** Parse to a typed schema and retain parse confidence. Ambiguous ticker, direction, entry range, expiry, stop or target means reject for trading research (the text may remain in a non-trading analytics bucket). Model extraction is not allowed to invent missing prices or levels.
4. **Spot-only eligibility.** The execution concept is long-only Tabdeal Spot. Reject futures/perpetuals, margin, leverage, short instructions, liquidation-based calls, borrow/loan instructions and signals that require an unsupported symbol or quote asset. Require a usable entry, stop-loss, target and expiry/time horizon. Never promote a signal with undefined downside.
5. **No look-ahead.** Simulated entry cannot occur before the system first observed the signal. Use the first realistically executable local ask after capture, including latency and spread—not the channel's ideal entry if the market already moved. Record untriggered, expired and missed signals; do not remove them from the denominator.
6. **Tabdeal-local confirmation.** A social post is only a candidate. Re-check current Tabdeal Spot listing, same base/quote pair, fresh local order book, spread, depth, lot/minimum-notional rules and verified fees. Use USDT pairs only while IRT unit/settlement semantics remain unresolved. External exchange prices are research cross-checks, never Tabdeal execution prices.
7. **Conservative outcome resolution.** Include maker/taker fees as applicable, spread, slippage, latency, partial-fill assumptions and position sizing. If target and stop appear touched in the same coarse candle and order cannot be established, count the worse outcome. Track realized net return, R-multiple expectancy, profit factor, max drawdown, worst-window loss, fillability, time-to-entry and tail losses—not hit rate alone.
8. **Dependence and manipulation controls.** Cluster identical or near-identical posts across channels so copied calls are not counted as independent votes. Flag edits, deletions, pump-and-dump proximity, unusual low-liquidity symbols, repeated coordinated timing and sudden bursts. Do not buy VIP access or connect custody/copy-trading services as part of discovery.
9. **Pre-registration and holdout.** Freeze channel list, extraction rules, symbol universe, time horizon, cost model, sample floor and pass/fail gates before scoring. Apply one multiple-testing correction across the full channel × asset × horizon family. Keep a chronological untouched holdout and a forward-only paper record. Repeatedly trying new channels until one passes is data mining, not evidence.
10. **Promotion is separate.** A source may contribute a research feature only after its complete history is reconstructable and its net out-of-sample edge survives the same risk standards as technical strategies. A social signal alone never unlocks live orders.

## Current project boundary

- The existing Tabdeal public signal-page workflow is **not** a Telegram/social-channel collector. Its latest observed scheduled run, [45784659336](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45784659336), completed successfully but captured a source page about 18h 55m old; only 10 of 14 rows were returned across two pages. The workflow correctly marked the source stale and not eligible for trade research.
- No Telegram channel allowlist, message collector, social-signal parser or social Paper ledger is currently enabled.
- Do not add Tabdeal credentials, Telegram sessions, personal phone/session data or other secrets to this public repository. Tabdeal account credentials remain confined to the private operations repository. Public research must consume only public, sanitized observations.
- Automated Telegram ingestion remains disabled. Public visibility alone does not permit bulk collection. Prefer licensed provider APIs/exports or direct authorized feeds; any authenticated collector requires a separate security and terms review before implementation.

## Promotion checklist

A channel stays **unqualified** until all are true:
- complete and timestamped signals are available, including losses, edits, deletions, expired and untriggered calls;
- enough independently resolved signals and time coverage exist under a threshold pre-registered before evaluation;
- no material parser ambiguity or survivorship bias remains;
- duplicate/copy-paste clusters are controlled;
- net returns remain positive after Tabdeal-local execution costs and survive holdout, walk-forward, statistical correction and drawdown gates;
- the forward paper result reproduces without manual selection or hindsight.

The correct outcome may be to reject every channel. The project is not required to trade.
