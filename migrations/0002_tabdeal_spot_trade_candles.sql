CREATE TABLE IF NOT EXISTS tabdeal_spot_trade_state (
  symbol TEXT PRIMARY KEY,
  last_successful_poll_at_ms INTEGER,
  last_attempt_at_ms INTEGER,
  last_trade_id TEXT,
  last_trade_time_ms INTEGER,
  eligible_from_minute_ms INTEGER,
  continuity_epoch INTEGER NOT NULL DEFAULT 0,
  gap_count INTEGER NOT NULL DEFAULT 0,
  last_gap_at_ms INTEGER,
  last_poll_status TEXT NOT NULL DEFAULT 'uninitialized',
  last_error_code TEXT,
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tabdeal_spot_candles_1m (
  symbol TEXT NOT NULL,
  minute_open_ms INTEGER NOT NULL,
  open_price TEXT NOT NULL,
  high_price TEXT NOT NULL,
  low_price TEXT NOT NULL,
  close_price TEXT NOT NULL,
  base_volume TEXT NOT NULL,
  quote_volume TEXT NOT NULL,
  trade_count INTEGER NOT NULL,
  first_trade_time_ms INTEGER NOT NULL,
  last_trade_time_ms INTEGER NOT NULL,
  first_trade_id TEXT NOT NULL,
  last_trade_id TEXT NOT NULL,
  continuity_epoch INTEGER NOT NULL,
  coverage_status TEXT NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (symbol, minute_open_ms)
);

CREATE INDEX IF NOT EXISTS idx_tabdeal_spot_candles_1m_time
  ON tabdeal_spot_candles_1m (symbol, minute_open_ms DESC);
