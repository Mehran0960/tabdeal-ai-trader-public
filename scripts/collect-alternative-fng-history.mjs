#!/usr/bin/env node
import {appendFile,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {
  appendAlternativeFngSnapshot,
  fetchAlternativeFngHistory
} from "../src/alternative-fng-history.js";

function getArg(name,fallback){
  const index=process.argv.indexOf(name);
  return index>=0?process.argv[index+1]??fallback:fallback;
}

const outputPath=getArg("--output",path.join("artifacts","alternative-fng-history","latest.json"));
const historyDir=getArg("--history-dir",process.env.ALTERNATIVE_FNG_HISTORY_DIR||path.join("signal-history","data","alternative-fng-history"));
const snapshot=await fetchAlternativeFngHistory();
await mkdir(path.dirname(outputPath),{recursive:true});
await writeFile(outputPath,JSON.stringify(snapshot,null,2)+"\n","utf8");
const appended=await appendAlternativeFngSnapshot({snapshot,historyDir});
const summary=[
  "## Alternative.me Fear & Greed daily history",
  "",
  "- Captured: "+snapshot.capturedAt,
  "- Historical observations returned: "+snapshot.recordCount,
  "- Latest source date: "+new Date(snapshot.latestPublishedAtMs).toISOString(),
  "- Appended records: "+appended.appendedRecordCount,
  "- Existing duplicates: "+appended.duplicateRecordCount,
  "- History partitions updated: "+appended.appendedFiles.length,
  "- Attribution retained: Data from Alternative.me",
  "- Look-ahead control: historical records usable only after timestamp + 24h",
  "- Credentials used: no",
  "- Exchange orders: 0",
  "- Live trading: disabled",
  "",
  "Daily Bitcoin sentiment context only; not an entry signal."
].join("\n");
console.log(summary);
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary+"\n","utf8");
