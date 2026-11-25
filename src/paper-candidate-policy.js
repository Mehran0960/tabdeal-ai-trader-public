const finite = value => Number.isFinite(Number(value));
const keyOf = row => [String(row.symbol||"").toUpperCase(),String(row.resolution||""),String(row.strategy||"")].join("|");
const baseOf = symbol => {
  const value=String(symbol||"").toUpperCase();
  return value.endsWith("USDT")?value.slice(0,-4):value.endsWith("IRT")?value.slice(0,-3):"";
};

export const MULTI_ASSET_PAPER_POLICY = Object.freeze({
  timeframe: "4h",
  resolution: "240",
  allowedStrategies: Object.freeze(["ema-trend","donchian-breakout"]),
  minimumWindows: 60,
  minimumTrades: 20,
  minimumSevereStressReturnPct: 1,
  minimumBenchmarkOutperformancePct: 60,
  maximumWorstWindowDrawdownPct: 1,
  maximumFdrQValue: 0.05,
  minimumHypothesisFamilySize: 30,
  minimumScanSeparationMs: 4*60*60*1000,
  maximumLatestScanAgeMs: 12*60*60*1000,
  maxSymbolsPerQuote: 2,
  maxSymbolsTotal: 4
});

export function paperCandidateUnitIsValid(candidate, audit) {
  if (!candidate || !audit || audit.accepted !== true) return false;
  const symbol=String(candidate.symbol||"").toUpperCase();
  const quote=String(candidate.quoteAsset||"").toUpperCase();
  const detail=audit.result&&typeof audit.result==="object"?audit.result:audit;
  const source=String(audit.sourcePriceUnit||detail.udfUnit||"").toUpperCase();
  const canonical=String(audit.canonicalPriceUnit||detail.livePriceUnit||"").toUpperCase();
  const multiplier=Number(audit.multiplier??detail.multiplierToLiveUnit);
  const status=String(audit.status||detail.status||"");
  const bookAge=Number(audit.bookAgeMs??detail.bookAgeMs);
  const candleAge=Number(audit.candleAgeSeconds??detail.candleAgeSeconds);
  const ratioSpread=Number(audit.ratioSpreadPct??detail.ratioSpreadPct);
  if (![bookAge,candleAge,ratioSpread].every(Number.isFinite) ||
      bookAge<0 || bookAge>30_000 || candleAge<0 || candleAge>1_800 ||
      ratioSpread<0 || ratioSpread>1) return false;
  if (quote==="IRT" && symbol.endsWith("IRT")) {
    return String(candidate.quotePriceUnit||"").toUpperCase()==="RIAL" &&
      canonical==="RIAL" &&
      ((source==="TOMAN" && multiplier===10 && status==="udf_toman_likely") ||
       (source==="RIAL" && multiplier===1 && status==="udf_rial_likely"));
  }
  if (quote==="USDT" && symbol.endsWith("USDT")) {
    return String(candidate.quotePriceUnit||"").toUpperCase()==="USDT" &&
      source==="USDT" && canonical==="USDT" && multiplier===1 && status==="udf_usdt_likely";
  }
  return false;
}

