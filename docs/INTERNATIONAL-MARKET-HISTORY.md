# International market history and local Tabdeal validation

Status: read-only collector implemented; its first backfill and scheduled capture are validated by GitHub Actions artifacts and the append-only history branch.

## Operating design

- **Signal discovery/history:** Binance Spot public Market Data Only REST endpoints, with Kraken Spot OHLC as an independent cross-source reference.
- **Execution venue:** Tabdeal Spot only. The collector captures Tabdeal's current USDT-quoted Spot books and exchange filters, but never treats Binance/Kraken prices as Tabdeal executable prices.
- **Supported initial universe:** BTC, ETH, SOL and XRP, each against USDT on Binance and Tabdeal; corresponding USD pairs on Kraken. IRT pairs remain excluded while IRT denomination/settlement semantics are unresolved.
- **Intervals:** 15m, 1h and 4h. The initial backfill is capped at 30 days for 15m, 365 days for 1h and 730 days for 4h. The 4h series is the first candidate for the existing strict research/Paper policy, which is defined for 4h. Shorter intervals provide context and later hypothesis tests.
- **Collection cadence:** GitHub Actions every 15 minutes, with bounded request spacing and append-only deduplication. Scheduled Actions are best-effort; gaps are measured, never forward-filled.
- **Storage:** monthly JSONL records in the `signal-history` branch. The branch contains only public market data and compact local Tabdeal book snapshots; it never stores API credentials, balances, user data or exchange account information.

## Sources and constraints

### Binance Spot

Use the official [Spot REST API](https://developers.binance.com/en/docs/products/spot/rest-api) and the public Market Data Only host `https://data-api.binance.vision`. Binance documents chronological response order and millisecond timestamps by default; it also recommends the data-api host for public-only market data. The API returns HTTP 429 when rate limits are exceeded; the client fails closed on 429 rather than continuing to poll. [Official documentation](https://developers.binance.com/en/docs/products/spot/rest-api).

The collector uses public `GET /api/v3/klines` only. Backfill pagination advances from the previous page's last open time plus one full interval, so pages do not overlap. Only candles with a close timestamp earlier than capture time are retained.

### Kraken Spot

Use public `GET /0/public/AssetPairs` and `GET /0/public/OHLC`. Kraken's OHLC endpoint provides a bounded recent window and includes the current uncommitted candle as the final row; the collector excludes it. The current public endpoint limit is 720 intervals, so Kraken is a recent independent check rather than the sole long-range history source. [Kraken OHLC documentation](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).

Cross-source checks compare within-candle percentage returns on aligned asset/interval/open-time rows. Binance uses USDT quotes and Kraken uses USD quotes; raw prices are never joined or silently converted.

### Tabdeal Spot

The collector reads `GET /exchangeInfo` and `GET /depth` for matching active USDT Spot pairs only. It stores best bid/ask, spread, top-five quote depth, update ID and public lot/notional/tick filters. It does not read account endpoints, use API keys, or submit orders. Missing or stale local book evidence means no local execution confirmation.

## Research-quality controls

- Validate OHLC relationships, timestamps, interval alignment, trade-count fields, chronological order and duplicates.
- Discard unclosed candles.
- Keep USD, USDT, IRT, RIAL and TOMAN distinct.
- Record source symbol, base/quote assets, source timestamp, capture timestamp, interval and provenance.
- Preserve missing intervals as gaps. No forward-fill or synthetic candles.
- Compare independent sources on matched timestamps and percentage returns only.
- Keep Tabdeal local order-book evidence separate from global candle prices.
- The collector does not select strategies, generate orders, enable Paper candidates or authorize live trading.

## Next research and Paper gates

1. Accumulate the initial Binance 4h history and recurring incremental observations.
2. Run the existing shared research engine on Binance 4h history, with Kraken cross-checks and explicit conservative cost cases.
3. Require the existing untouched out-of-sample, walk-forward, multiple-testing, stress-cost, drawdown and repeat-confirmation criteria.
4. Confirm every paper candidate with a fresh Tabdeal Spot market, verified unit, local spread/depth, local fee/minimum-order rules and realistic fill model.
5. Keep forward Paper isolated and live execution disabled until a separate security review and explicit owner approval.
