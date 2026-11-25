#!/usr/bin/env node
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

export async function appendTabdealSpotDepthHistory({
  inputPath = path.join("artifacts", "tabdeal-spot-depth", "latest.json"),
  historyDir = path.join("data", "tabdeal-spot-depth")
} = {}) {
  const snapshot = JSON.parse(await readFile(inputPath, "utf8"));
  if (snapshot?.schemaVersion !== 1 ||
      snapshot?.provider !== "TABDEAL_SPOT_DEPTH_WEBSOCKET" ||
      !/^[a-f0-9]{64}$/.test(String(snapshot.snapshotId || "")) ||
      !Array.isArray(snapshot.symbols) ||
      snapshot.safety?.publicWebsocketOnly !== true ||
      snapshot.safety?.apiKeyUsed !== false ||
      snapshot.safety?.authenticatedAccountAccess !== false ||
      snapshot.safety?.placesOrders !== false ||
      snapshot.safety?.movesFunds !== false ||
      snapshot.safety?.liveTradingEnabled !== false) {
    throw new Error("tabdeal_spot_depth_history_snapshot_invalid");
  }

  const capturedAt = new Date(snapshot.endedAt);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new Error("tabdeal_spot_depth_history_timestamp_invalid");
  }
  const month = capturedAt.toISOString().slice(0, 7);
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
      throw new Error("tabdeal_spot_depth_history_existing_jsonl_invalid");
    }
  }

  if (seen.has(snapshot.snapshotId)) {
    return {appended: false, duplicate: true, outputPath, snapshotId: snapshot.snapshotId};
  }

  const line = JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    durationMs: snapshot.durationMs,
    updateIntervalMs: snapshot.updateIntervalMs,
    requestedSymbols: snapshot.requestedSymbols,
    summary: snapshot.summary,
    symbols: snapshot.symbols,
    methodology: snapshot.methodology,
    safety: snapshot.safety
  });
  await writeFile(outputPath, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + line + "\n", "utf8");
  return {appended: true, duplicate: false, outputPath, snapshotId: snapshot.snapshotId};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  appendTabdealSpotDepthHistory({
    inputPath: process.argv[2] || undefined,
    historyDir: process.argv[3] || undefined
  }).then(result => {
    console.log("TABDEAL_SPOT_DEPTH_HISTORY_APPEND_RESULT");
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error("TABDEAL_SPOT_DEPTH_HISTORY_APPEND_FAILED");
    console.error(String(error?.message || error).slice(0, 180));
    process.exitCode = 1;
  });
}
