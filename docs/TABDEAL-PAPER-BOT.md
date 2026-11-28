# Tabdeal forward Paper bot

Last reviewed: 2026-11-28

## Purpose and boundary

This module adds a persistent, single-position, multi-asset forward-Paper portfolio on top of the existing Tabdeal-local one-minute capture and signal monitor. It is an experiment for validating the operational decision/entry/exit loop against fresh Tabdeal Spot books. It is not a live executor, an account manager, or evidence that the strategy is profitable.

- Venue and instruments: Tabdeal Spot USDT markets only; current observation list is BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, PAXGUSDT and DOGEUSDT.
- Signal input: the existing closed local 1-minute candle engine `ema9-21-50-rsi14-macd-5m-v1`; no external USD quote is used as an execution price.
- Virtual starting capital: 100 USDT. This is a simulation parameter, not the user's exchange balance and not a recommendation to deposit 100 USDT.
- Positioning: at most one open virtual position, long-only, no leverage, no margin, no short selling.
- Fills: walk the current local Tabdeal order book; require full fill within the configured slippage cap. No exchange order is created.
- Persistence: D1 stores one portfolio state row and an idempotent event ledger. A per-portfolio lease prevents overlapping cron ticks from opening duplicate positions.
- Read-only dashboard: `GET /market-data/paper-bot`.

## Registered risk and execution assumptions

| Control | Setting |
|---|---:|
| Risk budget per entry | 0.25% of virtual equity |
| Maximum exposure | 20% of virtual equity |
| Daily-loss kill switch | 2% |
| Maximum peak-to-trough drawdown | 20% |
| Modeled fee | 40 bps per side |
| Latency buffer | 5 bps per side |
| Maximum book-walk slippage | 25 bps |
| Maximum spread | 30 bps |
| Minimum depth | 1,000 USDT on each side inside 0.25% of mid |
| Maximum book age | 8 seconds |
| Maximum signal age | 120 seconds |
| Stop loss | 2 × ATR(14) below simulated entry |
| Take profit | 3R |
| Ambiguous stop and target in same 1m candle | stop is assumed first |

The fee and latency values are conservative simulation assumptions until the user's actual account fee tier and execution outcomes are independently audited. They are not represented as the user's actual fees.

## Lifecycle

1. Every minute, the Worker completes the per-symbol public trade poll and updates the local candle/signal records.
2. One portfolio tick reads the latest signal/candle per watchlist symbol. It only requests fresh exchange metadata and local depth for a qualified candidate or the currently held symbol.
3. It rejects stale/incomplete signals, invalid or inactive Spot markets, stale/crossed/wide books, insufficient two-sided depth, invalid lot filters, insufficient cash, or an order-book walk that cannot fill the full virtual quantity.
4. It ranks simultaneous candidates deterministically and opens no more than one virtual position.
5. For an open position, it checks stop, take-profit and trend-alignment exit conditions. If a valid exit cannot be fully filled in the book within the slippage limit, it preserves the position and reports `EXIT_PENDING`; it does not invent a fill.
6. It stores portfolio state and virtual fill events in the same D1 batch. Event IDs are stable across retries.

## Safety contract

The module imports only the existing risk calculator and paper order-book simulator. It has no API-key or secret inputs, no authenticated account requests, and no exchange-order POST path. The Worker endpoint is GET-only and reports `liveTradingEnabled=false`, `exchangeOrdersCreated=0`, and `fundsMoved=false`.

Do not connect this module to the live Spot execution adapter or change these invariants as part of Paper validation. A historical strategy candidate passing its research gates and a forward-Paper bot operating correctly are separate acceptance tests; neither guarantees positive future returns.

## Current limitations and promotion rule

The latest registered strategy tournament documented in the operating plan has not produced a family passing every historical cost, out-of-sample, benchmark, drawdown and multiple-testing gate. The forward-Paper portfolio is therefore an operational validation stage, not promotion to live trading. It must accumulate a meaningful sample of completed entries and exits, then be evaluated net of actual fees, modeled slippage, missed fills, stale-data blocks, drawdown, and benchmark returns. Do not loosen filters to force more trades.