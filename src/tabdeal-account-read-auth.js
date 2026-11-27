import {createHmac} from "node:crypto";

const BASE = "https://api1.tabdeal.org/r/api/v1";
const ALLOWED_PATHS = new Set(["/account"]);

/** Build an authenticated GET request only; this helper cannot write to Tabdeal. */
export function buildTabdealAccountReadRequest({apiKey, apiSecret, path="/account", timestamp=Date.now()}={}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("tabdeal_api_key_missing");
  if (typeof apiSecret !== "string" || !apiSecret.trim()) throw new Error("tabdeal_api_secret_missing");
  if (!ALLOWED_PATHS.has(path)) throw new Error("tabdeal_read_path_not_allowlisted");
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("tabdeal_timestamp_invalid");

  const query = new URLSearchParams({timestamp:String(timestamp)});
  const unsigned = query.toString();
  const signature = createHmac("sha256", apiSecret).update(unsigned, "utf8").digest("hex");
  const url = new URL(BASE + path);
  url.search = unsigned + "&signature=" + signature;

  return Object.freeze({
    method:"GET",
    url:url.toString(),
    headers:Object.freeze({accept:"application/json","X-MBX-APIKEY":apiKey}),
    securityClass:"TRADE",
    networkRequestSent:false
  });
}
