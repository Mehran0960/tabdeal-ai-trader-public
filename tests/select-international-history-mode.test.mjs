import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  INTERNATIONAL_MARKET_PAIRS,INTERNATIONAL_INTERVALS
} from "../src/international-market-history.js";
import {selectInternationalHistoryMode} from "../scripts/select-international-history-mode.mjs";

async function withHistory(run){
  const root=await mkdtemp(path.join(os.tmpdir(),"tabdeal-history-mode-"));
  const historyDir=path.join(root,"data");
  await mkdir(historyDir,{recursive:true});
  try{return await run(historyDir);}
  finally{await rm(root,{recursive:true,force:true});}
}

function row(symbol,interval){
  return {recordType:"candle",provider:"binance_spot",symbol,interval,openTimeMs:1};
}

test("chooses backfill when the history directory does not exist",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"tabdeal-history-mode-missing-"));
  try{
    assert.equal(await selectInternationalHistoryMode({
      historyDir:path.join(root,"missing"),requestedMode:"auto"
    }),"backfill");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("chooses backfill when any registered asset/timeframe series is missing",async()=>{
  await withHistory(async historyDir=>{
    const records=[];
    for(const pair of INTERNATIONAL_MARKET_PAIRS){
      for(const interval of INTERNATIONAL_INTERVALS){
        if(pair.binanceSymbol==="DOGEUSDT"&&interval.interval==="15m")continue;
        records.push(JSON.stringify(row(pair.binanceSymbol,interval.interval)));
      }
    }
    await writeFile(path.join(historyDir,"2026-11.jsonl"),records.join("\n")+"\n");
    assert.equal(await selectInternationalHistoryMode({historyDir}),"backfill");
  });
});

test("chooses incremental only when every registered Binance series is present",async()=>{
  await withHistory(async historyDir=>{
    const records=INTERNATIONAL_MARKET_PAIRS.flatMap(pair=>
      INTERNATIONAL_INTERVALS.map(interval=>JSON.stringify(row(pair.binanceSymbol,interval.interval))));
    await writeFile(path.join(historyDir,"2026-11.jsonl"),records.join("\n")+"\n");
    assert.equal(await selectInternationalHistoryMode({historyDir}),"incremental");
  });
});

test("explicit incremental and backfill requests override automatic selection",async()=>{
  await withHistory(async historyDir=>{
    assert.equal(await selectInternationalHistoryMode({
      historyDir,requestedMode:"incremental"
    }),"incremental");
    assert.equal(await selectInternationalHistoryMode({
      historyDir,requestedMode:"backfill"
    }),"backfill");
  });
});

test("fails closed on corrupted JSONL instead of assuming history is complete",async()=>{
  await withHistory(async historyDir=>{
    await writeFile(path.join(historyDir,"2026-11.jsonl"),"{bad json\n");
    await assert.rejects(
      selectInternationalHistoryMode({historyDir}),
      /international_history_jsonl_corrupt/
    );
  });
});

test("rejects unknown requested modes",async()=>{
  await withHistory(async historyDir=>{
    await assert.rejects(
      selectInternationalHistoryMode({historyDir,requestedMode:"partial"}),
      /international_history_mode_invalid/
    );
  });
});
