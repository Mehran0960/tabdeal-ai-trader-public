#!/usr/bin/env node
import {appendFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {buildTabdealSignedReadRequest} from "../src/tabdeal-account-read-auth.js";

function safeCode(data) {
  return data && typeof data === "object" &&
    (typeof data.code === "number" || typeof data.code === "string")
    ? data.code : null;
}

async function readOnlyGet({apiKey,apiSecret,path,params,fetchImpl}) {
  try {
    const request=buildTabdealSignedReadRequest({apiKey,apiSecret,path,params});
    const response=await fetchImpl(request.url,{
      method:"GET",headers:request.headers,redirect:"error",
      signal:AbortSignal.timeout(15000)
    });
    const body=await response.text();
    if(body.length>1_000_000) return {ok:false,httpStatus:response.status,result:"response_too_large"};
    let data;
    try { data=JSON.parse(body); } catch { data=null; }
    if(!response.ok) {
      return {ok:false,httpStatus:response.status,apiErrorCode:safeCode(data),result:"http_error"};
    }
    if(path==="/account") {
      if(!data||typeof data!=="object"||Array.isArray(data)) {
        return {ok:false,httpStatus:response.status,result:"unexpected_schema"};
      }
      return {
        ok:true,httpStatus:response.status,
        accountType:typeof data.accountType==="string"?data.accountType:null,
        canTrade:typeof data.canTrade==="boolean"?data.canTrade:null
      };
    }
    const openOrders=Array.isArray(data)?data:
      data&&typeof data==="object"&&Array.isArray(data.orders)?data.orders:null;
    if(!openOrders) return {ok:false,httpStatus:response.status,result:"unexpected_open_orders_schema"};
    return {ok:true,httpStatus:response.status,openOrderCount:openOrders.length};
  } catch {
    // Never log a request URL, signature, response body or provider error text.
    return {ok:false,httpStatus:null,result:"network_or_signing_error"};
  }
}

export async function runTabdealTradeReadAudit({
  apiKey=process.env.TABDEAL_API_KEY,
  apiSecret=process.env.TABDEAL_API_SECRET,
  fetchImpl=fetch
}={}) {
  const credentialsPresent={
    apiKey:typeof apiKey==="string"&&apiKey.trim()!=="",
    apiSecret:typeof apiSecret==="string"&&apiSecret.trim()!==""
  };
  const checkedAt=new Date().toISOString();
  if(!credentialsPresent.apiKey||!credentialsPresent.apiSecret) {
    return {
      status:"CREDENTIAL_VARIABLES_MISSING",checkedAt,credentialsPresent,
      accountRead:{ok:false,httpStatus:null,result:"not_attempted"},
      openOrdersRead:{ok:false,httpStatus:null,result:"not_attempted"},
      securityClass:"TRADE",ordersSubmitted:false,cancelAttempted:false,fundsMoved:false
    };
  }

  // Execute both independent GET checks even if the first endpoint fails.
  const accountRead=await readOnlyGet({
    apiKey,apiSecret,path:"/account",params:{},fetchImpl
  });
  const openOrdersRead=await readOnlyGet({
    apiKey,apiSecret,path:"/openOrders",params:{symbol:"PAXGUSDT"},fetchImpl
  });
  const status=accountRead.ok&&openOrdersRead.ok
    ?"SIGNED_ACCOUNT_AND_OPEN_ORDERS_CONFIRMED"
    :accountRead.ok
      ?"ACCOUNT_READ_OK_OPEN_ORDERS_READ_FAILED"
      :openOrdersRead.ok
        ?"OPEN_ORDERS_READ_OK_ACCOUNT_READ_FAILED"
        :"SIGNED_TRADE_READS_NOT_CONFIRMED";
  return {
    status,checkedAt,credentialsPresent,accountRead,openOrdersRead,
    symbolChecked:"PAXGUSDT",securityClass:"TRADE",
    ordersSubmitted:false,cancelAttempted:false,fundsMoved:false,
    balancesPrinted:false,orderDetailsPrinted:false,credentialsPrinted:false
  };
}

export function safeAuditSummary(report) {
  return {
    status:report.status,
    checkedAt:report.checkedAt,
    apiKeyVariablePresent:report.credentialsPresent.apiKey,
    apiSecretVariablePresent:report.credentialsPresent.apiSecret,
    accountRead:report.accountRead,
    openOrdersRead:report.openOrdersRead,
    symbolChecked:report.symbolChecked,
    securityClass:report.securityClass,
    ordersSubmitted:false,cancelAttempted:false,fundsMoved:false,
    balancesPrinted:false,orderDetailsPrinted:false,credentialsPrinted:false,
    note:"Successful signed GETs confirm the read endpoints only; they do not prove POST /order acceptance."
  };
}

async function main() {
  const report=await runTabdealTradeReadAudit();
  console.log(JSON.stringify(safeAuditSummary(report),null,2));
  if(process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "## Tabdeal signed TRADE read audit (read-only)\n\n"+
      "- Status: **"+report.status+"**\n"+
      "- API key variable present: "+(report.credentialsPresent.apiKey?"yes":"no")+"\n"+
      "- API secret variable present: "+(report.credentialsPresent.apiSecret?"yes":"no")+"\n"+
      "- GET /account: "+(report.accountRead.ok?"success":"not confirmed")+"\n"+
      "- Account canTrade flag: "+(report.accountRead.canTrade??"not returned")+"\n"+
      "- GET /openOrders?symbol=PAXGUSDT: "+(report.openOrdersRead.ok?"success":"not confirmed")+"\n"+
      "- Open-order count: "+(report.openOrdersRead.openOrderCount??"not returned")+"\n"+
      "- Authentication class: TRADE\n"+
      "- POST /order, cancellation, withdrawal, transfer: not attempted\n"+
      "- Balances, order details and credentials: not logged\n\n"+
      "> Successful GET requests do not prove that POST /order will be accepted.\n","utf8");
  }
  if(!report.accountRead.ok||!report.openOrdersRead.ok) process.exitCode=1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
