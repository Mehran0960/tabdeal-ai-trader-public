# International source discovery

Status: **read-only capability probe completed successfully from GitHub Actions runner on 2026-11-26**. The exact run is [45757469205](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45757469205).


## Multi-timeframe history and strategy screen — 2026-11-26

The separate [International Market History Capture](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45795173580) workflow appended fresh closed candles and local Tabdeal USDT books to the `signal-history` branch. Its next scheduled cadence is configured for every 15 minutes at minute 05/20/35/50. The strategy research workflow is configured hourly at minute 12.

Latest fully validated report: [GitHub Actions run 45795362370](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45795362370), [full JSON artifact](https://github.com/Mehran0960/tabdeal-ai-trader-public/actions/runs/45795362370/artifacts/15103963982).

Observed report:
- Read 66,756 JSONL history records; selected 64,164 Binance Spot USDT candles for BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT.
- 15m: 11,592 closed candles (2,898 per asset); 1h: 35,052 (8,763 per asset); 4h: 17,520 (4,380 per asset).
- All 12 asset/timeframe series passed freshness checks. No duplicates or missing intervals were detected in these selected Binance series.
- Latest closed bars were 09:45 UTC (15m), 09:00 UTC (1h) and 08:00 UTC (4h) on 2026-11-26.
- Tested 108 fixed hypotheses: four assets × three timeframes × EMA trend, Donchian breakout and RSI mean-reversion × three cost cases. Each profile used an 80/20 discovery/untouched-holdout split; OOS windows were 68 (15m), 109 (1h) and 108 (4h) per hypothesis.
- One global Benjamini-Hochberg correction was applied across the full 108-hypothesis family; one-sided exact binomial sign tests were used for window outperformance.
- Cost cases are **assumptions, not verified Tabdeal fees**. Per-side fee/slippage bps: 15m base 10/20, moderate 20/40, severe 35/70; 1h base 10/15, moderate 20/30, severe 35/55; 4h base 10/10, moderate 20/25, severe 35/50.
- Result: **zero candidates passed all gates**. Profitable net OOS cases: 15m 0/36; 1h 1/36 (0.45% in the base-cost XRP Donchian case, but it failed the worst-window drawdown and untouched-holdout gates); 4h 4/36 (three base and one moderate cases), but none survived all cost, consistency, drawdown, FDR and holdout requirements. All 12 severe-cost cases per timeframe were unprofitable.

This is a negative research result, not an operating failure. It prevents an unsupported strategy from being promoted. **No Paper or live order is authorized by this report.** The Tabdeal-local depth synchronization, actual account fee tier/permissions, and IRT denomination/settlement remain independent gates.
 
## Why this lane exists

Tabdeal's currently documented public Spot interface is insufficient on its own for complete historical signal research: the Spot trade stream contract has not been established, the probed Binance-style topic names were rejected, and the public signal page is not a complete versioned historical feed. International sources are therefore used to discover and test candidate signals. Tabdeal remains the intended execution venue, and every candidate must be reconfirmed locally on Tabdeal.

## Initial source order

### 1. Binance Spot — primary no-key source

Official references:
- [Market Data Only endpoints](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md)
- [Spot REST API](https://developers.binance.com/docs/binance-spot-api-docs/rest-api)
- [Binance public historical data files](https://github.com/binance/binance-public-data)

The official Market Data Only host documents public endpoints for klines, trades/aggregate trades, depth, book ticker and exchange metadata without an API key. Public historical files can extend the research horizon. Timestamp handling must distinguish REST millisecond defaults from public Spot data files, whose Spot timestamps changed to microseconds for data from 2025 onward. Normalize timestamps only after validating source and version.

### 2. Kraken Spot — independent cross-check source

Official references:
- [Kraken Spot REST market-data documentation](https://docs.kraken.com/api-reference/market-data/get-server-time)
- [Kraken OHLC endpoint](https://docs.kraken.com/api-reference/market-data/get-ohlc-data)
- [Kraken Recent Trades endpoint](https://docs.kraken.com/api-reference/market-data/get-recent-trades)
- [Kraken Spot WebSocket v2 ticker channel](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker)

Kraken documents public REST and WebSocket market-data interfaces. Its OHLC endpoint documents a 720-row recent-history cap and includes the current, uncommitted interval as the last row; do not treat that last row as closed. The first actual probe returned 721 total rows (720 prior intervals plus the current uncommitted row), so pagination/cap semantics must be explicitly rechecked during collector implementation. Recent Trades returned 1,000 rows in the first probe, consistent with the endpoint's default recent-trade window. This makes Kraken useful for recent independent validation, but not a standalone long-range candle archive.

### 3. CoinGecko — optional context only

Official references:
- [API documentation](https://docs.coingecko.com/)
- [API plans and pricing](https://www.coingecko.com/en/api/pricing)
- [Demo API key setup](https://support.coingecko.com/articles/9471335603-user-guide-how-to-sign-up-for-coingecko-demo-api-and-generate-an-api-key)

CoinGecko is optional for broad-market context, rankings and metadata. The current free Demo access requires a Demo API key. It must not be treated as a no-key dependency or a substitute for exchange-grade intraday trade/book data. Do not create or add a key unless a concrete research gap justifies it; no paid tier is approved.

## Probe implementation

The workflow [International Public Market Source Probe](../.github/workflows/international-source-probe.yml) tests:
- Binance public ping, BTCUSDT exchange metadata and a small BTCUSDT 1h kline sample.
- Kraken public server time, XBT/USD 1h OHLC and recent trades.
- CoinGecko keyless ping as an optional diagnostic only (HTTP 200 in the first probe; this health endpoint does not prove that market-data endpoints are available without a Demo key).

It uses unauthenticated GET requests only. The report stores status, HTTP code, response latency, record counts and schema verdicts—not price, quantity, trade payloads, keys or account information. The workflow runs on relevant main-branch changes and can also be started manually. It is not a continuous market collector and has no scheduled polling.

A successful probe proves only reachability and basic response-shape validity from that GitHub Actions run. It does not establish source terms, historical completeness, timestamp correctness across all pages, data continuity, latency suitability, local Tabdeal basis, signal quality or profitability.

## Data normalization and research requirements

For every retained observation, record provider, source endpoint, symbol, base/quote assets, source event time, capture time, timestamp unit, interval, candle-closed flag, pagination/cursor state and source provenance.

Reject malformed OHLCV, missing/out-of-order/duplicate bars, stale feeds, unclosed candles, unit ambiguity and incomplete pagination. Never fabricate or forward-fill missing bars. Compare only like-for-like base and quote currencies unless a separate synchronized conversion has been verified. Keep USD, USDT, IRT, RIAL and TOMAN distinct.

## Signal-to-execution boundary

**International data discovers candidates; Tabdeal data decides whether a candidate is locally actionable.**

Before a signal can enter forward Paper, confirm:
1. The same asset and quote pair exists and is enabled for Tabdeal Spot.
2. Its quote unit and settlement semantics are verified.
3. A fresh local Tabdeal book confirms spread, depth and plausible fill/slippage.
4. Local fees, minimum notional, lot size and other exchange filters are known.
5. Cross-venue price basis and timestamp/transport latency are measured and acceptable.

External prices must never be passed to a Tabdeal executor as local executable prices. A missing local check means WAIT/no-trade.

## Safety

No API key, account endpoint, order, transfer, withdrawal, margin, futures or TDEX operation is used by this probe. CoinGecko remains optional and no paid API is authorized.

## First actual runner result — 2026-11-26T04:48:01Z

The bounded probe completed from a GitHub-hosted Ubuntu 26.04 runner in Azure westus3. Results:
- Binance: 3/3 checked public endpoints returned HTTP 200 and passed basic schema checks; the BTCUSDT 1h kline probe returned five rows.
- Kraken: 3/3 checked public endpoints returned HTTP 200 and passed basic schema checks; OHLC returned 721 rows including the current uncommitted row, and Recent Trades returned 1,000 rows.
- CoinGecko: the keyless ping endpoint returned HTTP 200. This is only a ping/health response; no market-data endpoint was tested, and no assumption of keyless data access is made.
- No credentials or private endpoints were used; no account data, orders or fund movement occurred.

This confirms actual runner reachability and response-shape compatibility for the small probes only. It does **not** yet prove backfill completeness, long-term reliability, legal/terms suitability, timestamp correctness over pagination, signal edge or profitability.
