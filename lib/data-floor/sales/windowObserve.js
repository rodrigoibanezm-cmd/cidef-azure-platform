import { randomUUID } from 'node:crypto';
import { prepareSalesInput } from './preparation.js';
import { observeSalesSelection } from './operations.js';
import { assertP1, invalid } from '../../p2/validation.js';
import { validDate } from '../../longitudinal/common.js';
import { parseCommercialUniverse } from '../../ventas-commercial/buildVentasCommercialContext.js';

// Execution-owned reuse only. A distinct end requires its own existing LAST
// recognition; selecting an older window from a later recognition is incorrect.
export async function observeSalesWindows({pricing,cutoff,metrics_scope='INTERSECTION',commercial_universe='COMPANY'}={}) {
  const started=Date.now();
  assertP1(pricing,'pricing');
  if(pricing.source!=='PRICING'||pricing.evidence_contract!=='P1_COMMERCIAL_CONDITION_WINDOWS')
    throw invalid('INVALID_EVIDENCE','Certified PRICING windows required');
  if(!validDate(cutoff))throw invalid('INVALID_PARAMETERS','Explicit valid cutoff required');
  if(!['FULL_EPISODE','INTERSECTION'].includes(metrics_scope))throw invalid('INVALID_PARAMETERS','Unsupported metrics_scope');
  if(!Array.isArray(pricing.payload?.windows))throw invalid('INVALID_EVIDENCE','Complete PRICING window collection required');
  if(pricing.payload.count!=null&&pricing.payload.count!==pricing.payload.windows.length)throw invalid('INVALID_EVIDENCE','Incomplete PRICING window collection');
  if(new Set(pricing.payload.windows.map(w=>w.price_episode_id)).size!==pricing.payload.windows.length)throw invalid('INVALID_EVIDENCE','Duplicate PRICING episode');
  const scope=parseCommercialUniverse(commercial_universe);
  const plans=pricing.payload.windows.map(window=>{
    const from=metrics_scope==='INTERSECTION'?window.intersection_from:window.vigencia_desde;
    const end=metrics_scope==='INTERSECTION'?window.intersection_to:window.vigencia_hasta;
    const to=end&&end<cutoff?end:cutoff;
    return {window,from,to,observable:from<=to,identity_resolved:Number.isSafeInteger(window.version_id)&&window.version_id>0};
  });
  const usable=plans.filter(p=>p.observable&&p.identity_resolved);
  const prepared=usable.length?await prepareSalesInput():null;
  const sets=new Map();
  for(const p of usable)if(!sets.has(p.to))sets.set(p.to,prepared.buildFactSet({commercial_universe:scope,cutoff_date:p.to}));
  const results=plans.map(p=>{
    const {window,from,to}=p;
    if(!p.observable||!p.identity_resolved)return {price_episode_id:window.price_episode_id,version_id:window.version_id,
      observed_from:p.observable?from:null,observed_to:p.observable?to:null,evidence:null,
      status:p.observable?'UNRESOLVED_VERSION':'NO_OBSERVABLE_DAYS',version_unresolved_n:null};
    const factSet=sets.get(to);
    const selection=factSet.select({commercial_universe:scope,date_from:from,date_to:to,version_id:window.version_id});
    const e=observeSalesSelection(selection);
    // Same model/date slice exposes leads lost by incomplete VERSION identity.
    // Unknown model identities are separately retained as universe coverage.
    const dateSlice=factSet.select({commercial_universe:scope,date_from:from,date_to:to});
    const unresolved=dateSlice.facts.filter(r=>r.modelo_id===window.model_id&&r.version_id==null).length;
    const unknownModel=dateSlice.facts.filter(r=>r.modelo_id==null).length;
    return {price_episode_id:window.price_episode_id,version_id:window.version_id,observed_from:from,observed_to:to,
      evidence:e,status:unresolved||unknownModel?'PARTIAL_IDENTITY':'OBSERVED',version_unresolved_n:unresolved,
      model_unresolved_n:unknownModel,fact_set_fingerprint:factSet.ref.fingerprint};
  });
  const execution={duration_ms:Date.now()-started,pricing_windows:plans.length,preparations:prepared?1:0,recognitions:sets.size,fact_sets:sets.size,operations:results.length,
    cutoffs:[...sets.keys()],commercial_universe:scope};
  return {evidence_id:'SALES_WINDOWS:'+randomUUID(),evidence_contract:'P1_SALES_WINDOW_OBSERVATIONS',evidence_version:'0.2.0',
    authority:'P1_CERTIFIED',source:'SALES',operation:'OBSERVE',status:results.every(r=>r.status==='OBSERVED')?'COMPLETE':'PARTIAL',
    measure:{id:'VIN_SALES',unit:'VIN',aggregation:'COUNT_RECOGNIZED_SALE'},universe:{commercial_universe:scope},
    temporal:{cutoff,metrics_scope,window_bounds:'INCLUSIVE',recognition_cutoff:'EACH_OBSERVED_END',date_semantics:'fecha_factura'},
    payload:{windows:results},execution,
    lineage:{pricing_evidence_id:pricing.evidence_id,metrics_scope,pricing_period:{from:pricing.temporal?.from??null,to:pricing.temporal?.to??null},universe:'ventas_universe_v01',certifier:'salesCertifier',
      recognition:'EXISTING_LAST_WITH_CUTOFF_BEFORE_RECOGNITION',selection:'VERSION_AND_DATE_AFTER_RECOGNITION',
      fact_set_fingerprints:[...sets.values()].map(s=>s.ref.fingerprint)}};
}
