import {mkdir, writeFile} from "node:fs/promises";
import {runPullmolReadOnlyProbe} from "../src/pullmol-readonly-probe.js";

const outputPath = "artifacts/pullmol-probe/latest.json";

try {
  const report = await runPullmolReadOnlyProbe();
  await mkdir("artifacts/pullmol-probe", {recursive: true});
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  const successful = report.requests.filter(item => item.ok).length;
  const failed = report.requests.length - successful;
  const spot = report.requests.find(item => item.path === "/markets");
  const signals = report.requests.filter(item => item.path.startsWith("/signals/"));
  const completePlans = signals.filter(item =>
    item.containsEntryLevels && item.containsStopLoss && item.containsTakeProfitLevels
  ).length;

  console.log(JSON.stringify({
    provider: report.provider,
    requests: report.requests.length,
    successful,
    failed,
    completeSignalPlanEndpoints: completePlans,
    tabdealMarketListAvailable: spot?.containsBTCUSDT === true,
    reportPath: outputPath,
    safety: report.safety
  }, null, 2));

  if (!report.safety.getRequestsOnly ||
      report.safety.credentialsUsed ||
      report.safety.orderSubmissionAttempted ||
      report.safety.fundsMoved) {
    throw new Error("pullmol_probe_safety_invariant_failed");
  }
} catch (error) {
  console.error("pullmol_readonly_probe_failed:", error?.message ?? String(error));
  process.exitCode = 1;
}
