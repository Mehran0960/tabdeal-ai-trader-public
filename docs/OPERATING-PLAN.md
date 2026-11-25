# Operating plan

## Stage 1 — public market observation

Run `npm run market:scan` locally or dispatch the **Tabdeal Public Market Scan** GitHub Actions workflow. It collects only the allowlisted Spot order-book and recent-trade snapshots and writes a JSON artifact.

The scan is for diagnostics and data-quality measurement, not an entry signal.

The **Tabdeal Public Signal Capture** workflow fetches the public signal page hourly and appends each new source-rendered event snapshot to the `signal-history` branch. The page currently returns only a subset of its reported events, so the stored records carry pagination-completeness flags. They are candidate-discovery context, not standalone trade signals. TDEX is tracked separately and excluded from automated Spot execution.

## Stage 2 — build a trustworthy history

Measure cadence, symbol coverage, page truncation, trade-ID continuity, timestamp ordering, freshness and book quality. Resolve IRT denomination and official fee/minimum-order rules. Do not build candles from incomplete pages.

## Stage 3 — research

Freeze hypotheses before evaluation. Use chronological train/validation/holdout separation, walk-forward checks, matched benchmarks, realistic costs and multiple-testing controls. Preserve rejected results; do not tune repeatedly against the final holdout.

## Stage 4 — paper trading

Use only timestamped, complete-enough inputs. Model queue position, spread, fees, latency and partial fills. Reconcile every simulated order and position across restarts. Record drawdown and kill-switch behaviour.

## Stage 5 — live pilot (not implemented here)

Requires a separate security-reviewed executor, verified exchange permissions and written operating constraints, all research gates passed, and explicit owner authorization. This public repository has no live order path.
