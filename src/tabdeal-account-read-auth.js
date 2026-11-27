import {createHmac} from "node:crypto";

const BASE = "https://api1.tabdeal.org/r/api/v1";
const ALLOWED_OPEN_ORDER_SYMBOL = "PAXGUSDT";
const AUDIT_CLIENT_ORDER_ID = "audit-probe-no-order-20261127";
const READ_PATHS = new Set(["/account", "/openOrders", "/order"]);

/** Build signed GET requests for fixed read-only endpoints and a single synthetic order ID. */
export function buildTabdealSignedReadRequest({
  apiKey,apiSecret,path="/account",params={},timestamp=Date.now()
}={}) {
  if(typeof apiKey!=="string"||!apiKey.trim()) throw new Error("tabdeal_api_key_missing");
  if(typeof apiSecret!=="string"||!apiSecret.trim()) throw new Error("tabdeal_api_secret_missing");
  if(!READ_PATHS.has(path)) throw new Error("tabdeal_read_path_not_allowlisted");
  if(!params||typeof params!=="object"||Array.isArray(params)) throw new Error("tabdeal_read_params_invalid");
  if(!Number.isSafeInteger(timestamp)||timestamp<=0) throw new Error("tabdeal_timestamp_invalid");

  let safeParams;
  if(path==="/account") {
    if(Object.keys(params).length!==0) throw new Error("tabdeal_account_params_not_allowed");
    safeParams={};
  } else if(path==="/openOrders") {
    if(Object.keys(params).length!==1||params.symbol!==ALLOWED_OPEN_ORDER_SYMBOL) {
      throw new Error("tabdeal_open_orders_symbol_not_allowlisted");
    }
    safeParams={symbol:ALLOWED_OPEN_ORDER_SYMBOL};
  } else {
    if(Object.keys(params).length!==2||
       params.symbol!==ALLOWED_OPEN_ORDER_SYMBOL||
       params.origClientOrderId!==AUDIT_CLIENT_ORDER_ID) {
      throw new Error("tabdeal_order_lookup_not_allowlisted");
    }
    safeParams={symbol:ALLOWED_OPEN_ORDER_SYMBOL,origClientOrderId:AUDIT_CLIENT_ORDER_ID};
  }

  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(safeParams)) query.append(key,String(value));
  query.append("timestamp",String(timestamp));
  query.append("recvWindow","5000");
  const unsigned=query.toString();
  const signature=createHmac("sha256",apiSecret).update(unsigned,"utf8").digest("hex");
  const url=new URL(BASE+path);
  url.search=unsigned+"&signature="+signature;
  return Object.freeze({
    method:"GET",url:url.toString(),
    headers:Object.freeze({accept:"application/json","X-MBX-APIKEY":apiKey}),
    securityClass:"TRADE",networkRequestSent:false,endpoint:path
  });
}
