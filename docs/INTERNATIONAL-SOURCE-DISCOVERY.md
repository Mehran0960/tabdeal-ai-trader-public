# International source discovery

Status: **read-only capability probe added; live runner result pending/recorded by GitHub Actions artifact**.

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

Kraken documents public REST and WebSocket market-data interfaces. Its OHLC endpoint currently returns at most 720 recent intervals, and the final returned candle is the current, uncommitted interval; do not treat that last row as closed. Recent Trades returns up to 1,000 recent trades by default. This makes Kraken useful for recent independent validation, but not a standalone long-range candle archive.

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
- CoinGecko keyless ping as an optional diagnostic only.

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
