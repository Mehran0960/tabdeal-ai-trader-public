# Tabdeal Spot execution locks

## Repeatable BUY runs

The historical one-shot BUY used one permanent client order ID and one permanent Git tag. Those global one-shot identifiers prevented future workflow runs from submitting another buy.

The reusable implementation derives both identifiers from the GitHub Actions run ID:

- Client order ID: `t1shot-btcusdt-<run_id>`
- Execution lock: `refs/tags/tabdeal-one-shot-buy-<run_id>`

This removes the lifetime one-trade restriction while preserving idempotency:
- A new GitHub Actions run receives a new client order ID and a new lock, so a later approved buy can proceed.
- A rerun of the same GitHub Actions run keeps the same run ID and is blocked by its existing lock.
- An uncertain exchange POST is reconciled by client order ID and is never automatically repeated.

## SELL runs

The SELL runner already derives its client order ID and execution lock from the current GitHub Actions run ID. It therefore has no permanent lifetime lock that blocks later sale runs. The per-run lock must remain to prevent duplicate SELL submission on retries.

## Safety controls deliberately retained

- Explicit BUY workflow confirmation remains required.
- Every run rechecks the live account, open orders, exchange filters, balance, spread, visible depth and fees.
- The configured BUY quote cap remains 1 USDT per workflow run.
- Existing open BTCUSDT orders still stop a new order.
- No automatic retry is sent after an uncertain order submission.
- Historical one-shot Git tags are retained for audit; the reusable code no longer uses them as a global lock.

This change only removes the permanent one-shot restriction. It does not activate unattended strategy-driven trading or change the SELL workflow's live-order gate.
