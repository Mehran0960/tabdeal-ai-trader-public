#!/usr/bin/env node
import {appendFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {buildTabdealAccountReadRequest} from "../src/tabdeal-account-read-auth.js";

function safeCode(data) {
  return data && typeof data === "object" &&
    (typeof data.code === "number" || typeof data.code === "string")
    ? data.code : null;
}

export async function runTabdealAccountReadAudit({
  apiKey=process.env.TABDEAL_API_KEY,
  apiSecret=process.env.TABDEAL_API_SECRET,
  fetchImpl=fetch
}={}) {
  const credentialsPresent = {
    apiKey:typeof apiKey === "string" && apiKey.trim() !== "",
    apiSecret:typeof apiSecret === "string" && apiSecret.trim() !== ""
  };
  const checkedAt = new Date().toISOString();
  if (!credentialsPresent.apiKey || !credentialsPresent.apiSecret) {
    return {
      status:"CREDENTIAL_VARIABLES_MISSING",checkedAt,credentialsPresent,
      accountRead:{ok:false,httpStatus:null,result:"not_attempted"},
      securityClass:"TRADE",ordersSubmitted:false,cancelAttempted:false,fundsMoved:false
    };
  }

  let accountRead;
  try {
    const request=buildTabdealAccountReadRequest({apiKey,apiSecret});
    const response=await fetchImpl(request.url,{
      method:"GET",headers:request.headers,redirect:"error",
      signal:AbortSignal.timeout(15000)
    });
    const body=await response.text();
    if(body.length>1_000_000) {
      accountRead={ok:false,httpStatus:response.status,result:"response_too_large"};
    } else {
      let data;
      try { data=JSON.parse(body); }
      catch { data=null; }
      if(!response.ok) {
        accountRead={
          ok:false,httpStatus:response.status,
          apiErrorCode:safeCode(data),result:"http_error"
        };
      } else if(!data || typeof data!=="object" || Array.isArray(data)) {
        accountRead={ok:false,httpStatus:response.status,result:"unexpected_schema"};
      } else {
        accountRead={
          ok:true,httpStatus:response.status,
          accountType:typeof data.accountType==="string"?data.accountType:null,
          canTrade:typeof data.canTrade==="boolean"?data.canTrade:null
        };
      }
    }
  } catch {
    accountRead={ok:false,httpStatus:null,result:"network_or_signing_error"};
  }

  return {
    status:accountRead.ok?"SIGNED_TRADE_READ_CONFIRMED":"SIGNED_TRADE_READ_NOT_CONFIRMED",
    checkedAt,credentialsPresent,accountRead,securityClass:"TRADE",
    ordersSubmitted:false,cancelAttempted:false,fundsMoved:false,
    balancesPrinted:false,credentialsPrinted:false
  };
}

export function safeAuditSummary(report) {
  return {
    status:report.status,
    checkedAt:report.checkedAt,
    apiKeyVariablePresent:report.credentialsPresent.apiKey,
    apiSecretVariablePresent:report.credentialsPresent.apiSecret,
    accountRead:report.accountRead,
    securityClass:report.securityClass,
    ordersSubmitted:false,
    cancelAttempted:false,
    fundsMoved:false,
    balancesPrinted:false,
    credentialsPrinted:false,
    note:"A successful GET in the TRADE security class confirms signed read access, not acceptance of POST /order."
  };
}

async function main() {
  const report=await runTabdealAccountReadAudit();
  console.log(JSON.stringify(safeAuditSummary(report),null,2));
  if(process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "## Tabdeal read-only API capability audit\n\n"+
      "- Status: **"+report.status+"**\n"+
      "- API key variable present: "+(report.credentialsPresent.apiKey?"yes":"no")+"\n"+
      "- API secret variable present: "+(report.credentialsPresent.apiSecret?"yes":"no")+"\n"+
      "- Signed GET /account: "+(report.accountRead.ok?"success":"not confirmed")+"\n"+
      "- Account canTrade flag: "+(report.accountRead.canTrade??"not returned")+"\n"+
      "- Auth security class: TRADE\n"+
      "- POST /order, cancel, withdrawal, transfer: not attempted\n"+
      "- Balances and credentials: not logged\n\n"+
      "> This verifies signed read access only; it does not prove that a POST order will be accepted.\n","utf8");
  }
  if(!report.accountRead.ok) process.exitCode=1;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
