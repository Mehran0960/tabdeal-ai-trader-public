import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {buildTabdealSignedReadRequest} from "../src/tabdeal-account-read-auth.js";
import {runTabdealTradeReadAudit,safeAuditSummary} from "../scripts/tabdeal-account-readonly-audit.mjs";

const fixed={timestamp:1700000000000};
const fakeId="audit-probe-no-order-20261127";

test("builds signed GET /account with no network side effect",()=>{
  const req=buildTabdealSignedReadRequest({apiKey:"test-key",apiSecret:"test-secret",...fixed});
  const url=new URL(req.url),signature=url.searchParams.get("signature");
  url.searchParams.delete("signature");
  assert.equal(req.method,"GET");
  assert.equal(url.hostname,"api1.tabdeal.org");
  assert.equal(url.pathname,"/r/api/v1/account");
  assert.equal(req.headers["X-MBX-APIKEY"],"test-key");
  assert.equal(signature,createHmac("sha256","test-secret").update(url.searchParams.toString(),"utf8").digest("hex"));
  assert.equal(req.securityClass,"TRADE");
  assert.equal(req.networkRequestSent,false);
});

test("builds signed GET /openOrders only for PAXGUSDT",()=>{
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

test("builds GET /order only for the fixed synthetic ID",()=>{
  const req=buildTabdealSignedReadRequest({
    apiKey:"test-key",apiSecret:"test-secret",path:"/order",
    params:{symbol:"PAXGUSDT",origClientOrderId:fakeId},...fixed
  });
  const url=new URL(req.url);
  assert.equal(req.method,"GET");
  assert.equal(url.pathname,"/r/api/v1/order");
  assert.equal(url.searchParams.get("symbol"),"PAXGUSDT");
  assert.equal(url.searchParams.get("origClientOrderId"),fakeId);
  assert.ok(url.searchParams.get("signature"));
});

test("rejects every write route and every unapproved read parameter",()=>{
  for(const path of ["/cancel","/withdraw","/myTrades","/order/oco","/api/v1/order"]) {
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
  assert.throws(()=>buildTabdealSignedReadRequest({
    apiKey:"key",apiSecret:"secret",path:"/order",
    params:{symbol:"PAXGUSDT",origClientOrderId:"someone-elses-order"},...fixed
  }),/tabdeal_order_lookup_not_allowlisted/);
});

test("checks secret presence before network access",async()=>{
  let calls=0;
  const report=await runTabdealTradeReadAudit({
    apiKey:"",apiSecret:"",fetchImpl:async()=>{calls++;throw new Error("must not call");}
  });
  assert.equal(calls,0);
  assert.equal(report.status,"CREDENTIAL_VARIABLES_MISSING");
});

test("performs only three signed GETs and discards all sensitive response fields",async()=>{
  const calls=[];
  const report=await runTabdealTradeReadAudit({
    apiKey:"test-key",apiSecret:"test-secret",
    fetchImpl:async(url,options)=>{
      calls.push({url:String(url),options});
      const path=new URL(url).pathname;
      if(path.endsWith("/account")) return {
        ok:true,status:200,text:async()=>JSON.stringify({
          accountType:"SPOT",canTrade:true,balances:[{asset:"USDT",free:"98765.43",freeze:"0"}]
        })
      };
      if(path.endsWith("/openOrders")) return {
        ok:true,status:200,text:async()=>JSON.stringify([{
          symbol:"PAXGUSDT",orderId:123,price:"3658.12",origQty:"5",
          executedQty:"0",clientOrderId:"private-order-id"
        }])
      };
      return {
        ok:false,status:404,
        text:async()=>JSON.stringify({code:-2013,msg:"Order does not exist"})
      };
    }
  });
  assert.equal(calls.length,3);
  assert.ok(calls.every(c=>c.options.method==="GET"&&c.options.redirect==="error"));
  assert.deepEqual(calls.map(c=>new URL(c.url).pathname),[
    "/r/api/v1/account","/r/api/v1/openOrders","/r/api/v1/order"
  ]);
  assert.equal(new URL(calls[1].url).searchParams.get("symbol"),"PAXGUSDT");
  assert.equal(new URL(calls[2].url).searchParams.get("origClientOrderId"),fakeId);
  assert.ok(calls.every(c=>c.options.headers["X-MBX-APIKEY"]==="test-key"));
  assert.equal(report.status,"SIGNED_ACCOUNT_OPEN_ORDERS_AND_ORDER_LOOKUP_CONFIRMED");
  assert.equal(report.accountRead.canTrade,true);
  assert.equal(report.openOrdersRead.openOrderCount,1);
  assert.equal(report.orderLookupRead.found,false);
  assert.equal(String(report.orderLookupRead.apiErrorCode),"-2013");
  const safe=JSON.stringify(safeAuditSummary(report));
  for(const privateValue of ["98765.43","3658.12","private-order-id","test-secret","Order does not exist"]) {
    assert.equal(safe.includes(privateValue),false);
  }
  assert.equal(report.balancesExtracted,false);
  assert.equal(report.ordersSubmitted,false);
  assert.equal(report.cancelAttempted,false);
  assert.equal(report.fundsMoved,false);
});

test("does not equate an unclassified HTTP 404 with an order-not-found API response",async()=>{
  let calls=0;
  const report=await runTabdealTradeReadAudit({
    apiKey:"key",apiSecret:"secret",
    fetchImpl:async()=>{
      calls++;
      if(calls===1) return {ok:true,status:200,text:async()=>JSON.stringify({accountType:"SPOT",canTrade:true})};
      if(calls===2) return {ok:true,status:200,text:async()=>JSON.stringify([])};
      return {ok:false,status:404,text:async()=>JSON.stringify({code:1204,msg:"unclassified response"})};
    }
  });
  assert.equal(report.status,"ACCOUNT_AND_OPEN_ORDERS_OK_ORDER_LOOKUP_FAILED");
  assert.equal(report.orderLookupRead.ok,false);
  assert.equal(report.orderLookupRead.result,"unclassified_order_lookup_404");
  assert.equal(report.orderLookupRead.apiErrorCode,1204);
});

test("preserves endpoint failures without logging provider message bodies",async()=>{
  let call=0;
  const report=await runTabdealTradeReadAudit({
    apiKey:"key",apiSecret:"secret",
    fetchImpl:async()=>{
      call++;
      if(call===1) return {ok:true,status:200,text:async()=>JSON.stringify({accountType:"SPOT",canTrade:true})};
      if(call===2) return {ok:true,status:200,text:async()=>JSON.stringify([])};
      return {ok:false,status:401,text:async()=>JSON.stringify({code:-2015,msg:"private provider message"})};
    }
  });
  assert.equal(report.status,"ACCOUNT_AND_OPEN_ORDERS_OK_ORDER_LOOKUP_FAILED");
  assert.equal(report.orderLookupRead.httpStatus,401);
  assert.equal(JSON.stringify(safeAuditSummary(report)).includes("private provider message"),false);
});
