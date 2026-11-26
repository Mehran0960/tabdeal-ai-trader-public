import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAlternativeFngSnapshot,
  fetchAlternativeFngHistory,
  normalizeAlternativeFngPayload
} from "../src/alternative-fng-history.js";

const capturedAtMs=Date.parse("2026-11-26T08:00:00.000Z");
const payload={
  data:[
    {value:"50",value_classification:"Neutral",timestamp:"1795651200"},
    {value:"35",value_classification:"Fear",timestamp:"1795564800"}
  ],
  metadata:{error:null}
};

test("normalizes historical FNG values into ascending UTC rows with a one-day availability lag",()=>{
  const rows=normalizeAlternativeFngPayload(payload,{capturedAtMs});
  assert.equal(rows.length,2);
  assert.equal(rows[0].value,35);
  assert.equal(rows[0].availableAfterMs,rows[0].publishedAtMs+86_400_000);
  assert.equal(rows[0].attribution,"Data from Alternative.me");
});

test("rejects missing data, malformed values, future dates and stale latest observations",()=>{
  assert.throws(()=>normalizeAlternativeFngPayload({data:[]},{capturedAtMs}),/payload_invalid/);
  assert.throws(()=>normalizeAlternativeFngPayload({data:[{value:"101",timestamp:"1795564800",value_classification:"Greed"}]},{capturedAtMs}),/row_invalid/);
  assert.throws(()=>normalizeAlternativeFngPayload({data:[{value:"20",timestamp:"1795737600",value_classification:"Fear"}]},{capturedAtMs}),/row_invalid/);
  assert.throws(()=>normalizeAlternativeFngPayload({data:[{value:"20",timestamp:"1700000000",value_classification:"Fear"}]},{capturedAtMs}),/source_stale/);
});

test("fails on conflicting duplicate timestamps",()=>{
  const bad={data:[
    {value:"50",value_classification:"Neutral",timestamp:"1795651200"},
    {value:"49",value_classification:"Neutral",timestamp:"1795651200"}
  ]};
  assert.throws(()=>normalizeAlternativeFngPayload(bad,{capturedAtMs}),/duplicate_timestamp_conflict/);
});

test("fetches full public history through one unauthenticated GET and produces a safe snapshot",async()=>{
  let request;
  const snapshot=await fetchAlternativeFngHistory({
    fetchImpl:async(url,options)=>{
      request={url,options};
      return {ok:true,status:200,json:async()=>payload};
    },
    now:()=>new Date(capturedAtMs)
  });
  assert.equal(request.options.method,"GET");
  assert.equal(request.options.redirect,"error");
  assert.match(request.url,/limit=0/);
  assert.equal(snapshot.recordCount,2);
  assert.equal(snapshot.safety.credentialsUsed,false);
  assert.equal(snapshot.safety.exchangeOrdersPlaced,0);
});

test("fails closed on rate limit and invalid JSON/HTTP response",async()=>{
  await assert.rejects(fetchAlternativeFngHistory({
    fetchImpl:async()=>({ok:false,status:429}),
    now:()=>new Date(capturedAtMs)
  }),/http_429/);
  await assert.rejects(fetchAlternativeFngHistory({
    fetchImpl:async()=>({ok:true,status:200,json:async()=>({data:[]})}),
    now:()=>new Date(capturedAtMs)
  }),/payload_invalid/);
});

test("appends monthly JSONL idempotently and detects changed historical rows",async()=>{
  const historyDir=await mkdtemp(path.join(os.tmpdir(),"alternative-fng-"));
  try{
    const snapshot=await fetchAlternativeFngHistory({
      fetchImpl:async()=>({ok:true,status:200,json:async()=>payload}),
      now:()=>new Date(capturedAtMs)
    });
    const first=await appendAlternativeFngSnapshot({snapshot,historyDir});
    assert.equal(first.appendedRecordCount,2);
    const second=await appendAlternativeFngSnapshot({snapshot,historyDir});
    assert.equal(second.appendedRecordCount,0);
    assert.equal(second.duplicateRecordCount,2);
    const rows=[];
    for(const file of first.appendedFiles){
      const text=await readFile(path.join(historyDir,file.month+".jsonl"),"utf8");
      rows.push(...text.trim().split("\n").map(JSON.parse));
    }
    assert.equal(rows.length,2);
    assert.equal(rows.every(row=>row.recordType==="daily_sentiment"),true);
    assert.equal(rows.every(row=>row.availableAfterMs===row.publishedAtMs+86_400_000),true);
    const changed={
      ...snapshot,
      records:snapshot.records.map((row,index)=>index===0?{...row,value:row.value+1}:row)
    };
    const {createHash}=await import("node:crypto");
    changed.snapshotId=createHash("sha256").update(JSON.stringify(changed.records)).digest("hex");
    await assert.rejects(appendAlternativeFngSnapshot({snapshot:changed,historyDir}),/duplicate_timestamp_conflict/);
  }finally{
    await rm(historyDir,{recursive:true,force:true});
  }
});

test("fails closed if existing JSONL is corrupt",async()=>{
  const historyDir=await mkdtemp(path.join(os.tmpdir(),"alternative-fng-corrupt-"));
  try{
    const snapshot=await fetchAlternativeFngHistory({
      fetchImpl:async()=>({ok:true,status:200,json:async()=>payload}),
      now:()=>new Date(capturedAtMs)
    });
    const month=new Date(snapshot.records[0].publishedAtMs).toISOString().slice(0,7);
    const {writeFile}=await import("node:fs/promises");
    await writeFile(path.join(historyDir,month+".jsonl"),"{bad\n","utf8");
    await assert.rejects(appendAlternativeFngSnapshot({snapshot,historyDir}),/existing_jsonl_corrupt/);
  }finally{
    await rm(historyDir,{recursive:true,force:true});
  }
});
