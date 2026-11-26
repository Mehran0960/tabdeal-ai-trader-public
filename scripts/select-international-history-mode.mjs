#!/usr/bin/env node
import {readdir,readFile} from "node:fs/promises";
import path from "node:path";
import {
  INTERNATIONAL_MARKET_PAIRS,
  INTERNATIONAL_INTERVALS
} from "../src/international-market-history.js";

export async function selectInternationalHistoryMode({
  historyDir,
  requestedMode="auto"
}={}){
  if(!historyDir)throw new Error("international_history_dir_required");
  const mode=String(requestedMode);
  if(!["auto","incremental","backfill"].includes(mode)){
    throw new Error("international_history_mode_invalid");
  }
  if(mode!=="auto")return mode;

  let files;
  try{
    files=(await readdir(historyDir)).filter(name=>/^\d{4}-\d{2}\.jsonl$/.test(name));
  }catch(error){
    if(error?.code==="ENOENT")return "backfill";
    throw error;
  }
  if(!files.length)return "backfill";

  const found=new Set();
  for(const name of files.sort()){
    const filePath=path.join(historyDir,name);
    const content=await readFile(filePath,"utf8");
    for(const [index,line] of content.split(/\r?\n/).entries()){
      if(!line.trim())continue;
      let row;
      try{row=JSON.parse(line);}
      catch{
        throw new Error("international_history_jsonl_corrupt_"+name+"_line_"+(index+1));
      }
      if(row?.recordType!=="candle"||row?.provider!=="binance_spot")continue;
      const symbol=String(row.symbol||"").toUpperCase();
      const interval=String(row.interval||"");
      if(INTERNATIONAL_MARKET_PAIRS.some(pair=>pair.binanceSymbol===symbol)&&
         INTERNATIONAL_INTERVALS.some(item=>item.interval===interval)){
        found.add(symbol+"|"+interval);
      }
    }
  }

  const missing=[];
  for(const pair of INTERNATIONAL_MARKET_PAIRS){
    for(const interval of INTERNATIONAL_INTERVALS){
      const key=pair.binanceSymbol+"|"+interval.interval;
      if(!found.has(key))missing.push(key);
    }
  }
  return missing.length?"backfill":"incremental";
}

function argument(name,fallback){
  const index=process.argv.indexOf(name);
  return index>=0?(process.argv[index+1]??fallback):fallback;
}

async function main(){
  const mode=await selectInternationalHistoryMode({
    historyDir:argument("--history-dir",path.join("signal-history","data","international-market-history")),
    requestedMode:argument("--requested-mode","auto")
  });
  process.stdout.write(mode+"\n");
}

if(process.argv[1]&&import.meta.url===new URL("file://"+process.argv[1]).href){
  await main();
}
