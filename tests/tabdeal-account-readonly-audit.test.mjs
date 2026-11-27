import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {buildTabdealAccountReadRequest} from "../src/tabdeal-account-read-auth.js";
import {runTabdealAccountReadAudit,safeAuditSummary} from "../scripts/tabdeal-account-readonly-audit.mjs";

test("constructs a signed GET /account request without sending network traffic",()=>{
  const req=buildTabdealAccountReadRequest({
    apiKey:"test-key",apiSecret:"test-secret",timestamp:1700000000000
  });
  const url=new URL(req.url);
  const signature=url.searchParams.get("signature");
  url.searchParams.delete("signature");
  assert.equal(req.method,"GET");
  assert.equal(url.hostname,"api1.tabdeal.org");
  assert.equal(url.pathname,"/r/api/v1/account");
  assert.equal(req.headers["X-MBX-APIKEY"],"test-key");
  assert.equal(signature,createHmac("sha256","test-secret").update(url.searchParams.toString(),"utf8").digest("hex"));
  assert.equal(req.securityClass,"TRADE");
  assert.equal(req.networkRequestSent,false);
});

test("rejects every non-account endpoint",()=>{
  for(const path of ["/order","/openOrders","/withdraw","/account/../order"]) {
    assert.throws(()=>buildTabdealAccountReadRequest({
      apiKey:"key",apiSecret:"secret",path,timestamp:1700000000000
    }),/tabdeal_read_path_not_allowlisted/);
  }
});

test("checks credentials before any network call and emits only redacted metadata",async()=>{
  let called=false;
  const report=await runTabdealAccountReadAudit({
    apiKey:"",apiSecret:"",
    fetchImpl:async()=>{called=true;throw new Error("must not call");}
  });
  assert.equal(called,false);
  assert.equal(report.status,"CREDENTIAL_VARIABLES_MISSING");
  assert.equal(JSON.stringify(safeAuditSummary(report)).includes("secret"),false);
});

test("reads account but discards every balance field and never writes",async()=>{
  const calls=[];
  const report=await runTabdealAccountReadAudit({
    apiKey:"test-key",apiSecret:"test-secret",
    fetchImpl:async(url,options)=>{
      calls.push({url:String(url),options});
      return {
        ok:true,status:200,
        text:async()=>JSON.stringify({
          accountType:"SPOT",canTrade:true,
          balances:[{asset:"USDT",free:"123456.78",freeze:"0"}]
        })
      };
    }
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.method,"GET");
  assert.equal(calls[0].options.redirect,"error");
  assert.equal(new URL(calls[0].url).pathname,"/r/api/v1/account");
  assert.equal(report.status,"SIGNED_TRADE_READ_CONFIRMED");
  assert.equal(report.accountRead.canTrade,true);
  assert.equal("balances" in report.accountRead,false);
  const safe=JSON.stringify(safeAuditSummary(report));
  assert.equal(safe.includes("123456.78"),false);
  assert.equal(safe.includes("test-secret"),false);
  assert.equal(report.ordersSubmitted,false);
  assert.equal(report.cancelAttempted,false);
  assert.equal(report.fundsMoved,false);
});
