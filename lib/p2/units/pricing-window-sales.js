import { assertP1, invalid } from '../validation.js';
import { validDate } from '../../longitudinal/common.js';
const days=(from,to)=>(Date.parse(to)-Date.parse(from))/86400000+1;

// Pure transformation of P1 authorities. No physical source access or recognition.
export function executePricingWindowSales({evidence={},parameters={}}={}) {
  const {pricing,sales}=evidence;
  assertP1(pricing,'pricing');assertP1(sales,'sales');
  if(pricing.source!=='PRICING'||pricing.evidence_contract!=='P1_COMMERCIAL_CONDITION_WINDOWS'
    ||sales.source!=='SALES'||sales.evidence_contract!=='P1_SALES_WINDOW_OBSERVATIONS'
    ||sales.lineage.pricing_evidence_id!==pricing.evidence_id)
    throw invalid('INCOMPATIBLE_EVIDENCE','SALES must reference these certified PRICING windows');
  const scope=sales.temporal.metrics_scope,cutoff=sales.temporal.cutoff;
  if(!['FULL_EPISODE','INTERSECTION'].includes(scope)||!validDate(cutoff))throw invalid('INVALID_EVIDENCE','Invalid observed temporal scope');
  if(parameters.metrics_scope!=null&&parameters.metrics_scope!==scope)throw invalid('INCOMPATIBLE_EVIDENCE','Requested metrics_scope differs from certified SALES evidence');
  if(sales.lineage.metrics_scope!=null&&sales.lineage.metrics_scope!==scope)throw invalid('INCOMPATIBLE_EVIDENCE','Certified scope lineage mismatch');
  const observations=new Map(sales.payload.windows.map(w=>[w.price_episode_id,w]));
  if(observations.size!==sales.payload.windows.length||observations.size!==pricing.payload.windows.length)
    throw invalid('INCOMPATIBLE_EVIDENCE','Every PRICING episode requires exactly one SALES observation');
  const windows=pricing.payload.windows.map(w=>{
    const s=observations.get(w.price_episode_id);
    if(!s||s.version_id!==w.version_id)throw invalid('INCOMPATIBLE_EVIDENCE','Episode/version mismatch');
    const from=scope==='INTERSECTION'?w.intersection_from:w.vigencia_desde;
    const end=scope==='INTERSECTION'?w.intersection_to:w.vigencia_hasta;
    const to=end&&end<cutoff?end:cutoff;
    const observable=from<=to;
    if(s.observed_from!==(observable?from:null)||s.observed_to!==(observable?to:null))
      throw invalid('INCOMPATIBLE_EVIDENCE','Observed bounds do not match the certified window');
    let count=null;
    if(s.evidence){
      const e=s.evidence;assertP1(e,'sales window');
      const filters=e.lineage.source_filters;
      if(e.source!=='SALES'||e.measure.id!=='VIN_SALES'||e.temporal.date_from!==from||e.temporal.date_to!==to
        ||String(filters.version_id)!==String(w.version_id)||e.universe.commercial_universe!==sales.universe.commercial_universe
        ||!Number.isSafeInteger(e.payload.value)||e.payload.value<0)
        throw invalid('INCOMPATIBLE_EVIDENCE','Invalid certified SALES selection');
      count=e.payload.value;
    }else if(observable&&Number.isSafeInteger(w.version_id)&&w.version_id>0)
      throw invalid('INVALID_EVIDENCE','Missing observable SALES evidence');
    const duration=w.vigencia_hasta?days(w.vigencia_desde,w.vigencia_hasta):null;
    const observedDays=observable?days(from,to):0;
    const full=from===w.vigencia_desde&&to===w.vigencia_hasta;
    const coexist=pricing.payload.windows.filter(other=>other.price_episode_id!==w.price_episode_id
      &&other.version_id===w.version_id&&other.commercial_condition_id!==w.commercial_condition_id
      &&other.vigencia_desde<=(w.vigencia_hasta??'9999-12-31')
      &&w.vigencia_desde<=(other.vigencia_hasta??'9999-12-31')).map(x=>x.price_episode_id);
    const scopeDays=scope==='INTERSECTION'?observedDays:duration;
    const rateAvailable=scope==='INTERSECTION'?observedDays>0:full;
    return {...w,metrics_scope:scope,dias_vigencia:scopeDays,dias_vigencia_episodio:duration,dias_observados:observedDays,
      observado_desde:s.observed_from,observado_hasta:s.observed_to,ventana_completa:full,
      vin_vendidos:count,vin_por_dia:rateAvailable&&count!=null?count/scopeDays:null,
      vin_por_dia_observado:count!=null&&observedDays?count/observedDays:null,
      sales_status:s.status,coverage:{version_unresolved_n:s.version_unresolved_n,model_unresolved_n:s.model_unresolved_n??null},
      coexistencia:{episode_ids:coexist,attribution:'TEMPORAL_MATCH_ONLY',additive:false},
      evidence:{pricing:pricing.evidence_id,sales:s.evidence?.evidence_id??null,sales_windows:sales.evidence_id},
      lineage:{pricing:{...pricing.lineage,...w.lineage},sales:s.evidence?.lineage??null}};
  });
  const compared=compareWindows(windows);
  const comparisonCoverage={};
  for(const w of compared)comparisonCoverage[w.comparison.status]=(comparisonCoverage[w.comparison.status]??0)+1;
  return {windows:compared,comparison_coverage:comparisonCoverage,metrics_scope:scope,cutoff,commercial_universe:sales.universe.commercial_universe,
    method:{identity:'CANONICAL_VERSION_ID',sales_authority:'EXISTING_CERTIFIED_SALES',duration:'INCLUSIVE_CALENDAR_DAYS',
      attribution:'Temporal coincidence only; no proof of condition paid. Overlapping conditions are non-additive.',
      scope:'INTERSECTION uses observed intersection days and VIN; FULL_EPISODE uses full episode days and only publishes vin_por_dia for fully observed closed episodes.',
      comparison:'Immediately previous chronological window of the same version within this PRICING evidence and scope; never skip an overlapping/ambiguous predecessor or infer outside-period rates.',
      identity_coverage:'Counts include resolved versions only. Unresolved version/model facts are explicit, never allocated.'}};
}