export function qualifiesForMultiAssetPaper(candidate, audit) {
  if (!paperCandidateUnitIsValid(candidate,audit)) return false;
  const policy=MULTI_ASSET_PAPER_POLICY;
  const symbol=String(candidate.symbol||"").toUpperCase();
  const resolution=String(candidate.resolution||"");
  const strategy=String(candidate.strategy||"");
  if (!baseOf(symbol) || resolution!==policy.resolution ||
      String(candidate.timeframe||"")!==policy.timeframe ||
      !policy.allowedStrategies.includes(strategy)) return false;
  const values=[
    candidate.baseReturnPct,candidate.moderateStressReturnPct,candidate.severeStressReturnPct,
    candidate.baseBenchmarkOutperformancePct,candidate.moderateBenchmarkOutperformancePct,
    candidate.severeBenchmarkOutperformancePct,candidate.worstWindowDrawdownPct,
    candidate.minimumWindowCount,candidate.minimumTradeCount,candidate.benjaminiHochbergQValue,
    candidate.multipleTestingHypothesisCount
  ];
  if (!values.every(finite)) return false;
  return Number(candidate.baseReturnPct)>0 &&
    Number(candidate.moderateStressReturnPct)>0 &&
    Number(candidate.severeStressReturnPct)>=policy.minimumSevereStressReturnPct &&
    Number(candidate.baseBenchmarkOutperformancePct)>=policy.minimumBenchmarkOutperformancePct &&
    Number(candidate.moderateBenchmarkOutperformancePct)>=policy.minimumBenchmarkOutperformancePct &&
    Number(candidate.severeBenchmarkOutperformancePct)>=policy.minimumBenchmarkOutperformancePct &&
    Number(candidate.worstWindowDrawdownPct)>=0 &&
    Number(candidate.worstWindowDrawdownPct)<=policy.maximumWorstWindowDrawdownPct &&
    Number(candidate.minimumWindowCount)>=policy.minimumWindows &&
    Number(candidate.minimumTradeCount)>=policy.minimumTrades &&
    Number(candidate.benjaminiHochbergQValue)>=0 &&
    Number(candidate.benjaminiHochbergQValue)<=policy.maximumFdrQValue &&
    Number(candidate.multipleTestingHypothesisCount)>=policy.minimumHypothesisFamilySize;
}

export function buildPaperEligibleCandidates(report) {
  if (!report || report.schemaVersion!==1 ||
      !Array.isArray(report.researchQualifiedCandidates) ||
      !Array.isArray(report.pairUnitAudit?.results) ||
      !report.multipleTesting || !report.safety) {
    throw new Error("paper_candidate_scout_report_invalid");
  }
  if (report.safety.usesPrivateCredentials!==false ||
      report.safety.writesD1!==false ||
      report.safety.placesOrders!==false ||
      report.safety.liveTradingEnabled!==false ||
      Number(report.safety.exchangeOrdersPlaced)!==0) {
    throw new Error("paper_candidate_scout_safety_contract_invalid");
  }
  const audits=new Map(report.pairUnitAudit.results.map(row=>[String(row.symbol||"").toUpperCase(),row]));
  const candidates=report.researchQualifiedCandidates
    .filter(candidate=>qualifiesForMultiAssetPaper(candidate,audits.get(String(candidate.symbol||"").toUpperCase())))
    .map(candidate=>{
      const audit=audits.get(String(candidate.symbol).toUpperCase());
      const detail=audit?.result&&typeof audit.result==="object"?audit.result:(audit||{});
      return {
        symbol:String(candidate.symbol).toUpperCase(),
        baseAsset:baseOf(candidate.symbol),
        quoteAsset:String(candidate.quoteAsset).toUpperCase(),
        quotePriceUnit:String(candidate.quotePriceUnit||"").toUpperCase(),
        resolution:String(candidate.resolution),
        timeframe:String(candidate.timeframe),
        strategy:String(candidate.strategy),
        baseReturnPct:Number(candidate.baseReturnPct),
        moderateStressReturnPct:Number(candidate.moderateStressReturnPct),
        severeStressReturnPct:Number(candidate.severeStressReturnPct),
        baseBenchmarkOutperformancePct:Number(candidate.baseBenchmarkOutperformancePct),
        moderateBenchmarkOutperformancePct:Number(candidate.moderateBenchmarkOutperformancePct),
        severeBenchmarkOutperformancePct:Number(candidate.severeBenchmarkOutperformancePct),
        worstWindowDrawdownPct:Number(candidate.worstWindowDrawdownPct),
        minimumWindowCount:Number(candidate.minimumWindowCount),
        minimumTradeCount:Number(candidate.minimumTradeCount),
        stressAdjustedReturnPct:Number(candidate.stressAdjustedReturnPct),
        baseOutperformancePValue:Number(candidate.baseOutperformancePValue),
        benjaminiHochbergQValue:Number(candidate.benjaminiHochbergQValue),
        multipleTestingHypothesisCount:Number(candidate.multipleTestingHypothesisCount),
        sourcePriceUnit:String(audit.sourcePriceUnit).toUpperCase(),
        canonicalPriceUnit:String(audit.canonicalPriceUnit).toUpperCase(),
        conversionMultiplier:Number(audit.multiplier),
        unitAuditStatus:String(audit.status||detail.status),
        unitAuditBookAgeMs:Number(audit.bookAgeMs??detail.bookAgeMs),
        unitAuditCandleAgeSeconds:Number(audit.candleAgeSeconds??detail.candleAgeSeconds),
        unitAuditRatioSpreadPct:Number(audit.ratioSpreadPct??detail.ratioSpreadPct)
      };
    });
  // A base asset is allowed in only one quote book in a single scan.
  candidates.sort((a,b)=>b.stressAdjustedReturnPct-a.stressAdjustedReturnPct ||
    a.benjaminiHochbergQValue-b.benjaminiHochbergQValue || a.symbol.localeCompare(b.symbol));
  const selected=[],bases=new Set(),quoteCounts={IRT:0,USDT:0};
  for (const candidate of candidates) {
    if (selected.length>=MULTI_ASSET_PAPER_POLICY.maxSymbolsTotal ||
        bases.has(candidate.baseAsset) ||
        quoteCounts[candidate.quoteAsset]>=MULTI_ASSET_PAPER_POLICY.maxSymbolsPerQuote) continue;
    selected.push(candidate);
    bases.add(candidate.baseAsset);
    quoteCounts[candidate.quoteAsset]++;
  }
  return selected;
}

