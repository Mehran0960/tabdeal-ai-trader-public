#!/usr/bin/env node
import {mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {
  TABDEAL_LIVE_WATCH_POLICY,
  discoverTabdealSpotUniverse,
  buildTabdealSubscriptionBatches,
  normalizeTabdealLiveDepthMessage,
  createTabdealLiveWatchState,
  updateTabdealLiveMinuteBar,
  evaluateTabdealRelativeWatch,
  summarizeTabdealLiveWatch
} from "../src/tabdeal-live-market-watch.js";

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function arg(name,fallback){
  const index=process.argv.indexOf(name);
  return index>=0?process.argv[index+1]??fallback:fallback;
}
function fail(code){throw new Error(code);}
async function getJson(url,{timeoutMs=12_000,fetchImpl=fetch}={}){
  const response=await fetchImpl(url,{
    method:"GET",headers:{accept:"application/json"},redirect:"follow",
    signal:AbortSignal.timeout(timeoutMs)
  });
  if(!response?.ok)throw new Error(response.status===429?"tabdeal_http_429":"tabdeal_http_"+response.status);
  return response.json();
}
async function loadRollingState(filePath,nowMs){
  try{
    const parsed=JSON.parse(await readFile(filePath,"utf8"));
    return createTabdealLiveWatchState(parsed,{nowMs});
  }catch(error){
    if(error?.code==="ENOENT")return createTabdealLiveWatchState(null,{nowMs});
    throw error;
  }
}
function persistStateToSignalHistory({state,historyRepo,stateRelativePath,nowMs}){
  if(!historyRepo)return {persisted:false,reason:"history_repo_not_configured"};
  const absolute=path.join(historyRepo,stateRelativePath);
  const relative=path.relative(historyRepo,absolute);
  if(relative.startsWith("..")||path.isAbsolute(relative))fail("live_watch_state_path_invalid");
  const persisted={
    schemaVersion:TABDEAL_LIVE_WATCH_POLICY.stateSchemaVersion,
    updatedAt:new Date(nowMs).toISOString(),
    barsBySymbol:state.barsBySymbol
  };
  mkdirSync(path.dirname(absolute));
  writeFileSync(absolute,JSON.stringify(persisted)+"\n");
  const git=(args)=>execFileSync("git",["-C",historyRepo,...args],{stdio:"pipe"});
  const quiet=spawnSync("git",["-C",historyRepo,"diff","--cached","--quiet"],{stdio:"pipe"});
  git(["add",relative]);
  const staged=spawnSync("git",["-C",historyRepo,"diff","--cached","--quiet"],{stdio:"pipe"});
  if(staged.status===0)return {persisted:false,reason:"state_unchanged"};
  if(staged.status!==1)throw new Error("live_watch_git_diff_failed");
  git(["pull","--rebase","origin","signal-history"]);
  git(["commit","-m","data: checkpoint continuous Tabdeal live market watch"]);
  try{
    git(["push","origin","HEAD:signal-history"]);
  }catch(error){
    // Concurrent history collectors may push to the same append-only branch.
    // Rebase once; do not retry an uncertain market action (this is data only).
    git(["pull","--rebase","origin","signal-history"]);
    git(["push","origin","HEAD:signal-history"]);
  }
  return {persisted:true,reason:"rolling_minute_history_checkpointed",relativePath:relative};
}
function mkdirSync(directory){
  execFileSync("mkdir",["-p",directory],{stdio:"pipe"});
}
function writeFileSync(filePath,content){
  execFileSync("bash",["-lc","cat > "+JSON.stringify(filePath)+" <<'__TABDEAL_STATE__'\n"+content+"__TABDEAL_STATE__"],{stdio:"pipe"});
}

async function main(){
  const mode=arg("--mode",process.env.TABDEAL_LIVE_WATCH_MODE||"probe");
  const durationMinutes=Number(arg("--duration-minutes",process.env.TABDEAL_LIVE_WATCH_DURATION_MINUTES||"3"));
  const maxMarkets=Number(arg("--max-markets",process.env.TABDEAL_LIVE_WATCH_MAX_MARKETS||String(TABDEAL_LIVE_WATCH_POLICY.maximumMarkets)));
  const batchSize=Number(arg("--batch-size",process.env.TABDEAL_LIVE_WATCH_BATCH_SIZE||String(TABDEAL_LIVE_WATCH_POLICY.subscriptionBatchSize)));
  const historyRepo=arg("--history-repo",process.env.TABDEAL_LIVE_WATCH_HISTORY_REPO||"");
  const stateRelativePath=arg("--state-file","data/tabdeal-live-market-watch/rolling-state.json");
  const outputPath=arg("--output",path.join("artifacts","tabdeal-live-market-watch","latest.json"));
  const persistEveryMinutes=Number(arg("--persist-every-minutes","15"));
  if(!["probe","continuous"].includes(mode))fail("tabdeal_live_watch_mode_invalid");
  if(!Number.isSafeInteger(durationMinutes)||durationMinutes<1||durationMinutes>340)fail("tabdeal_live_watch_duration_invalid");
  if(!Number.isSafeInteger(persistEveryMinutes)||persistEveryMinutes<1||persistEveryMinutes>60)fail("tabdeal_live_watch_persist_interval_invalid");
  if(typeof globalThis.WebSocket!=="function")fail("tabdeal_live_watch_websocket_unavailable");

  const startedAtMs=Date.now();
  const exchangeInfo=await getJson(TABDEAL_LIVE_WATCH_POLICY.apiBase+"/exchangeInfo");
  const universe=discoverTabdealSpotUniverse(exchangeInfo,{maxMarkets});
  if(!universe.markets.length)fail("tabdeal_live_watch_no_supported_spot_markets");
  const symbols=universe.markets.map(row=>row.symbol);
  const quoteBySymbol=new Map(universe.markets.map(row=>[row.symbol,row.quoteAsset]));
  const topicToSymbol=new Map(symbols.map(symbol=>[symbol.toLowerCase()+"@depth@2000ms",symbol]));
  const batches=buildTabdealSubscriptionBatches(symbols,{batchSize});
  const nowMs=Date.now();
  const state=historyRepo
    ?await loadRollingState(path.join(historyRepo,stateRelativePath),nowMs)
    :createTabdealLiveWatchState(null,{nowMs});
  const stats={
    connectionsOpened:0,reconnects:0,subscriptionAcks:0,subscriptionRejections:0,
    receivedMessages:0,invalidMessages:0,ignoredMessages:0,
    eventLagSum:0,eventLagCount:0,maxAbsoluteEventLagMs:0,
    bySymbol:Object.fromEntries(symbols.map(symbol=>[symbol,{
      updateCount:0,lastEventAtMs:null,eventLagMsSum:0,eventLagMsCount:0,
      sequenceFields:[]
    }]))
  };
  const observations=[];
  const persistResults=[];
  let activeSocket=null,stopping=false,connectionTimer=null,reconnectTimer=null;
  let reconnectDelayMs=1_000,lastEvaluationBucket=0,lastPersistAtMs=startedAtMs;
  let subscriptionErrors=[];
  const endAtMs=startedAtMs+durationMinutes*60_000;

  function recordMessage(raw){
    let parsed;
    try{parsed=JSON.parse(raw);}catch{stats.invalidMessages++;return;}
    if(parsed&&Number.isSafeInteger(Number(parsed.id))){
      if(parsed.error){
        stats.subscriptionRejections++;
        subscriptionErrors.push({
          id:Number(parsed.id),
          code:String(parsed.error.code??"subscription_rejected"),
          message:String(parsed.error.msg??"").slice(0,120)
        });
      }else if(parsed.result===null){
        stats.subscriptionAcks++;
      }else{
        stats.ignoredMessages++;
      }
      return;
    }
    if(!isRecordMessage(parsed)||typeof parsed.stream!=="string"){
      stats.ignoredMessages++;return;
    }
    const symbol=topicToSymbol.get(parsed.stream.toLowerCase());
    if(!symbol){stats.ignoredMessages++;return;}
    stats.receivedMessages++;
    const receivedAtMs=Date.now();
    const row=normalizeTabdealLiveDepthMessage(parsed,{
      expectedSymbol:symbol,receivedAtMs,quoteAsset:quoteBySymbol.get(symbol)
    });
    if(!row){stats.invalidMessages++;return;}
    if(Math.abs(row.eventLagMs)>TABDEAL_LIVE_WATCH_POLICY.maximumEventLagMs){
      stats.invalidMessages++;return;
    }
    const current=stats.bySymbol[symbol];
    current.updateCount++;
    current.lastEventAtMs=row.eventTimeMs;
    current.eventLagMsSum+=row.eventLagMs;
    current.eventLagMsCount++;
    for(const field of row.sequenceFields)if(!current.sequenceFields.includes(field))current.sequenceFields.push(field);
    stats.eventLagSum+=row.eventLagMs;
    stats.eventLagCount++;
    stats.maxAbsoluteEventLagMs=Math.max(stats.maxAbsoluteEventLagMs,Math.abs(row.eventLagMs));
    updateTabdealLiveMinuteBar(state,row);
  }
  function isRecordMessage(value){
    return value!==null&&typeof value==="object"&&!Array.isArray(value);
  }
  async function sendSubscriptions(ws){
    const pending=new Map();
    for(const batch of batches)pending.set(batch.id,batch);
    let next=0;
    for(const batch of batches){
      if(stopping||ws!==activeSocket||ws.readyState!==1)break;
      try{ws.send(JSON.stringify(batch.message));}
      catch{subscriptionErrors.push({id:batch.id,code:"subscription_send_failed"});}
      next++;
      await sleep(150);
    }
    return {sent:next,planned:batches.length,pending:pending.size};
  }
  function connect(){
    if(stopping)return;
    let ws;
    try{ws=new globalThis.WebSocket(TABDEAL_LIVE_WATCH_POLICY.websocketUrl);}
    catch{
      scheduleReconnect("socket_constructor_failed");
      return;
    }
    activeSocket=ws;
    stats.connectionsOpened++;
    let opened=false,closedHandled=false;
    connectionTimer=setTimeout(()=>{
      if(!opened){
        try{ws.close();}catch{}
        scheduleReconnect("websocket_open_timeout");
      }
    },15_000);
    ws.addEventListener("open",()=>{
      if(stopping||ws!==activeSocket)return;
      opened=true;
      reconnectDelayMs=1_000;
      clearTimeout(connectionTimer);
      sendSubscriptions(ws).catch(()=>scheduleReconnect("subscription_send_loop_failed"));
    });
    ws.addEventListener("message",async event=>{
      if(stopping||ws!==activeSocket)return;
      let raw=event?.data;
      if(typeof raw!=="string"){
        if(Buffer.isBuffer(raw))raw=raw.toString("utf8");
        else if(raw&&typeof raw.text==="function"){
          try{raw=await raw.text();}catch{stats.invalidMessages++;return;}
        }else raw=String(raw??"");
      }
      recordMessage(raw);
    });
    const onClosed=reason=>{
      if(closedHandled)return;
      closedHandled=true;
      clearTimeout(connectionTimer);
      if(!stopping&&ws===activeSocket){
        activeSocket=null;
        scheduleReconnect(reason);
      }
    };
    ws.addEventListener("error",()=>onClosed("websocket_error"));
    ws.addEventListener("close",()=>onClosed("websocket_closed"));
  }
  function scheduleReconnect(reason){
    if(stopping||reconnectTimer)return;
    stats.reconnects++;
    const delay=Math.min(reconnectDelayMs,60_000);
    reconnectDelayMs=Math.min(reconnectDelayMs*2,60_000);
    reconnectTimer=setTimeout(()=>{
      reconnectTimer=null;
      if(!stopping)connect();
    },delay);
    console.warn("TABDEAL_LIVE_WATCH_RECONNECT",JSON.stringify({reason,delayMs:delay}));
  }
  async function persistCheckpoint(){
    if(!historyRepo)return;
    try{
      const result=persistStateToSignalHistory({
        state,historyRepo,stateRelativePath,nowMs:Date.now()
      });
      persistResults.push({at:new Date().toISOString(),...result});
      lastPersistAtMs=Date.now();
      if(persistResults.length>30)persistResults.shift();
    }catch(error){
      persistResults.push({at:new Date().toISOString(),persisted:false,reason:String(error?.message||error).slice(0,150)});
      console.warn("TABDEAL_LIVE_WATCH_CHECKPOINT_FAILED",String(error?.message||error).slice(0,150));
    }
  }

  connect();
  console.log("TABDEAL_LIVE_MARKET_WATCH_STARTED",JSON.stringify({
    mode,durationMinutes,startedAt:new Date(startedAtMs).toISOString(),
    universe:universe.universe,batchCount:batches.length,batchSize
  }));
  const tickMs=1_000;
  while(Date.now()<endAtMs&&!stopping){
    await sleep(tickMs);
    const now=Date.now();
    const evaluationBucket=Math.floor(now/60_000);
    if(evaluationBucket!==lastEvaluationBucket){
      lastEvaluationBucket=evaluationBucket;
      let evaluation;
      try{evaluation=evaluateTabdealRelativeWatch({state,markets:universe.markets,nowMs:now});}
      catch(error){evaluation={status:"evaluation_error",reason:String(error?.message||error).slice(0,120),tradeAuthorized:false};}
      const item={observedAt:new Date(now).toISOString(),...evaluation};
      observations.push(item);
      if(observations.length>120)observations.shift();
      console.log("TABDEAL_LIVE_RELATIVE_WATCH",JSON.stringify({
        observedAt:item.observedAt,status:item.status,
        availableAssets:item.availableAssets??0,
        candidate:item.candidate??null,reason:item.reason??null,
        tradeAuthorized:false
      }));
    }
    if(historyRepo&&now-lastPersistAtMs>=persistEveryMinutes*60_000){
      await persistCheckpoint();
    }
  }
  stopping=true;
  clearTimeout(connectionTimer);
  clearTimeout(reconnectTimer);
  try{activeSocket?.close(1000,"watch-window-complete");}catch{}
  await persistCheckpoint();
  const endedAtMs=Date.now();
  const report=summarizeTabdealLiveWatch({
    universe,stats,state,nowMs:endedAtMs,durationMs:endedAtMs-startedAtMs,mode
  });
  report.startedAt=new Date(startedAtMs).toISOString();
  report.endedAt=new Date(endedAtMs).toISOString();
  report.observationCount=observations.length;
  report.latestOpportunityObservation=observations.at(-1)||null;
  report.recentOpportunityObservations=observations.filter(row=>row.candidate).slice(-20);
  report.subscriptionErrors=subscriptionErrors.slice(-100);
  report.checkpoints=persistResults;
  report.safety={
    ...report.safety,
    persistedRollingState:Boolean(historyRepo),
    opportunitiesAreProvisionalWatchCandidates:true,
    noTradingDecisionOrOrderWasMade:true
  };
  await mkdir(path.dirname(outputPath),{recursive:true});
  await writeFile(outputPath,JSON.stringify(report,null,2)+"\n","utf8");
  console.log("TABDEAL_LIVE_MARKET_WATCH_COMPLETE");
  console.log(JSON.stringify({
    startedAt:report.startedAt,endedAt:report.endedAt,durationMs:report.durationMs,
    universe:report.universe,
    connectionStats:report.connectionStats,
    recentOpportunityObservations:report.recentOpportunityObservations.slice(-5),
    checkpoints:report.checkpoints.slice(-3),
    exchangeOrdersPlaced:0,liveTradingEnabled:false
  },null,2));
  if(report.connectionStats.distinctSymbolsWithUpdates===0)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{
    console.error("TABDEAL_LIVE_MARKET_WATCH_FAILED");
    console.error(String(error?.message||error).slice(0,200));
    process.exitCode=1;
  });
}
