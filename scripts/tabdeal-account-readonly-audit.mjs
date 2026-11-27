#!/usr/bin/env node
import {appendFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {buildTabdealSignedReadRequest} from "../src/tabdeal-account-read-auth.js";

const AUDIT_CLIENT_ORDER_ID="audit-probe-no-order-20261127";

function safeCode(data) {
  return data&&typeof data==="object"&&
    (typeof data.code==="number"||typeof data.code==="string")?data.code:null;
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
    try {data=JSON.parse(body);} catch {data=null;}
    if(!response.ok) {
      const code=safeCode(data);
      // Only the exchange's structured "order does not exist" code proves
      // the synthetic-ID lookup reached the expected order-not-found result.
      if(path==="/order"&&String(code)==="-2013") {
        return {ok:true,httpStatus:response.status,apiErrorCode:code,found:false,
          result:"synthetic_order_not_found_as_expected"};
      }
      return {
        ok:false,httpStatus:response.status,apiErrorCode:code,
        result:path==="/order"&&response.status===404
          ?"unclassified_order_lookup_404":"http_error"
      };
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
    if(path==="/openOrders") {
      const orders=Array.isArray(data)?data:
        data&&typeof data==="object"&&Array.isArray(data.orders)?data.orders:null;
      if(!orders) return {ok:false,httpStatus:response.status,result:"unexpected_open_orders_schema"};
      return {ok:true,httpStatus:response.status,openOrderCount:orders.length};
    }
    if(!data||typeof data!=="object"||Array.isArray(data)) {
      return {ok:false,httpStatus:response.status,result:"unexpected_order_lookup_schema"};
    }
    const hasOrderIdentity=data.orderId!==undefined&&data.orderId!==null;
    return {ok:true,httpStatus:response.status,found:hasOrderIdentity,
      result:hasOrderIdentity?"synthetic_id_resolved":"order_identity_missing"};
  } catch {
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
    const noCall={ok:false,httpStatus:null,result:"not_attempted"};
    return {
      status:"CREDENTIAL_VARIABLES_MISSING",checkedAt,credentialsPresent,
      accountRead:noCall,openOrdersRead:noCall,orderLookupRead:noCall,
      symbolChecked:"PAXGUSDT",securityClass:"TRADE",
      ordersSubmitted:false,cancelAttempted:false,fundsMoved:false
    };
  }

  const accountRead=await readOnlyGet({
    apiKey,apiSecret,path:"/account",params:{},fetchImpl
  });
  const openOrdersRead=await readOnlyGet({
    apiKey,apiSecret,path:"/openOrders",params:{symbol:"PAXGUSDT"},fetchImpl
  });
  const orderLookupRead=await readOnlyGet({
    apiKey,apiSecret,path:"/order",
    params:{symbol:"PAXGUSDT",origClientOrderId:AUDIT_CLIENT_ORDER_ID},fetchImpl
  });
  const allOk=accountRead.ok&&openOrdersRead.ok&&orderLookupRead.ok;
  const status=allOk?"SIGNED_ACCOUNT_OPEN_ORDERS_AND_ORDER_LOOKUP_CONFIRMED"
    :accountRead.ok&&openOrdersRead.ok?"ACCOUNT_AND_OPEN_ORDERS_OK_ORDER_LOOKUP_FAILED"
    :accountRead.ok?"ACCOUNT_READ_OK_OTHER_ORDER_READS_NOT_CONFIRMED"
    :"SIGNED_TRADE_READS_NOT_CONFIRMED";
  return {
    status,checkedAt,credentialsPresent,accountRead,openOrdersRead,orderLookupRead,
    symbolChecked:"PAXGUSDT",orderLookupUsedSyntheticClientOrderId:true,
    securityClass:"TRADE",ordersSubmitted:false,cancelAttempted:false,fundsMoved:false,
    balancesExtracted:false,balancesLogged:false,orderDetailsLogged:false,credentialsLogged:false
  };
}

export function safeAuditSummary(report) {
  return {
    status:report.status,checkedAt:report.checkedAt,
    apiKeyVariablePresent:report.credentialsPresent.apiKey,
    apiSecretVariablePresent:report.credentialsPresent.apiSecret,
    accountRead:report.accountRead,openOrdersRead:report.openOrdersRead,
    orderLookupRead:report.orderLookupRead,symbolChecked:report.symbolChecked,
    orderLookupUsedSyntheticClientOrderId:report.orderLookupUsedSyntheticClientOrderId,
    securityClass:report.securityClass,
    ordersSubmitted:false,cancelAttempted:false,fundsMoved:false,
    balancesExtracted:false,balancesLogged:false,
    orderDetailsLogged:false,credentialsLogged:false,
    note:"Only signed GET requests were sent. The account response can contain balance fields; this audit extracts only accountType/canTrade and does not persist or log balance values. GET access does not prove POST /order permission."
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
      "- GET /order with synthetic client ID: "+(report.orderLookupRead.ok?"success":"not confirmed")+"\n"+
      "- Synthetic order found: "+(report.orderLookupRead.found??"not returned")+"\n"+
      "- Order lookup API code: "+(report.orderLookupRead.apiErrorCode??"not returned")+"\n"+
      "- Authentication class: TRADE\n"+
      "- POST /order, cancellation, withdrawal, transfer: not attempted\n"+
      "- Balance values, order details and credentials: not logged\n\n"+
      "> Successful GET requests do not prove that POST /order will be accepted.\n","utf8");
  }
  if(!report.accountRead.ok||!report.openOrdersRead.ok||!report.orderLookupRead.ok) process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
