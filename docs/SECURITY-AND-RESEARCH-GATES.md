# Security and research gates

## Public repository boundary

This repository is a public, credential-free research mirror. It intentionally excludes:
- authenticated account-audit code and all account/balance output;
- API secrets, API keys, private headers and authenticated exchange endpoints;
- Cloudflare account/database identifiers, Worker URLs, deployment metadata and operational configuration;
- production Worker handlers, live execution routes, and private workflow history.

The public market scanner uses unauthenticated HTTPS GET requests only. It does not read account information, submit or cancel orders, transfer funds, or withdraw.

Do not add secrets, account data, private logs, personal contact details, or infrastructure identifiers. Never use pull-request code from untrusted contributors with private credentials.

## Market-data quality gates

A single order-book snapshot is not a historical series. A recent-trades response is not assumed complete:
- a response at its requested limit is flagged as potentially truncated;
- an uncapped response remains a recent, unpaginated snapshot;
- no OHLC candles are synthesized from incomplete snapshots;
- IRT must remain `IRT_UNVERIFIED` until its denomination and settlement semantics are confirmed.

A strategy must fail closed on stale, missing, duplicated, out-of-order, or unit-ambiguous data.

The public Tabdeal signal page is ingested using its current server-rendered HTML payload because no versioned signal API contract was established. The parser stores only market-event fields; it drops comments and trader-leaderboard data. It records the source render time and page coverage, and structural changes fail closed. A partial page is never treated as a full event history. These events can seed research candidate discovery but cannot be traded directly or counted as validated labels.

TDEX quotes are excluded from the Spot execution universe. They are indicative swap quotes for a separate decentralized path, not a Spot order book or firm executable price.

## Strategy validation gates

No strategy is live-approved. Before even considering a limited real-money pilot, require:
1. a documented and sufficiently complete history;
2. verified quote units, fees, lot sizes, minimum notionals and venue rules;
3. pre-registered logic and an untouched out-of-sample holdout;
4. walk-forward validation and multiple-testing controls;
5. pessimistic spread, fees, slippage, latency, partial-fill and liquidity modelling;
6. sustained forward paper trading with independent reconciliation;
7. restart, stale-data, loss-limit, drawdown, duplicate-order and kill-switch tests;
8. a separately audited fail-closed executor and explicit owner approval.

A failed gate means no trade. Profit is not guaranteed.
