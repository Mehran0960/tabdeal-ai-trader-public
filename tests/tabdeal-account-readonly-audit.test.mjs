import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {buildTabdealSignedReadRequest} from "../src/tabdeal-account-read-auth.js";
import {runTabdealTradeReadAudit,safeAuditSummary} from "../scripts/tabdeal-account-readonly-audit.mjs";

const fixed={timestamp:1700000000000};

test("builds signed GET /account with no network side effect",()=>{
  const req=buildTabdealSignedReadRequest({apiKey:"test-key",apiSecret:"test-secret",...fixed});
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

test("builds signed GET /openOrders only for the fixed PAXGUSDT symbol",()=>{
  const req=buildTabdealSignedReadRequest({
    apiKey:"test-key",apiSecret:"test-secret",path:"/openOrders",
    params:{symbol:"PAXGUSDT"},...fixed
  });
  const url=new URL(req.url);
  assert.equal(req.method,"GET");
  assert.equal(url.pathname,"/r/api/v1/openOrders");
  assert.equal(url.searchParams.get("symbol"),"PAXGUSDT");
  assert.ok(url.searchParams.get("signature"));
});

test("rejects order writes, cancels, unsupported reads and unsafe open-order symbols",()=>{
  for(const path of ["/order","/withdraw","/myTrades","/openOrders/../order"]) {
    assert.throws(()=>buildTabdealSignedReadRequest({
      apiKey:"key",apiSecret:"secret",path,...fixed
    }),/tabdeal_read_path_not_allowlisted/);
  }
  assert.throws(()=>buildTabdealSignedReadRequest({
    apiKey:"key",apiSecret:"secret",path:"/openOrders",params:{symbol:"BTCUSDT"},...fixed
  }),/tabdeal_open_orders_symbol_not_allowlisted/);
  assert.throws(()=>buildTabdealSignedReadRequest({
    apiKey:"key",apiSecret:"secret",path:"/account",params:{limit:1},...fixed
  }),/tabdeal_account_params_not_allowed/);
});

test("checks secret presence before network access",async()=>{
  let calls=0;
  const report=await runTabdealTradeReadAudit({
    apiKey:"",apiSecret:"",
    fetchImpl:async()=>{calls++;throw new Error("must not call");}
  });
  assert.equal(calls,0);
  assert.equal(report.status,"CREDENTIAL_VARIABLES_MISSING");
});

test("performs only account and PAXG open-order GETs and discards sensitive response fields",async()=>{
  const calls=[];
  const report=await runTabdealTradeReadAudit({
    apiKey:"test-key",apiSecret:"test-secret",
    fetchImpl:async(url,options)=>{
      calls.push({url:String(url),options});
      const path=new URL(url).pathname;
      const payload=path.endsWith("/account")
        ? {accountType:"SPOT",canTrade:true,balances:[{asset:"USDT",free:"98765.43",freeze:"0"}]}
        : [{symbol:"PAXGUSDT",orderId:123,price:"3658.12",origQty:"5",executedQty:"0",clientOrderId:"private-id"}];
      return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
    }
  });
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.options.method==="GET"&&c.options.redirect==="error"));
  assert.equal(new URL(calls[0].url).pathname,"/r/api/v1/account");
  const openUrl=new URL(calls[1].url);
  assert.equal(openUrl.pathname,"/r/api/v1/openOrders");
  assert.equal(openUrl.searchParams.get("symbol"),"PAXGUSDT");
  assert.ok(calls.every(c=>c.options.headers["X-MBX-APIKEY"]==="test-key"));
  assert.equal(report.status,"SIGNED_ACCOUNT_AND_OPEN_ORDERS_CONFIRMED");
  assert.equal(report.accountRead.canTrade,true);
  assert.equal(report.openOrdersRead.openOrderCount,1);
  assert.equal("balances" in report.accountRead,false);
  assert.equal("orders" in report.openOrdersRead,false);
  const safe=JSON.stringify(safeAuditSummary(report));
  for(const privateValue of ["98765.43","3658.12","private-id","test-secret"]) assert.equal(safe.includes(privateValue),false);
  assert.equal(report.ordersSubmitted,false);
  assert.equal(report.cancelAttempted,false);
  assert.equal(report.fundsMoved,false);
});

test("preserves endpoint failure without logging provider message bodies",async()=>{
  let call=0;
  const report=await runTabdealTradeReadAudit({
    apiKey:"key",apiSecret:"secret",
    fetchImpl:async()=>{
      call++;
      return call===1
        ? {ok:true,status:200,text:async()=>JSON.stringify({accountType:"SPOT",canTrade:true})}
        : {ok:false,status:401,text:async()=>JSON.stringify({code:-2015,msg:"private provider message"})};
    }
  });
  assert.equal(report.status,"ACCOUNT_READ_OK_OPEN_ORDERS_READ_FAILED");
  assert.equal(report.openOrdersRead.httpStatus,401);
  assert.equal(JSON.stringify(safeAuditSummary(report)).includes("private provider message"),false);
});
