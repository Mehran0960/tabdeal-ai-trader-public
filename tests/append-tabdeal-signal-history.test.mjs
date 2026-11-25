import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {appendTabdealSignalSnapshot} from "../scripts/append-tabdeal-signal-history.mjs";

function snapshot(id = "a".repeat(64)) {
  return {
    schemaVersion: 1,
    provider: "TABDEAL_SIGNAL_PAGE",
    snapshotId: id,
    capturedAt: "2026-11-26T00:00:00.000Z",
    sourceRenderedAt: "2026-11-25T23:59:00.000Z",
    sourceAgeMs: 60_000,
    sourceFreshness: "within_24h",
    pagination: {totalEventCount: 1, numberOfPages: 1, rowsReturned: 1, allPagesCaptured: true, firstPageOnly: false},
    events: [{symbol: "BTC", eventType: "TEST_EVENT", eventKey: "BTC|TEST_EVENT"}],
    safety: {publicPageOnly: true, authenticatedAccountAccess: false, apiCredentialsUsed: false, orderSubmissionAttempted: false}
  };
}

test("appends one deduplicated public signal snapshot to the monthly history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tabdeal-signal-history-"));
  try {
    const inputPath = path.join(root, "latest.json");
    const historyDir = path.join(root, "history");
    await writeFile(inputPath, JSON.stringify(snapshot()), "utf8");
    const first = await appendTabdealSignalSnapshot({inputPath, historyDir});
    const second = await appendTabdealSignalSnapshot({inputPath, historyDir});
    assert.equal(first.appended, true);
    assert.equal(second.appended, false);
    assert.equal(second.duplicate, true);
    const contents = await readFile(first.outputPath, "utf8");
    assert.equal(contents.trim().split("\n").length, 1);
    assert.equal(JSON.parse(contents).snapshotId, "a".repeat(64));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("rejects snapshots that do not meet the public-only safety contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tabdeal-signal-history-"));
  try {
    const inputPath = path.join(root, "latest.json");
    const bad = snapshot();
    bad.safety.apiCredentialsUsed = true;
    await writeFile(inputPath, JSON.stringify(bad), "utf8");
    await assert.rejects(appendTabdealSignalSnapshot({inputPath, historyDir: path.join(root, "history")}), /snapshot_contract_invalid/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
