import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPaperEligibleCandidates,
  confirmCandidatesAcrossScans,
  qualifiesForMultiAssetPaper
} from "./paper-candidate-policy.js";

const candidate={
  symbol:"DOGEIRT",quoteAsset:"IRT",quotePriceUnit:"RIAL",resolution:"240",timeframe:"4h",
  strategy:"donchian-breakout",baseReturnPct:4.6,moderateStressReturnPct:3.4,severeStressReturnPct:1.7,
  baseBenchmarkOutperformancePct:64,moderateBenchmarkOutperformancePct:68,severeBenchmarkOutperformancePct:73,
  worstWindowDrawdownPct:0.62,minimumWindowCount:89,minimumTradeCount:45,stressAdjustedReturnPct:1.7,
  baseOutperformancePValue:0.005,benjaminiHochbergQValue:0.018,multipleTestingHypothesisCount:63
};
const audit={symbol:"DOGEIRT",accepted:true,status:"udf_toman_likely",sourcePriceUnit:"TOMAN",
  canonicalPriceUnit:"RIAL",multiplier:10,bookAgeMs:1000,candleAgeSeconds:30,ratioSpreadPct:0.2};
const report={schemaVersion:1,researchQualifiedCandidates:[candidate],pairUnitAudit:{results:[audit]},
  multipleTesting:{hypothesisCount:63},safety:{usesPrivateCredentials:false,writesD1:false,
    placesOrders:false,liveTradingEnabled:false,exchangeOrdersPlaced:0}};
const row=(id,runId)=>({id,run_id:runId,symbol:"DOGEIRT",base_asset:"DOGE",quote_asset:"IRT",
  resolution:"240",timeframe:"4h",strategy:"donchian-breakout",source_price_unit:"TOMAN",
  conversion_multiplier:10,stress_adjusted_return_pct:1.7,q_value:0.018,generated_at:"2026-11-22T00:00:00Z"});
test("accepts a strict FDR and economic gate candidate with a matching pair-specific unit audit",()=>{
  assert.equal(qualifiesForMultiAssetPaper(candidate,audit),true);
  const result=buildPaperEligibleCandidates(report);
  assert.equal(result.length,1);
  assert.equal(result[0].symbol,"DOGEIRT");
  assert.equal(result[0].conversionMultiplier,10);
});
test("rejects weak severe return, too few OOS windows/trades, drawdown and invalid quote units",()=>{
  assert.equal(qualifiesForMultiAssetPaper({...candidate,severeStressReturnPct:0.99},audit),false);
  assert.equal(qualifiesForMultiAssetPaper({...candidate,minimumWindowCount:59},audit),false);
  assert.equal(qualifiesForMultiAssetPaper({...candidate,minimumTradeCount:19},audit),false);
  assert.equal(qualifiesForMultiAssetPaper({...candidate,worstWindowDrawdownPct:1.01},audit),false);
  assert.equal(qualifiesForMultiAssetPaper({...candidate,benjaminiHochbergQValue:0.051},audit),false);
  assert.equal(qualifiesForMultiAssetPaper({...candidate,quoteAsset:"USDT"},audit),false);
});
test("confirms only the same candidate present in two time-separated latest successful scans",()=>{
  const runs=[{id:12,generated_at:"2026-11-22T00:00:00Z"},{id:11,generated_at:"2026-11-21T18:00:00Z"}];
  const result=confirmCandidatesAcrossScans({runs,evidence:[row(1,11),row(2,12)],nowMs:Date.parse("2026-11-22T00:01:00Z")});
  assert.equal(result.length,1);
  assert.equal(result[0].confirmedScans,2);
  assert.equal(confirmCandidatesAcrossScans({runs,evidence:[row(1,11)],nowMs:Date.parse("2026-11-22T00:01:00Z")}).length,0);
});
test("rejects scans too close together or an old latest scan",()=>{
  const close=[{id:12,generated_at:"2026-11-22T00:00:00Z"},{id:11,generated_at:"2026-11-21T23:00:00Z"}];
  assert.equal(confirmCandidatesAcrossScans({runs:close,evidence:[row(1,11),row(2,12)],nowMs:Date.parse("2026-11-22T00:01:00Z")}).length,0);
  assert.equal(confirmCandidatesAcrossScans({runs:[{id:12,generated_at:"2026-11-21T00:00:00Z"},{id:11,generated_at:"2026-11-20T18:00:00Z"}],evidence:[row(1,11),row(2,12)],nowMs:Date.parse("2026-11-22T00:01:00Z")}).length,0);
});

test("accepts the actual scout nested unit-audit result shape",()=>{
 const nested={symbol:"DOGEIRT",accepted:true,sourcePriceUnit:"TOMAN",
  canonicalPriceUnit:"RIAL",multiplier:10,
  result:{status:"udf_toman_likely",udfUnit:"TOMAN",livePriceUnit:"RIAL",
   multiplierToLiveUnit:10,bookAgeMs:950,candleAgeSeconds:45,ratioSpreadPct:0.21}};
 const reportNested={...report,pairUnitAudit:{results:[nested]}};
 assert.equal(buildPaperEligibleCandidates(reportNested).length,1);
 assert.equal(buildPaperEligibleCandidates(reportNested)[0].unitAuditStatus,"udf_toman_likely");
});
