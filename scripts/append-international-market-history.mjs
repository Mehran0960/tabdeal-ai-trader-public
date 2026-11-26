#!/usr/bin/env node
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

const isRecord=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const validMonth=value=>/^\d{4}-\d{2}$/.test(value);

function candleKey(row) {
  return [row.provider,row.symbol,row.interval,row.openTimeMs].join("|");
}

function recordMonth(row) {
  const timeMs=row.recordType==="candle"||row.recordType==="cross_venue_check"
    ? Number(row.openTimeMs)
    : Number(row.capturedAtMs);
  if (!Number.isSafeInteger(timeMs)||timeMs<=0) throw new Error("international_history_record_time_invalid");
  return new Date(timeMs).toISOString().slice(0,7);
}

export async function appendInternationalMarketSnapshot({
  inputPath=path.join("artifacts","international-market-history","latest.json"),
  historyDir=path.join("data","international-market-history")
}={}) {
  const snapshot=JSON.parse(await readFile(inputPath,"utf8"));
  if (snapshot?.schemaVersion!==1 ||
      snapshot?.provider!=="INTERNATIONAL_MARKET_HISTORY" ||
      !/^[a-f0-9]{64}$/.test(String(snapshot.snapshotId||"")) ||
      !Array.isArray(snapshot.candles) || !Array.isArray(snapshot.tabdealBooks) ||
      !Array.isArray(snapshot.crossChecks) ||
      snapshot.safety?.unauthenticatedPublicGetOnly!==true ||
      snapshot.safety?.apiKeysUsed!==false ||
      snapshot.safety?.apiSecretsUsed!==false ||
      snapshot.safety?.privateEndpointsUsed!==false ||
      snapshot.safety?.accountDataRead!==false ||
      snapshot.safety?.orderSubmissionAttempted!==false ||
      Number(snapshot.safety?.exchangeOrdersPlaced)!==0 ||
      snapshot.safety?.fundsMoved!==false ||
      snapshot.safety?.liveTradingEnabled!==false) {
    throw new Error("international_market_history_snapshot_contract_invalid");
  }
  const capturedAtMs=Date.parse(String(snapshot.capturedAt||""));
  if (!Number.isFinite(capturedAtMs)) throw new Error("international_market_history_capture_time_invalid");

  await mkdir(historyDir,{recursive:true});
  const files=(await readdir(historyDir)).filter(name=>/^\d{4}-\d{2}\.jsonl$/.test(name));
  const knownByMonth=new Map();
  for (const name of files) {
    const month=name.slice(0,7);
    const content=await readFile(path.join(historyDir,name),"utf8");
    const keys=new Set();
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try { row=JSON.parse(line); }
      catch { throw new Error("international_market_history_existing_jsonl_corrupt"); }
      const key=row.recordType==="candle"
        ? candleKey(row)
        : row.recordType==="tabdeal_book"
          ? [row.symbol,row.capturedAtMs].join("|")
          : row.recordType==="cross_venue_check"
            ? [row.baseAsset,row.interval,row.openTimeMs].join("|")
            : null;
      if (!key) throw new Error("international_market_history_existing_record_invalid");
      keys.add(key);
    }
    knownByMonth.set(month,keys);
  }

  const records=[];
  for (const candle of snapshot.candles) {
    if (!isRecord(candle) ||
        !["binance_spot","kraken_spot"].includes(candle.provider) ||
        typeof candle.symbol!=="string" ||
        typeof candle.baseAsset!=="string" ||
        !["USDT","USD"].includes(candle.quoteAsset) ||
        !["15m","1h","4h"].includes(candle.interval) ||
        !Number.isSafeInteger(candle.openTimeMs) ||
        !Number.isSafeInteger(candle.closeTimeMs) ||
        candle.closeTimeMs>=capturedAtMs ||
        ![candle.open,candle.high,candle.low,candle.close,candle.baseVolume].every(value=>Number.isFinite(Number(value)))) {
      throw new Error("international_market_history_candle_invalid");
    }
    records.push({recordType:"candle",snapshotId:snapshot.snapshotId,capturedAt:snapshot.capturedAt,...candle});
  }
  for (const book of snapshot.tabdealBooks) {
    if (!isRecord(book)||typeof book.symbol!=="string"||
        !Number.isSafeInteger(book.capturedAtMs)||
        book.quoteUnit!=="USDT"||
        typeof book.status!=="string") {
      throw new Error("international_market_history_tabdeal_book_invalid");
    }
    records.push({recordType:"tabdeal_book",snapshotId:snapshot.snapshotId,...book});
  }
  for (const check of snapshot.crossChecks) {
    if (!isRecord(check)||typeof check.baseAsset!=="string"||
        !["15m","1h","4h"].includes(check.interval)||
        !Number.isSafeInteger(check.openTimeMs)||
        !Number.isFinite(Number(check.absoluteDifferenceBps))) {
      throw new Error("international_market_history_cross_check_invalid");
    }
    records.push({recordType:"cross_venue_check",snapshotId:snapshot.snapshotId,capturedAt:snapshot.capturedAt,...check});
  }

  const additions=new Map();
  let duplicates=0;
  for (const row of records) {
    const month=recordMonth(row);
    if (!validMonth(month)) throw new Error("international_history_month_invalid");
    if (!knownByMonth.has(month)) knownByMonth.set(month,new Set());
    const key=row.recordType==="candle"
      ? candleKey(row)
      : row.recordType==="tabdeal_book"
        ? [row.symbol,row.capturedAtMs].join("|")
        : [row.baseAsset,row.interval,row.openTimeMs].join("|");
    const seen=knownByMonth.get(month);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    if (!additions.has(month)) additions.set(month,[]);
    additions.get(month).push(row);
  }

  const appendedFiles=[];
  for (const [month,rows] of additions) {
    const outputPath=path.join(historyDir,month+".jsonl");
    let existing="";
    try { existing=await readFile(outputPath,"utf8"); }
    catch (error) { if (error?.code!=="ENOENT") throw error; }
    const addition=rows.map(row=>JSON.stringify(row)).join("\n")+"\n";
    await writeFile(outputPath,existing+(existing&&!existing.endsWith("\n")?"\n":"")+addition,"utf8");
    appendedFiles.push({month,recordCount:rows.length});
  }
  return {
    snapshotId:snapshot.snapshotId,
    appendedRecordCount:[...additions.values()].reduce((sum,rows)=>sum+rows.length,0),
    duplicateRecordCount:duplicates,
    appendedFiles,
    historyDir
  };
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  appendInternationalMarketSnapshot({
    inputPath:process.argv[2]||undefined,
    historyDir:process.argv[3]||undefined
  }).then(result=>{
    console.log("INTERNATIONAL_MARKET_HISTORY_APPEND_RESULT");
    console.log(JSON.stringify(result,null,2));
  }).catch(error=>{
    console.error("INTERNATIONAL_MARKET_HISTORY_APPEND_FAILED");
    console.error(String(error?.message||error).slice(0,200));
    process.exitCode=1;
  });
}
