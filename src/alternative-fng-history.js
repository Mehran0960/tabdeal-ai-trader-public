import {createHash} from "node:crypto";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import path from "node:path";

const DAY_MS=86_400_000;
const ENDPOINT="https://api.alternative.me/fng/?limit=0&format=json";
const PROVIDER="alternative_me";
const METRIC_ID="bitcoin_fear_greed_daily";
const isRecord=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);

function fail(code){throw new Error(code);}

function integer(value){
  if(typeof value!=="string"&&typeof value!=="number")return null;
  const text=String(value).trim();
  if(!/^\d+$/.test(text))return null;
  const number=Number(text);
  return Number.isSafeInteger(number)?number:null;
}

function isoTime(value){
  if(!Number.isSafeInteger(value)||value<=0)return null;
  const date=new Date(value);
  return Number.isNaN(date.getTime())?null:date.toISOString();
}

function recordKey(row){
  return [row.provider,row.metricId,row.publishedAtMs].join("|");
}

function recordMonth(row){
  const value=isoTime(row.publishedAtMs);
  if(!value)fail("alternative_fng_record_month_invalid");
  return value.slice(0,7);
}

export function normalizeAlternativeFngPayload(payload,{capturedAtMs=Date.now()}={}){
  if(!Number.isSafeInteger(capturedAtMs)||capturedAtMs<=0||
     !isRecord(payload)||!Array.isArray(payload.data)||payload.data.length===0||
     (payload.metadata?.error!==undefined&&payload.metadata?.error!==null&&payload.metadata?.error!=="")){
    fail("alternative_fng_payload_invalid");
  }
  const byTimestamp=new Map();
  for(const item of payload.data){
    if(!isRecord(item))fail("alternative_fng_row_invalid");
    const timestampSeconds=integer(item.timestamp);
    const value=integer(item.value);
    const publishedAtMs=timestampSeconds===null?null:timestampSeconds*1000;
    const classification=typeof item.value_classification==="string"
      ?item.value_classification.trim()
      :"";
    if(!Number.isSafeInteger(publishedAtMs)||publishedAtMs<=0||
       publishedAtMs>capturedAtMs||
       value===null||value<0||value>100||
       classification.length===0||classification.length>40){
      fail("alternative_fng_row_invalid");
    }
    const row={
      provider:PROVIDER,
      metricId:METRIC_ID,
      assetScope:"BTC",
      publishedAtMs,
      publishedAt:isoTime(publishedAtMs),
      value,
      classification,
      // Conservative historical availability: the index is daily and its precise
      // intraday publication time is not part of the historical API contract.
      // Delay use by a full UTC day to reduce retrospective look-ahead risk.
      availableAfterMs:publishedAtMs+DAY_MS,
      availableAfter:isoTime(publishedAtMs+DAY_MS),
      attribution:"Data from Alternative.me",
      sourceUrl:"https://alternative.me/crypto/fear-and-greed-index/"
    };
    const previous=byTimestamp.get(publishedAtMs);
    if(previous&&(previous.value!==row.value||previous.classification!==row.classification)){
      fail("alternative_fng_duplicate_timestamp_conflict");
    }
    byTimestamp.set(publishedAtMs,row);
  }
  const records=[...byTimestamp.values()].sort((a,b)=>a.publishedAtMs-b.publishedAtMs);
  const latest=records.at(-1);
  if(!latest)fail("alternative_fng_history_empty");
  const sourceAgeMs=capturedAtMs-latest.publishedAtMs;
  const sourceFreshness=sourceAgeMs<=48*60*60*1000?"fresh":"stale_over_48h";
  if(sourceFreshness!=="fresh")fail("alternative_fng_source_stale");
  return records;
}

export async function fetchAlternativeFngHistory({
  fetchImpl=fetch,
  now=()=>new Date(),
  timeoutMs=15000,
  endpoint=ENDPOINT
}={}){
  const capturedAt=now().toISOString();
  const capturedAtMs=Date.parse(capturedAt);
  if(!Number.isSafeInteger(capturedAtMs))fail("alternative_fng_clock_invalid");
  const response=await fetchImpl(endpoint,{
    method:"GET",
    headers:{accept:"application/json"},
    redirect:"error",
    signal:AbortSignal.timeout(timeoutMs)
  });
  if(!response?.ok)fail(response?.status===429?"alternative_fng_http_429":"alternative_fng_http_"+(Number(response?.status)||0));
  const payload=await response.json();
  const records=normalizeAlternativeFngPayload(payload,{capturedAtMs});
  const canonical=JSON.stringify(records);
  const snapshotId=createHash("sha256").update(canonical).digest("hex");
  return {
    schemaVersion:1,
    provider:"ALTERNATIVE_ME_FNG_HISTORY",
    capturedAt,
    capturedAtMs,
    endpoint:"GET /fng/?limit=0&format=json",
    snapshotId,
    recordCount:records.length,
    latestPublishedAtMs:records.at(-1).publishedAtMs,
    sourceAgeMs:capturedAtMs-records.at(-1).publishedAtMs,
    records,
    safety:{
      unauthenticatedPublicGetOnly:true,
      credentialsUsed:false,
      privateEndpointsUsed:false,
      accountDataRead:false,
      orderSubmissionAttempted:false,
      exchangeOrdersPlaced:0,
      fundsMoved:false,
      liveTradingEnabled:false
    },
    interpretation:"Daily Bitcoin sentiment context only. Historical rows are conservatively delayed by one full UTC day; this source is not an entry instruction or proof of predictive value."
  };
}