function compareWindows(windows){
  const versions=new Map();
  for(const w of windows){if(!versions.has(w.version_id))versions.set(w.version_id,[]);versions.get(w.version_id).push(w);}
  return windows.map(w=>{
    const series=versions.get(w.version_id);
    const earlier=series.filter(x=>x.vigencia_desde<w.vigencia_desde);
    const previousStart=earlier.reduce((last,x)=>!last||x.vigencia_desde>last?x.vigencia_desde:last,null);
    const candidates=earlier.filter(x=>x.vigencia_desde===previousStart);
    const previous=candidates.length===1?candidates[0]:null;
    const comparison={status:'NO_PREVIOUS_WINDOW_IN_SCOPE',previous_episode_id:previous?.price_episode_id??null,
      previous_commercial_condition_id:previous?.commercial_condition_id??null,previous_candidate_ids:candidates.map(x=>x.price_episode_id).sort((a,b)=>a-b),
      metrics_scope:w.metrics_scope,previous_vin_por_dia:previous?.vin_por_dia??null,
      delta_vin_por_dia:null,delta_porcentaje:null,movement:null};
    if(!Number.isSafeInteger(w.version_id)||w.version_id<=0)comparison.status='UNRESOLVED_VERSION';
    else if(w.coexistencia.episode_ids.length||series.filter(x=>x.vigencia_desde===w.vigencia_desde).length>1)
      comparison.status='COEXISTING_CONDITIONS';
    else if(candidates.length>1)comparison.status='AMBIGUOUS_PREVIOUS_WINDOW';
    else if(previous){
      if(!previous.vigencia_hasta||previous.vigencia_hasta>=w.vigencia_desde||previous.coexistencia.episode_ids.length)
        comparison.status='OVERLAPPING_PREVIOUS_WINDOW';
      else if(w.sales_status==='PARTIAL_IDENTITY'||previous.sales_status==='PARTIAL_IDENTITY')comparison.status='PARTIAL_IDENTITY';
      else if(w.vin_por_dia==null||previous.vin_por_dia==null)comparison.status='RATE_UNAVAILABLE';
      else{
        // Exact sign of rational rates, including two zeros and a zero baseline.
        const delta=BigInt(w.vin_vendidos)*BigInt(previous.dias_vigencia)-BigInt(previous.vin_vendidos)*BigInt(w.dias_vigencia);
        comparison.status='COMPARED';
        comparison.delta_vin_por_dia=Number(delta)/(w.dias_vigencia*previous.dias_vigencia);
        comparison.delta_porcentaje=previous.vin_vendidos===0?null:Number(delta)/(w.dias_vigencia*previous.vin_vendidos)*100;
        comparison.movement=delta>0n?'ACCELERATED':delta<0n?'DECELERATED':'UNCHANGED';
      }
    }
    return {...w,comparison};
  });
}
