import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {appendTabdealSpotDepthHistory} from "../scripts/append-tabdeal-spot-depth-history.mjs";

function snapshot(id = "b".repeat(64)) {
  return {
    schemaVersion: 1,
    provider: "TABDEAL_SPOT_DEPTH_WEBSOCKET",
    snapshotId: id,
    startedAt: "2026-11-26T00:00:00.000Z",
    endedAt: "2026-11-26T00:01:00.000Z",
    durationMs: 60_000,
    updateIntervalMs: 2000,
    requestedSymbols: ["BTCUSDT"],
    summary: {requestedSymbolCount: 1, symbolsWithUpdates: 1, symbolsWithoutUpdates: [], receivedMessageCount: 1, invalidMessageCount: 0, ignoredMessageCount: 0},
    symbols: [{symbol: "BTCUSDT", updateCount: 1, meanSpreadBps: 10}],
    methodology: {source: "official public Spot market WebSocket"},
    safety: {publicWebsocketOnly: true, apiKeyUsed: false, authenticatedAccountAccess: false, placesOrders: false, movesFunds: false, liveTradingEnabled: false}
  };
}

test("appends and deduplicates public Spot depth summaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tabdeal-depth-history-"));
  try {
    const inputPath = path.join(root, "latest.json");
    const historyDir = path.join(root, "history");
    await writeFile(inputPath, JSON.stringify(snapshot()), "utf8");
    const first = await appendTabdealSpotDepthHistory({inputPath, historyDir});
    const second = await appendTabdealSpotDepthHistory({inputPath, historyDir});
    assert.equal(first.appended, true);
    assert.equal(second.appended, false);
    assert.equal(second.duplicate, true);
    const contents = await readFile(first.outputPath, "utf8");
    assert.equal(contents.trim().split("\n").length, 1);
    assert.equal(JSON.parse(contents).snapshotId, "b".repeat(64));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("rejects depth records that claim authenticated or execution capabilities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tabdeal-depth-history-"));
  try {
    const inputPath = path.join(root, "latest.json");
    const bad = snapshot();
    bad.safety.apiKeyUsed = true;
    await writeFile(inputPath, JSON.stringify(bad), "utf8");
    await assert.rejects(appendTabdealSpotDepthHistory({inputPath, historyDir: path.join(root, "history")}), /snapshot_invalid/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
