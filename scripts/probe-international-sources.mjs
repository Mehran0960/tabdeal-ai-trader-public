import {appendFile, mkdir, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {runInternationalSourceProbe} from "../src/international-source-probe.js";

const outputPath = "artifacts/international-source-probe/latest.json";
const report = await runInternationalSourceProbe();

await mkdir(dirname(outputPath), {recursive: true});
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");

const rows = report.probes.map(item =>
  "| " + item.provider + " | " + item.id + " | " + item.status +
  " | " + (item.httpStatus ?? "—") + " | " + item.latencyMs + " ms | " +
  item.recordCount + " |"
).join("\n");
const summary = [
  "## International public market source probe",
  "",
  "- Captured: " + report.capturedAt,
  "- Required provider status: **" + report.requiredProviderStatus + "**",
  "- Mode: unauthenticated public GET only",
  "",
  "| Provider | Probe | Result | HTTP | Latency | Records |",
  "|---|---|---|---:|---:|---:|",
  rows,
  "",
  "This probe tests reachability and response shape only; it does not validate history completeness or profitability."
].join("\n");

console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n", "utf8");
}
