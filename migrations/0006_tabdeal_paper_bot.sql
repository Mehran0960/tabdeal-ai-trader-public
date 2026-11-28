CREATE TABLE IF NOT EXISTS tabdeal_paper_bot_state (
  portfolio_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tabdeal_paper_bot_events (
  event_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  event_at_ms INTEGER NOT NULL,
  candle_open_ms INTEGER NOT NULL,
  quantity REAL NOT NULL,
  average_price REAL NOT NULL,
  quote_notional REAL NOT NULL,
  fee_paid REAL NOT NULL,
  realized_pnl_usdt REAL,
  reason TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tabdeal_paper_bot_events_portfolio_time
  ON tabdeal_paper_bot_events (portfolio_id, event_at_ms DESC);