export function confirmCandidatesAcrossScans({runs=[],evidence=[],nowMs=Date.now()}={}) {
  if (!Array.isArray(runs) || runs.length<2 || !Array.isArray(evidence)) return [];
  const ordered=[...runs].sort((a,b)=>Number(b.id)-Number(a.id)).slice(0,2);
  const [latest,previous]=ordered;
  const latestTime=Date.parse(String(latest.generated_at||""));
  const previousTime=Date.parse(String(previous.generated_at||""));
  const policy=MULTI_ASSET_PAPER_POLICY;
  if (!Number.isFinite(latestTime)||!Number.isFinite(previousTime)||
      latestTime>nowMs+60_000||nowMs-latestTime>policy.maximumLatestScanAgeMs||
      latestTime-previousTime<policy.minimumScanSeparationMs) return [];
  const latestId=Number(latest.id),previousId=Number(previous.id);
  if (!Number.isSafeInteger(latestId)||!Number.isSafeInteger(previousId)||latestId===previousId) return [];
  const groups=new Map();
  for (const row of evidence) {
    const id=Number(row.run_id);
    if (id!==latestId && id!==previousId) continue;
    const key=keyOf(row);
    const items=groups.get(key)||new Map();
    items.set(id,row);
    groups.set(key,items);
  }
  const confirmed=[];
  for (const [key,items] of groups) {
    if (items.size!==2 || !items.has(latestId) || !items.has(previousId)) continue;
    const row=items.get(latestId);
    const prior=items.get(previousId);
    if (!row || !prior ||
        String(row.symbol)!==String(prior.symbol) ||
        String(row.quote_asset)!==String(prior.quote_asset) ||
        String(row.source_price_unit)!==String(prior.source_price_unit) ||
        Number(row.conversion_multiplier)!==Number(prior.conversion_multiplier)) continue;
    confirmed.push({
      ...row,
      paperType:"multi_asset",
      generated_at:latest.generated_at,
      latestScanRunId:latestId,
      previousScanRunId:previousId,
      confirmedScans:2
    });
  }
  const ranked=confirmed.sort((a,b)=>Number(b.stress_adjusted_return_pct)-Number(a.stress_adjusted_return_pct) ||
    Number(a.q_value)-Number(b.q_value) || String(a.symbol).localeCompare(String(b.symbol)));
  const out=[],bases=new Set(),counts={IRT:0,USDT:0};
  for(const row of ranked){
    const base=String(row.base_asset||baseOf(row.symbol));
    const quote=String(row.quote_asset||"").toUpperCase();
    if(out.length>=policy.maxSymbolsTotal || bases.has(base) || counts[quote]>=policy.maxSymbolsPerQuote) continue;
    out.push(row);bases.add(base);counts[quote]++;
  }
  return out;
}
