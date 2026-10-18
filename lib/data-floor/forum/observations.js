import { azureQuery as queryDb } from '../../azure-postgres.js';
import { DATA_SOURCE, CERTIFIER_VERSION, MEASURES, DIMENSIONS, DIMENSION_LABEL_REPAIRS, lineage } from './contract.js';
import { normalizedFilters, where, FORUM_FROM, NETWORK_SQL, DEALER_GROUP_SQL, fromForDealerIdentity, fromForStoreIdentity, fromForSellerIdentity } from './query.js';
import { norm, iso, bounds } from './values.js';
import { observeForumOperationSnapshot } from './snapshot.js';

async function observeDimensionalForum(input,measure){
  const dimension=norm(input.dimension),column=DIMENSIONS[dimension];
  if(!column)throw new Error('UNSUPPORTED_FORUM_DIMENSION: '+dimension);
  const fromPeriod=input.period_from||input.period,toPeriod=input.period_to||input.period;
  if(!fromPeriod||!toPeriod)throw new Error('FORUM_PERIOD_REQUIRED');
  const fb=bounds(fromPeriod),tb=bounds(toPeriod),from=fb.from,to=input.cutoff?iso(input.cutoff):tb.to;
  if(to<from||to>tb.to)throw new Error('INVALID_FORUM_CUTOFF');
  const f=normalizedFilters({filters:input.filters||{}}),w=where(f),p=[...w.params];
  let expr,rule,status='DATED_EVENT';
  p.push(from,to); const lo='$'+(p.length-1)+'::date',hi='$'+p.length+'::date';
  if(measure==='QUOTATIONS'){expr='CASE WHEN fecha_cotizacion BETWEEN '+lo+' AND '+hi+' THEN 1 ELSE 0 END';rule='ALL_COTIZACION_RECORDS';}
  else if(measure==='APPLICATIONS'){expr="CASE WHEN fecha_cotizacion BETWEEN "+lo+" AND "+hi+" AND upper(btrim(estado_actual)) <> 'COTIZACION' THEN 1 ELSE 0 END";rule='TIPO_PROCESO_NOT_COTIZACION';}
  else if(measure==='CURSES'){expr='CASE WHEN has_curse_evidence AND fecha_curse BETWEEN '+lo+' AND '+hi+' THEN 1 ELSE 0 END';rule='CURSE_OPERATION_BY_FECHA_CURSE';}
  else if(measure==='UFIS'){expr='CASE WHEN has_curse_evidence AND fecha_curse BETWEEN '+lo+' AND '+hi+' THEN ufi_curse ELSE 0 END';rule='CURSE_VEHICLE_UNITS_BY_FECHA_CURSE';}
  else if(measure==='COHORT_CONVERTED'){expr='CASE WHEN fecha_cotizacion BETWEEN '+lo+' AND '+hi+' AND has_curse_evidence THEN 1 ELSE 0 END';rule='QUOTATION_COHORT_HAS_CERTIFIED_CURSE';status='CURRENT_OUTCOME_OF_QUOTATION_COHORT';}
  else if(measure==='COHORT_APPROVED'){expr="CASE WHEN fecha_cotizacion BETWEEN "+lo+" AND "+hi+" AND NOT has_curse_evidence AND upper(btrim(estado_actual))='APROBADA' THEN 1 ELSE 0 END";rule='QUOTATION_COHORT_APPROVED_NOT_CURSED';status='CURRENT_OUTCOME_OF_QUOTATION_COHORT';}
  else if(measure==='COHORT_EXPIRED'){expr="CASE WHEN fecha_cotizacion BETWEEN "+lo+" AND "+hi+" AND NOT has_curse_evidence AND upper(btrim(estado_actual))='SOLICITUD CADUCADA' THEN 1 ELSE 0 END";rule='QUOTATION_COHORT_EXPIRED_NOT_CURSED';status='CURRENT_OUTCOME_OF_QUOTATION_COHORT';}
  else {expr="CASE WHEN fecha_cotizacion BETWEEN "+lo+" AND "+hi+" AND NOT has_curse_evidence AND upper(btrim(estado_actual))='RECHAZADA' THEN 1 ELSE 0 END";rule='QUOTATION_COHORT_REJECTED_NOT_CURSED';status='CURRENT_OUTCOME_OF_QUOTATION_COHORT';}
  if(dimension==='STORE'){
    const label="coalesce(forum_store.nombre_canonico,nullif(btrim(sucursal::text),''),'UNRESOLVED')";
    const idExpr="coalesce(forum_store.sucursal_id::text,'UNRESOLVED:'||coalesce(nullif(btrim(sucursal::text),''),'EMPTY'))";
    const sql='SELECT '+idExpr+' member_id, '+label+' member_label, coalesce(sum('+expr+'),0)::bigint value FROM '+fromForStoreIdentity()+' '+w.sql+' GROUP BY 1,2 HAVING coalesce(sum('+expr+'),0)>0 ORDER BY value DESC,member_label';
    const rows=await queryDb(sql,p),repairs=DIMENSION_LABEL_REPAIRS[dimension]||{};
    const members=rows.map(r=>({member_id:String(r.member_id),member_label:repairs[r.member_label]||r.member_label,value:Number(r.value||0)})).sort((a,b)=>b.value-a.value||a.member_label.localeCompare(b.member_label));
    const total=members.reduce((s,r)=>s+r.value,0),unresolved=members.filter(r=>r.member_id.startsWith('UNRESOLVED:')).reduce((s,r)=>s+r.value,0);
    return {evidence_id:'FORUM:'+measure+':'+dimension+':'+fromPeriod+':'+toPeriod+':'+to+':'+Date.now(),evidence_contract:'P1_DIMENSIONAL_QUANTITATIVE_DATASET',evidence_version:CERTIFIER_VERSION,authority:'P1_CERTIFIED',status:'COMPLETE',source:DATA_SOURCE,operation:'OBSERVE',grain:'FORUM_OPERATION',measure:{id:measure,unit:measure==='UFIS'?'VEHICLE_UNIT':'OPERATION'},universe:f,dimensions:{group_by:dimension},temporal:{cohort_basis:measure.startsWith('COHORT_')?'QUOTATION_DATE':null,period_from:fromPeriod,period_to:toPeriod,from,to,period_status:status},coverage:{complete:true,total_value:total,dimension_unresolved_value:unresolved},payload:{dimension:{id:dimension,identity_contract:'store_v01',unresolved_member_policy:'EXPLICIT_UNRESOLVED_MEMBER'},members,rule},lineage:lineage()};
  }

  if(dimension==='SELLER'){
    const label="coalesce(forum_seller.nombre_canonico,nullif(btrim(vendedor::text),''),'UNRESOLVED')";
    const idExpr="coalesce(forum_seller.persona_id::text,'UNRESOLVED:'||coalesce(nullif(btrim(vendedor::text),''),'EMPTY'))";
    const sql='SELECT '+idExpr+' member_id, '+label+' member_label, coalesce(sum('+expr+'),0)::bigint value FROM '+fromForSellerIdentity()+' '+w.sql+' GROUP BY 1,2 HAVING coalesce(sum('+expr+'),0)>0 ORDER BY value DESC,member_label';
    const rows=await queryDb(sql,p),members=rows.map(r=>({member_id:String(r.member_id),member_label:r.member_label,value:Number(r.value||0)})).sort((a,b)=>b.value-a.value||a.member_label.localeCompare(b.member_label));
    const total=members.reduce((s,r)=>s+r.value,0),unresolved=members.filter(r=>r.member_id.startsWith('UNRESOLVED:')).reduce((s,r)=>s+r.value,0);
    return {evidence_id:'FORUM:'+measure+':'+dimension+':'+fromPeriod+':'+toPeriod+':'+to+':'+Date.now(),evidence_contract:'P1_DIMENSIONAL_QUANTITATIVE_DATASET',evidence_version:CERTIFIER_VERSION,authority:'P1_CERTIFIED',status:'COMPLETE',source:DATA_SOURCE,operation:'OBSERVE',grain:'FORUM_OPERATION',measure:{id:measure,unit:measure==='UFIS'?'VEHICLE_UNIT':'OPERATION'},universe:f,dimensions:{group_by:dimension},temporal:{cohort_basis:measure.startsWith('COHORT_')?'QUOTATION_DATE':null,period_from:fromPeriod,period_to:toPeriod,from,to,period_status:status},coverage:{complete:true,total_value:total,dimension_unresolved_value:unresolved},payload:{dimension:{id:dimension,identity_contract:'personas_master',identity_version:'0.1',unresolved_member_policy:'EXPLICIT_UNRESOLVED_MEMBER'},members,rule},lineage:lineage()};
  }
  const label=dimension==='BRAND'?"coalesce(forum_brand.nombre_canonico,'UNRESOLVED')":dimension==='COMMERCIAL_OUTCOME'?"CASE WHEN has_curse_evidence THEN 'CONVERTED' ELSE 'NOT_CONVERTED' END":dimension==='NETWORK'?NETWORK_SQL:dimension==='DISTRIBUTOR'?DEALER_GROUP_SQL:"coalesce(nullif(btrim("+column+"::text),''),'UNRESOLVED')";
  const sourceFrom=dimension==='DISTRIBUTOR'?fromForDealerIdentity():FORUM_FROM;
  const sql='SELECT '+label+' member_label, coalesce(sum('+expr+'),0)::bigint value FROM '+sourceFrom+' '+w.sql+' GROUP BY 1 HAVING coalesce(sum('+expr+'),0)>0 ORDER BY value DESC,member_label';
  const rows=await queryDb(sql,p),repairs=DIMENSION_LABEL_REPAIRS[dimension]||{},merged=new Map();
  for(const r of rows){const raw=r.member_label,label=repairs[raw]||raw;merged.set(label,(merged.get(label)||0)+Number(r.value||0));}
  const members=[...merged.entries()].map(([member_label,value])=>({member_id:member_label,member_label,value})).sort((a,b)=>b.value-a.value||a.member_label.localeCompare(b.member_label));
  const total=members.reduce((s,r)=>s+r.value,0),unresolved=members.find(r=>r.member_id==='UNRESOLVED')?.value||0;
  return {evidence_id:'FORUM:'+measure+':'+dimension+':'+fromPeriod+':'+toPeriod+':'+to+':'+Date.now(),evidence_contract:'P1_DIMENSIONAL_QUANTITATIVE_DATASET',evidence_version:CERTIFIER_VERSION,authority:'P1_CERTIFIED',status:'COMPLETE',source:DATA_SOURCE,operation:'OBSERVE',grain:'FORUM_OPERATION',measure:{id:measure,unit:measure==='UFIS'?'VEHICLE_UNIT':'OPERATION'},universe:f,dimensions:{group_by:dimension},temporal:{cohort_basis:measure.startsWith('COHORT_')?'QUOTATION_DATE':null,period_from:fromPeriod,period_to:toPeriod,from,to,period_status:status},coverage:{complete:true,total_value:total,dimension_unresolved_value:unresolved},payload:{dimension:{id:dimension,identity_contract:dimension==='BRAND'?'brand_v01':dimension==='DISTRIBUTOR'?'dealer_group_v01':'FORUM_SOURCE_LABEL',unresolved_member_policy:'EXPLICIT_UNRESOLVED_MEMBER'},members,rule},lineage:lineage()};
}
async function openMonth(){const [r={}]=await queryDb('SELECT max(last_snapshot_date)::text d FROM forum_funnel_universe_v01');const d=iso(r.d);return d?d.slice(0,7):null;}
async function observePrecurseSnapshot(input={}){
  const shape=input.evidence_shape||'QUANTITATIVE_OBSERVATION';
  if(!['QUANTITATIVE_OBSERVATION','DIMENSIONAL_QUANTITATIVE_DATASET'].includes(shape))throw new Error('PRECURSE_REQUIRES_LATEST_SNAPSHOT_SHAPE');
  if(input.period||input.period_from||input.period_to)throw new Error('PRECURSE_IS_SNAPSHOT_STOCK_NOT_PERIOD_EVENT');
  const dimension=norm(input.dimension);
  if(shape==='DIMENSIONAL_QUANTITATIVE_DATASET'&&dimension!=='BRAND')throw new Error('PRECURSE_SUPPORTS_BRAND_DIMENSION_ONLY');
  if(shape!=='DIMENSIONAL_QUANTITATIVE_DATASET'&&dimension)throw new Error('PRECURSE_DIMENSION_REQUIRES_DIMENSIONAL_SHAPE');

  const [latest={}]=await queryDb('SELECT max(last_snapshot_date)::text snapshot_date FROM forum_funnel_universe_v01');
  const snapshotDate=iso(latest.snapshot_date);
  if(!snapshotDate)throw new Error('PRECURSE_SNAPSHOT_NOT_AVAILABLE');
  const requestedCutoff=input.cutoff?iso(input.cutoff):null;
  if(requestedCutoff&&requestedCutoff!==snapshotDate)throw new Error('PRECURSE_REQUIRES_LATEST_AVAILABLE_SNAPSHOT: '+snapshotDate);

  const f=normalizedFilters({filters:input.filters||{}}),w=where(f);
  const temporal={snapshot_date:snapshotDate,cutoff:snapshotDate,observation_semantics:'LATEST_AVAILABLE_CERTIFIED_SNAPSHOT'};
  const common={evidence_version:CERTIFIER_VERSION,authority:'P1_CERTIFIED',status:'COMPLETE',source:DATA_SOURCE,operation:'OBSERVE',grain:'FORUM_OPERATION',measure:{id:'PRECURSE',unit:'OPERATION'},universe:f,temporal,coverage:{complete:true},lineage:{...lineage(),precurse_snapshot_source:'forum_funnel_universe_v01',precurse_snapshot_date:snapshotDate}};

  if(shape==='DIMENSIONAL_QUANTITATIVE_DATASET'){
    const rows=await queryDb('SELECT coalesce(forum_product.brand_id::text,\'UNRESOLVED\') member_id, coalesce(forum_brand.nombre_canonico,\'No resuelto\') member_label, count(*) FILTER (WHERE etapa_certificada=\'PRECURSE\')::bigint value FROM '+FORUM_FROM+' '+w.sql+' GROUP BY 1,2 HAVING count(*) FILTER (WHERE etapa_certificada=\'PRECURSE\')>0 ORDER BY member_label',w.params);
    const members=rows.map(r=>({member_id:String(r.member_id),member_label:r.member_label,value:Number(r.value||0)}));
    const total=members.reduce((sum,row)=>sum+row.value,0),unresolved=members.filter(row=>row.member_id==='UNRESOLVED').reduce((sum,row)=>sum+row.value,0);
    return {evidence_id:'FORUM:PRECURSE:BRAND:'+snapshotDate+':'+Date.now(),evidence_contract:'P1_DIMENSIONAL_QUANTITATIVE_DATASET',...common,dimensions:{group_by:'BRAND'},coverage:{complete:true,total_value:total,dimension_unresolved_value:unresolved},payload:{dimension:{id:'BRAND',identity_contract:'brand_v01',unresolved_member_policy:'EXPLICIT_UNRESOLVED_MEMBER'},members,rule:'CERTIFIED_PRECURSE_STAGE_NO_CERTIFIED_CURSE'}};
  }

  const [result={}]=await queryDb('SELECT count(*) FILTER (WHERE etapa_certificada=\'PRECURSE\')::bigint value FROM '+FORUM_FROM+' '+w.sql,w.params);
  return {evidence_id:'FORUM:PRECURSE:'+snapshotDate+':'+Date.now(),evidence_contract:'P1_FACTUAL_OBSERVATION',...common,payload:{value:Number(result.value||0),rule:'CERTIFIED_PRECURSE_STAGE_NO_CERTIFIED_CURSE'}};
}
export async function observeForumEvidence(input={}){
  const measure=norm(input.measure);
  if(!MEASURES.includes(measure))throw new Error('UNSUPPORTED_FORUM_MEASURE: '+measure);
  if(measure==='PRECURSE')return observePrecurseSnapshot(input);
  if(measure==='OPERATION_STATES'){
    if(input.evidence_shape!=='OPERATION_STATE_SNAPSHOT')throw new Error('OPERATION_STATES_REQUIRES_SNAPSHOT_SHAPE');
    return observeForumOperationSnapshot(input);
  }

  const shape=input.evidence_shape||'QUANTITATIVE_OBSERVATION';
  if(shape==='DIMENSIONAL_QUANTITATIVE_DATASET')return observeDimensionalForum(input,measure);
  if(!['QUANTITATIVE_OBSERVATION','CUMULATIVE_PERIOD_OBSERVATION'].includes(shape))throw new Error('UNSUPPORTED_FORUM_EVIDENCE_SHAPE');
  if(!input.period)throw new Error('FORUM_PERIOD_REQUIRED');

  const b=bounds(input.period);
  const cutoff=input.cutoff?iso(input.cutoff):b.to;
  if(cutoff<b.from||cutoff>b.to)throw new Error('INVALID_FORUM_CUTOFF');

  const f=normalizedFilters({filters:input.filters||{}});
  const w=where(f);
  const p=[...w.params];
  const prefix=w.sql?w.sql+' AND ':'WHERE ';
  let sql,rule,status='DATED_EVENT';

  if(measure==='QUOTATIONS'){
    p.push(b.from,cutoff);
    sql='SELECT count(*)::bigint value FROM '+FORUM_FROM+' '+prefix+
      'fecha_cotizacion BETWEEN $'+(p.length-1)+'::date AND $'+p.length+'::date';
    rule='ALL_COTIZACION_RECORDS';
  }else if(measure==='APPLICATIONS'){
    p.push(b.from,cutoff);
    sql='SELECT count(*)::bigint value FROM '+FORUM_FROM+' '+prefix+
      "fecha_cotizacion BETWEEN $"+(p.length-1)+"::date AND $"+p.length+
      "::date AND upper(btrim(estado_actual)) <> 'COTIZACION'";
    rule='TIPO_PROCESO_NOT_COTIZACION';
  }else if(measure==='CURSES'){
    p.push(b.from,cutoff);
    sql='SELECT count(*)::bigint value FROM '+FORUM_FROM+' '+prefix+
      'has_curse_evidence AND fecha_curse BETWEEN $'+(p.length-1)+'::date AND $'+p.length+'::date';
    rule='CURSE_OPERATION_BY_FECHA_CURSE';
  }else if(measure==='UFIS'){
    const om=await openMonth();
    const open=input.period===om;
    p.push(b.from,cutoff);
    const curse='CASE WHEN has_curse_evidence AND fecha_curse BETWEEN $'+
      (p.length-1)+'::date AND $'+p.length+'::date THEN ufi_curse ELSE 0 END';
    sql='SELECT coalesce(sum('+curse+'),0)::bigint value FROM '+FORUM_FROM+' '+w.sql;
    rule='CURSE_VEHICLE_UNITS_BY_FECHA_CURSE';
    status=open?'OPEN':'CLOSED';
  }else if(measure==='COHORT_CONVERTED'){
    p.push(b.from,cutoff);
    sql='SELECT count(*)::bigint value FROM '+FORUM_FROM+' '+prefix+
      'fecha_cotizacion BETWEEN $'+(p.length-1)+'::date AND $'+p.length+'::date AND has_curse_evidence';
    rule='QUOTATION_COHORT_HAS_CERTIFIED_CURSE';
    status='CURRENT_OUTCOME_OF_QUOTATION_COHORT';
  }else if(measure==='COHORT_APPROVED'){
    p.push(b.from,cutoff);
    sql='SELECT count(*)::bigint value FROM '+FORUM_FROM+' '+prefix+
      "fecha_cotizacion BETWEEN $"+(p.length-1)+"::date AND $"+p.length+
      "::date AND NOT has_curse_evidence AND upper(btrim(estado_actual))='APROBADA'";
    rule='QUOTATION_COHORT_APPROVED_NOT_CURSED';
    status='CURRENT_OUTCOME_OF_QUOTATION_COHORT';
  }else if(measure==='COHORT_EXPIRED'){
    p.push(b.from,cutoff);
    sql='SELECT count(*)::bigint value FROM '+FORUM_FROM+' '+prefix+
      "fecha_cotizacion BETWEEN $"+(p.length-1)+"::date AND $"+p.length+
      "::date AND NOT has_curse_evidence AND upper(btrim(estado_actual))='SOLICITUD CADUCADA'";
    rule='QUOTATION_COHORT_EXPIRED_NOT_CURSED';
    status='CURRENT_OUTCOME_OF_QUOTATION_COHORT';
  }else{
    p.push(b.from,cutoff);
    sql='SELECT count(*)::bigint value FROM '+FORUM_FROM+' '+prefix+
      "fecha_cotizacion BETWEEN $"+(p.length-1)+"::date AND $"+p.length+
      "::date AND NOT has_curse_evidence AND upper(btrim(estado_actual))='RECHAZADA'";
    rule='QUOTATION_COHORT_REJECTED_NOT_CURSED';
    status='CURRENT_OUTCOME_OF_QUOTATION_COHORT';
  }

  const [r={}]=await queryDb(sql,p);
  const value=Number(r.value||0);
  return {
    evidence_id:'FORUM:'+measure+':'+input.period+':'+cutoff+':'+Date.now(),
    evidence_contract:'P1_FACTUAL_OBSERVATION',
    evidence_version:CERTIFIER_VERSION,
    authority:'P1_CERTIFIED',
    status:'COMPLETE',
    source:DATA_SOURCE,
    operation:'OBSERVE',
    grain:'FORUM_OPERATION',
    measure:{id:measure,unit:measure==='UFIS'?'VEHICLE_UNIT':'OPERATION'},
    universe:f,
    dimensions:{},
    temporal:{period:input.period,from:b.from,to:cutoff,period_status:status},
    coverage:{complete:true},
    payload:{value,rule},
    lineage:lineage()
  };
}
