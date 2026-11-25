#!/usr/bin/env node
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {fetchTabdealSignalEvents} from "../src/tabdeal-signal-events.js";

export async function runTabdealSignalCapture(options = {}) {
  return fetchTabdealSignalEvents(options);
}

async function main() {
  const report = await fetchTabdealSignalEvents();
  const outputPath = process.env.TABDEAL_SIGNAL_OUTPUT ||
    path.join("artifacts", "tabdeal-signal-events", "latest.json");
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("TABDEAL_PUBLIC_SIGNAL_CAPTURE_COMPLETE");
  console.log(JSON.stringify({
    capturedAt: report.capturedAt,
    sourceRenderedAt: report.sourceRenderedAt,
    sourceAgeMs: report.sourceAgeMs,
    sourceFreshness: report.sourceFreshness,
    totalEventCount: report.pagination.totalEventCount,
    rowsReturned: report.pagination.rowsReturned,
    numberOfPages: report.pagination.numberOfPages,
    allPagesCaptured: report.pagination.allPagesCaptured,
    spotEligibleRows: report.events.filter(event => event.hasSpotMarket && !event.dexOnlyFlag).length,
    uniqueSymbols: [...new Set(report.events.map(event => event.symbol))],
    eventTypes: [...new Set(report.events.map(event => event.eventType))],
    snapshotId: report.snapshotId,
    outputPath,
    publicPageOnly: report.safety.publicPageOnly,
    apiCredentialsUsed: report.safety.apiCredentialsUsed,
    ordersPlaced: 0
  }, null, 2));

  if (!report.events.length) throw new Error("tabdeal_signal_capture_no_events");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error("TABDEAL_PUBLIC_SIGNAL_CAPTURE_FAILED");
    console.error(String(error?.message || error).slice(0, 180));
    process.exitCode = 1;
  });
}
