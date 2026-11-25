const finite = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function quoteNotional(levels, predicate = () => true) {
  let total = 0;
  let count = 0;
  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2) continue;
    const price = finite(level[0]);
    const quantity = finite(level[1]);
    if (price === null || quantity === null || price <= 0 || quantity <= 0 || !predicate(price)) continue;
    total += price * quantity;
    count++;
  }
  return { quote: total, count };
}

function imbalancePct(bidQuote, askQuote) {
  const total = bidQuote + askQuote;
  return total > 0 ? ((bidQuote - askQuote) / total) * 100 : null;
}

export function buildMicrostructureSnapshot(orderbook, tradePayload, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  if (!orderbook || orderbook.status !== "ok" ||
      !Array.isArray(orderbook.bids) || !Array.isArray(orderbook.asks) ||
      !orderbook.bids.length || !orderbook.asks.length) {
    throw new Error("invalid_orderbook_for_microstructure");
  }
  const bids = orderbook.bids;
  const asks = orderbook.asks;
  const bestBid = finite(bids[0]?.[0]);
  const bestAsk = finite(asks[0]?.[0]);
  const bidQuantity = finite(bids[0]?.[1]);
  const askQuantity = finite(asks[0]?.[1]);
  if ([bestBid, bestAsk, bidQuantity, askQuantity].some(value => value === null) ||
      bestBid <= 0 || bestAsk <= bestBid || bidQuantity < 0 || askQuantity < 0) {
    throw new Error("invalid_best_quotes");
  }
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
  const sizeTotal = bidQuantity + askQuantity;
  const microprice = sizeTotal > 0
    ? ((bestAsk * bidQuantity) + (bestBid * askQuantity)) / sizeTotal
    : mid;
  const micropriceEdgeBps = ((microprice - mid) / mid) * 10_000;
  const bookUpdateMs = finite(orderbook.lastUpdate);
  const bookAgeMs = bookUpdateMs === null ? null : nowMs - bookUpdateMs;
  if (bookAgeMs !== null && (bookAgeMs < -60_000 || bookAgeMs > 60_000)) {
    throw new Error("stale_orderbook_for_microstructure");
  }

  const bands = {};
  for (const bandBps of [10, 25, 50]) {
    const lower = mid * (1 - bandBps / 10_000);
    const upper = mid * (1 + bandBps / 10_000);
    const bid = quoteNotional(bids, price => price >= lower);
    const ask = quoteNotional(asks, price => price <= upper);
    bands[bandBps] = {
      bidQuote: bid.quote,
      askQuote: ask.quote,
      imbalancePct: imbalancePct(bid.quote, ask.quote)
    };
  }

  const trades = Array.isArray(tradePayload?.trades) ? tradePayload.trades : [];
  let buyQuote = 0;
  let sellQuote = 0;
  let buyCount = 0;
  let sellCount = 0;
  const validTradeTimes = [];
  for (const trade of trades) {
    const price = finite(trade?.price);
    const volume = finite(trade?.volume);
    const time = finite(trade?.time);
    if (price === null || volume === null || time === null || price <= 0 || volume < 0 || time <= 0) continue;
    const quote = price * volume;
    const type = String(trade?.type || "").toLowerCase();
    if (type === "buy") {
      buyQuote += quote;
      buyCount++;
    } else if (type === "sell") {
      sellQuote += quote;
      sellCount++;
    }
    if (type === "buy" || type === "sell") validTradeTimes.push(time);
  }
  const totalAggressorQuote = buyQuote + sellQuote;
  const latestTradeTime = validTradeTimes.length ? Math.max(...validTradeTimes) : null;
  const oldestTradeTime = validTradeTimes.length ? Math.min(...validTradeTimes) : null;
  const tradeAgeMs = latestTradeTime === null ? null : nowMs - latestTradeTime;
  const tradeCoverageMs = oldestTradeTime === null ? null : latestTradeTime - oldestTradeTime;
  const tradeSampleCapped = trades.length >= 100;
  const tradeImbalancePct = totalAggressorQuote > 0
    ? ((buyQuote - sellQuote) / totalAggressorQuote) * 100
    : null;

  return {
    symbol: "BTCIRT",
    capturedAt: new Date(nowMs).toISOString(),
    orderbookLastUpdate: bookUpdateMs,
    orderbookAgeMs: bookAgeMs,
    bestBid,
    bestAsk,
    mid,
    spreadBps,
    microprice,
    micropriceEdgeBps,
    bidQuote10Bps: bands[10].bidQuote,
    askQuote10Bps: bands[10].askQuote,
    depthImbalance10BpsPct: bands[10].imbalancePct,
    bidQuote25Bps: bands[25].bidQuote,
    askQuote25Bps: bands[25].askQuote,
    depthImbalance25BpsPct: bands[25].imbalancePct,
    bidQuote50Bps: bands[50].bidQuote,
    askQuote50Bps: bands[50].askQuote,
    depthImbalance50BpsPct: bands[50].imbalancePct,
    buyQuoteVolume: buyQuote,
    sellQuoteVolume: sellQuote,
    tradeImbalancePct,
    buyTradeCount: buyCount,
    sellTradeCount: sellCount,
    tradeCount: buyCount + sellCount,
    newestTradeTime: latestTradeTime,
    oldestTradeTime,
    tradeAgeMs,
    tradeCoverageMs,
    tradeSampleCapped,
    tradeFlowReliable: !tradeSampleCapped && validTradeTimes.length >= 5 &&
      tradeAgeMs !== null && tradeAgeMs >= -60_000 && tradeAgeMs <= 15 * 60_000,
    interpretation: "Public aggregate order-book and recent trade evidence only. It does not identify traders, reveal their holdings, or prove future price direction."
  };
}

export const microstructureInternals = Object.freeze({ quoteNotional, imbalancePct });
