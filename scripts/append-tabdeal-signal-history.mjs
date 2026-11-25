#!/usr/bin/env node
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

export async function appendTabdealSignalSnapshot({
  inputPath = path.join("artifacts", "tabdeal-signal-events", "latest.json"),
  historyDir = path.join("data", "tabdeal-signal-events")
} = {}) {
  const raw = await readFile(inputPath, "utf8");
  const snapshot = JSON.parse(raw);
  if (snapshot?.schemaVersion !== 1 || snapshot?.provider !== "TABDEAL_SIGNAL_PAGE" ||
      !/^[a-f0-9]{64}$/.test(String(snapshot.snapshotId || "")) ||
      !Array.isArray(snapshot.events) || snapshot.safety?.publicPageOnly !== true ||
      snapshot.safety?.authenticatedAccountAccess !== false ||
      snapshot.safety?.apiCredentialsUsed !== false || snapshot.safety?.orderSubmissionAttempted !== false) {
    throw new Error("tabdeal_signal_history_snapshot_contract_invalid");
  }

  const date = new Date(snapshot.capturedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("tabdeal_signal_history_capture_time_invalid");
  const month = date.toISOString().slice(0, 7);
  const outputPath = path.join(historyDir, month + ".jsonl");
  await mkdir(path.dirname(outputPath), {recursive: true});

  let existing = "";
  try {
    existing = await readFile(outputPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const seen = new Set();
  for (const line of existing.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.snapshotId === "string") seen.add(record.snapshotId);
    } catch {
      throw new Error("tabdeal_signal_history_existing_jsonl_corrupt");
    }
  }

  if (seen.has(snapshot.snapshotId)) {
    return {appended: false, duplicate: true, outputPath, snapshotId: snapshot.snapshotId};
  }

  const line = JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    sourceRenderedAt: snapshot.sourceRenderedAt,
    sourceAgeMs: snapshot.sourceAgeMs,
    sourceFreshness: snapshot.sourceFreshness,
    pagination: snapshot.pagination,
    events: snapshot.events
  });
  await writeFile(outputPath, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + line + "\n", "utf8");
  return {appended: true, duplicate: false, outputPath, snapshotId: snapshot.snapshotId};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  appendTabdealSignalSnapshot({
    inputPath: process.argv[2] || undefined,
    historyDir: process.argv[3] || undefined
  }).then(result => {
    console.log("TABDEAL_SIGNAL_HISTORY_APPEND_RESULT");
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error("TABDEAL_SIGNAL_HISTORY_APPEND_FAILED");
    console.error(String(error?.message || error).slice(0, 180));
    process.exitCode = 1;
  });
}
