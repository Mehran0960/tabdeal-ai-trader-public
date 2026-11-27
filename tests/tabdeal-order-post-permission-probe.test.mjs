import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {
  TABDEAL_POST_PROBE_SYMBOL,
  TABDEAL_POST_PROBE_CLIENT_ORDER_ID,
  runTabdealPostPermissionProbe,
  safeTabdealPostProbeSummary
} from "../scripts/tabdeal-order-post-permission-probe.mjs";

const credentials = {apiKey: "test-key", apiSecret: "test-secret"};
const timestamp = 1_800_000_000_000;

function exchangeInfoResponse(markets = [{symbol: "BTCUSDT", status: "TRADING", isSpotTradingAllowed: true}]) {
  return new Response(JSON.stringify(markets), {status: 200});
}

test("sends one signed POST only after confirming the impossible symbol is unlisted", async () => {
  const calls = [];
  const report = await runTabdealPostPermissionProbe({
    ...credentials,
    clock: () => timestamp,
    fetchImpl: async (url, options) => {
      calls.push({url: String(url), options});
      if (options.method === "GET") return exchangeInfoResponse();
      const params = new URLSearchParams(options.body);
      const signature = params.get("signature");
      params.delete("signature");
      const expected = createHmac("sha256", credentials.apiSecret)
        .update(params.toString(), "utf8").digest("hex");
      assert.equal(signature, expected);
      assert.equal(params.get("symbol"), TABDEAL_POST_PROBE_SYMBOL);
      assert.equal(params.get("side"), "__INVALID_SIDE__");
      assert.equal(params.get("type"), "__INVALID_TYPE__");
      assert.equal(params.get("quantity"), "0");
      assert.equal(params.get("price"), "0");
      assert.equal(params.get("newClientOrderId"), TABDEAL_POST_PROBE_CLIENT_ORDER_ID);
      assert.equal(options.headers["X-MBX-APIKEY"], credentials.apiKey);
      return new Response(JSON.stringify({code: -1121, msg: "Invalid symbol"}), {status: 400});
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].url, "https://api1.tabdeal.org/api/v1/order");
  assert.equal(report.result, "signed_post_rejected_invalid_payload_permission_not_proven");
  assert.equal(report.postAttempted, true);
  assert.equal(report.permissionConclusive, false);
  assert.equal(report.ordersSubmitted, false);
});

test("aborts before POST if the probe symbol is unexpectedly listed", async () => {
  const calls = [];
  const report = await runTabdealPostPermissionProbe({
    ...credentials,
    clock: () => timestamp,
    fetchImpl: async (_url, options) => {
      calls.push(options.method);
      return exchangeInfoResponse([{symbol: TABDEAL_POST_PROBE_SYMBOL, status: "TRADING", isSpotTradingAllowed: true}]);
    }
  });
  assert.deepEqual(calls, ["GET"]);
  assert.equal(report.result, "aborted_probe_symbol_exists");
  assert.equal(report.postAttempted, false);
});

test("does not make a network request when credentials are absent", async () => {
  let calls = 0;
  const report = await runTabdealPostPermissionProbe({
    apiKey: "", apiSecret: "",
    fetchImpl: async () => { calls++; throw new Error("must not be called"); }
  });
  assert.equal(calls, 0);
  assert.equal(report.result, "credentials_missing");
});

test("classifies explicit POST authentication/permission denial separately", async () => {
  const report = await runTabdealPostPermissionProbe({
    ...credentials,
    clock: () => timestamp,
    fetchImpl: async (_url, options) => options.method === "GET"
      ? exchangeInfoResponse()
      : new Response(JSON.stringify({code: -2015, msg: "Invalid API-key, IP, or permissions"}), {status: 403})
  });
  assert.equal(report.result, "signed_post_explicitly_denied");
  assert.equal(report.httpStatus, 403);
});

test("safe summary never exposes credentials, signatures, request bodies, or response order details", async () => {
  const report = await runTabdealPostPermissionProbe({
    ...credentials,
    clock: () => timestamp,
    fetchImpl: async (_url, options) => options.method === "GET"
      ? exchangeInfoResponse()
      : new Response(JSON.stringify({
        code: -1121, msg: "Invalid symbol",
        orderId: "should-not-be-logged", executedQty: "should-not-be-logged"
      }), {status: 400})
  });
  const summary = safeTabdealPostProbeSummary(report);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(credentials.apiKey), false);
  assert.equal(serialized.includes(credentials.apiSecret), false);
  assert.equal(serialized.includes("should-not-be-logged"), false);
  assert.equal(serialized.includes("signature"), false);
  assert.equal(summary.permissionConclusive, false);
  assert.equal(summary.ordersSubmitted, false);
});

test("does not retry after an uncertain POST network outcome", async () => {
  const methods = [];
  const report = await runTabdealPostPermissionProbe({
    ...credentials,
    clock: () => timestamp,
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      if (options.method === "GET") return exchangeInfoResponse();
      throw new Error("network timeout");
    }
  });
  assert.deepEqual(methods, ["GET", "POST"]);
  assert.equal(report.result, "post_outcome_unknown_network_or_signing_error");
  assert.equal(report.automaticRetry, false);
});
