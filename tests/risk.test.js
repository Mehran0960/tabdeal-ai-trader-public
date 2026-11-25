import test from "node:test";
import assert from "node:assert/strict";
import { calculateRiskPlan } from "../src/risk.js";

test("risk planner caps notional and loss at stop including fees/slippage", () => {
  const plan = calculateRiskPlan({
    equity: 1_000_000,
    entryPrice: 100,
    stopPrice: 95,
    feeBps: 20,
    slippageBps: 10
  });
  assert.equal(plan.approved, true);
  assert.ok(plan.exposureFraction <= 0.2 + 1e-9);
  assert.ok(plan.maxLossAtStop <= plan.riskBudget + 1e-7);
  assert.equal(plan.assumptions.leverage, false);
  assert.equal(plan.assumptions.liveTradingEnabled, false);
  assert.equal(plan.executionInstruction, "paper_only_no_exchange_order_created");
});

test("risk planner blocks when drawdown or daily loss cap is reached", () => {
  const base = { equity: 1_000_000, entryPrice: 100, stopPrice: 95, feeBps: 10, slippageBps: 10 };
  assert.equal(calculateRiskPlan({ ...base, dailyLossFraction: 0.02 }).reason, "daily_loss_limit_reached");
  assert.equal(calculateRiskPlan({ ...base, drawdownFraction: 0.1 }).reason, "drawdown_limit_reached");
  assert.equal(calculateRiskPlan({ ...base, killSwitch: true }).reason, "kill_switch_active");
});

test("risk planner rejects invalid long stops and missing cost assumptions", () => {
  const base = { equity: 1_000_000, entryPrice: 100, stopPrice: 105, feeBps: 10, slippageBps: 10 };
  assert.equal(calculateRiskPlan(base).reason, "long_stop_must_be_below_entry");
  assert.equal(calculateRiskPlan({ ...base, stopPrice: 95, feeBps: undefined }).approved, false);
});


test("invalid risk configuration fails closed instead of reverting to defaults", () => {
  const base = { equity: 1_000_000, entryPrice: 100, stopPrice: 95, feeBps: 10, slippageBps: 10 };
  assert.equal(calculateRiskPlan({ ...base, riskFraction: "not-a-number" }).reason, "invalid_risk_configuration");
  assert.equal(calculateRiskPlan({ ...base, maxExposureFraction: -1 }).reason, "invalid_risk_configuration");
});