export async function appendAlternativeFngSnapshot({
  snapshot,
  historyDir=path.join("data","alternative-fng-history")
}={}){
  if(!isRecord(snapshot)||snapshot.schemaVersion!==1||
     snapshot.provider!=="ALTERNATIVE_ME_FNG_HISTORY"||
     !/^[a-f0-9]{64}$/.test(String(snapshot.snapshotId||""))||
     !Array.isArray(snapshot.records)||snapshot.records.length===0||
     !Number.isSafeInteger(snapshot.capturedAtMs)||
     snapshot.safety?.unauthenticatedPublicGetOnly!==true||
     snapshot.safety?.credentialsUsed!==false||
     snapshot.safety?.privateEndpointsUsed!==false||
     snapshot.safety?.accountDataRead!==false||
     snapshot.safety?.orderSubmissionAttempted!==false||
     Number(snapshot.safety?.exchangeOrdersPlaced)!==0||
     snapshot.safety?.fundsMoved!==false||
     snapshot.safety?.liveTradingEnabled!==false){
    fail("alternative_fng_snapshot_contract_invalid");
  }
  const canonical=JSON.stringify(snapshot.records);
  const expectedHash=createHash("sha256").update(canonical).digest("hex");
  if(expectedHash!==snapshot.snapshotId)fail("alternative_fng_snapshot_hash_invalid");
  await mkdir(historyDir,{recursive:true});
  const files=(await readdir(historyDir)).filter(name=>/^\d{4}-\d{2}\.jsonl$/.test(name));
  const known=new Map();
  for(const name of files){
    const content=await readFile(path.join(historyDir,name),"utf8");
    for(const line of content.split(/\r?\n/)){
      if(!line.trim())continue;
      let row;
      try{row=JSON.parse(line);}catch{fail("alternative_fng_existing_jsonl_corrupt");}
      if(!isRecord(row)||row.recordType!=="daily_sentiment"||
         row.provider!==PROVIDER||row.metricId!==METRIC_ID||
         !Number.isSafeInteger(row.publishedAtMs)||
         !Number.isInteger(row.value)||row.value<0||row.value>100||
         typeof row.classification!=="string"){
        fail("alternative_fng_existing_record_invalid");
      }
      const key=recordKey(row);
      const previous=known.get(key);
      if(previous&&(previous.value!==row.value||previous.classification!==row.classification)){
        fail("alternative_fng_existing_duplicate_conflict");
      }
      known.set(key,row);
    }
  }
  const additions=new Map();
  let duplicateCount=0;
  for(const row of snapshot.records){
    if(!isRecord(row)||row.provider!==PROVIDER||row.metricId!==METRIC_ID||
       row.assetScope!=="BTC"||!Number.isSafeInteger(row.publishedAtMs)||
       row.publishedAtMs>snapshot.capturedAtMs||
       !Number.isInteger(row.value)||row.value<0||row.value>100||
       typeof row.classification!=="string"||
       row.availableAfterMs!==row.publishedAtMs+DAY_MS||
       row.attribution!=="Data from Alternative.me"){
      fail("alternative_fng_record_invalid");
    }
    const key=recordKey(row);
    const previous=known.get(key);
    if(previous){
      if(previous.value!==row.value||previous.classification!==row.classification){
        fail("alternative_fng_duplicate_timestamp_conflict");
      }
      duplicateCount++;
      continue;
    }
    known.set(key,{value:row.value,classification:row.classification});
    const month=recordMonth(row);
    if(!additions.has(month))additions.set(month,[]);
    additions.get(month).push({
      recordType:"daily_sentiment",
      snapshotId:snapshot.snapshotId,
      capturedAt:snapshot.capturedAt,
      firstCapturedAtMs:snapshot.capturedAtMs,
      ...row
    });
  }
  const appendedFiles=[];
  for(const [month,rows]of additions){
    const outputPath=path.join(historyDir,month+".jsonl");
    const existing=files.includes(month+".jsonl")
      ?await readFile(outputPath,"utf8")
      :"";
    const text=rows.map(row=>JSON.stringify(row)).join("\n")+"\n";
    await writeFile(outputPath,existing+(existing&&!existing.endsWith("\n")?"\n":"")+text,"utf8");
    appendedFiles.push({month,recordCount:rows.length});
  }
  return {
    snapshotId:snapshot.snapshotId,
    appendedRecordCount:[...additions.values()].reduce((sum,rows)=>sum+rows.length,0),
    duplicateRecordCount:duplicateCount,
    appendedFiles,
    historyDir
  };
}

export const ALTERNATIVE_FNG_ENDPOINT=ENDPOINT;
