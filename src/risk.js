const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const bounded = (value, fallback, maximum) => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(maximum, number);
};

export function calculateRiskPlan(input = {}) {
  const equity = Number(input.equity);
  const entryPrice = Number(input.entryPrice);
  const stopPrice = Number(input.stopPrice);
  const feeBps = Number(input.feeBps);
  const slippageBps = Number(input.slippageBps);
  const riskFraction = bounded(input.riskFraction, 0.0025, 0.01);
  const maxExposureFraction = bounded(input.maxExposureFraction, 0.2, 0.5);
  const maxDailyLossFraction = bounded(input.maxDailyLossFraction, 0.02, 0.05);
  const maxDrawdownFraction = bounded(input.maxDrawdownFraction, 0.1, 0.2);
  const dailyLossFraction = Number(input.dailyLossFraction ?? 0);
  const drawdownFraction = Number(input.drawdownFraction ?? 0);

  const reject = reason => ({
    approved: false,
    reason,
    quantity: 0,
    notional: 0,
    maxLossAtStop: 0,
    liveTradingEnabled: false
  });
  if (![equity, entryPrice, stopPrice].every(finitePositive)) return reject("invalid_equity_or_price");
  if (![riskFraction, maxExposureFraction, maxDailyLossFraction, maxDrawdownFraction].every(Number.isFinite)) {
    return reject("invalid_risk_configuration");
  }
  if (!Number.isFinite(feeBps) || feeBps < 0 || !Number.isFinite(slippageBps) || slippageBps < 0) {
    return reject("explicit_nonnegative_fee_and_slippage_required");
  }
  if (!Number.isFinite(dailyLossFraction) || dailyLossFraction < 0 ||
      !Number.isFinite(drawdownFraction) || drawdownFraction < 0) return reject("invalid_daily_loss_or_drawdown");
  if (stopPrice >= entryPrice) return reject("long_stop_must_be_below_entry");
  if (input.killSwitch === true) return reject("kill_switch_active");
  if (dailyLossFraction >= maxDailyLossFraction) return reject("daily_loss_limit_reached");
  if (drawdownFraction >= maxDrawdownFraction) return reject("drawdown_limit_reached");

  const feeRate = feeBps / 10_000;
  const slipRate = slippageBps / 10_000;
  const entryFill = entryPrice * (1 + slipRate);
  const exitFillAtStop = stopPrice * (1 - slipRate);
  const roundTripCostsPerUnit = entryFill * feeRate + exitFillAtStop * feeRate;
  const lossPerUnitAtStop = Math.max(0, entryFill - exitFillAtStop) + roundTripCostsPerUnit;
  if (!Number.isFinite(lossPerUnitAtStop) || lossPerUnitAtStop <= 0) return reject("invalid_stop_risk");

  const riskBudget = equity * riskFraction;
  const exposureCap = equity * maxExposureFraction;
  const riskLimitedQuantity = riskBudget / lossPerUnitAtStop;
  const exposureLimitedQuantity = exposureCap / entryFill;
  const affordableQuantity = equity / (entryFill * (1 + feeRate));
  const quantity = Math.max(0, Math.min(riskLimitedQuantity, exposureLimitedQuantity, affordableQuantity));
  if (!Number.isFinite(quantity) || quantity <= 0) return reject("position_below_minimum_or_unaffordable");

  const notional = quantity * entryFill;
  const maxLossAtStop = quantity * lossPerUnitAtStop;
  return {
    approved: true,
    reason: "within_deterministic_risk_limits",
    quantity,
    entryPrice: entryFill,
    stopPrice: exitFillAtStop,
    notional,
    exposureFraction: notional / equity,
    riskBudget,
    maxLossAtStop,
    maxLossFraction: maxLossAtStop / equity,
    assumptions: {
      feeBpsPerSide: feeBps,
      slippageBpsPerSide: slippageBps,
      riskFraction,
      maxExposureFraction,
      maxDailyLossFraction,
      maxDrawdownFraction,
      leverage: false,
      shorting: false,
      liveTradingEnabled: false
    },
    executionInstruction: "paper_only_no_exchange_order_created"
  };
}
