import { DATA_SOURCE, CERTIFIER_VERSION, MEASURES, DIMENSIONS } from './contract.js';
import { field, evidenceId, quality, dimensions, temporal } from './dataset.js';
import { unsupportedSalesIdentifier } from './errors.js';
import { SALES_BRAND_DIMENSION as BRAND, SALES_GROUPING_VERSION, salesGroupingEvidenceSchema, compareSalesGroupingTuples } from './groupingContract.js';

function member(row,id,factSet,modelLabels){
  if(id==='NETWORK'){const key=factSet.network(row);return {id:key,label:key};}
  const config=id==='BRAND'?BRAND:DIMENSIONS[id];
  const key=field(row,config.field);
  const label=id==='BRAND'?row.marca_nombre:id==='MODEL'?modelLabels.get(String(key)):field(row,config.label_field);
  return {id:key==null?null:String(key),label:label??null};
}

// P1 factual operations on an already-certified selection. Legacy single-axis
// evidence preserves its exact envelope; BRAND and tuples are internal additive
// contracts, not advertised or routed through MCP in this work package.
export function observeSalesSelection(selection,{measure='VIN_SALES',group_by=[],period=null,cutoff_resolution='EXPLICIT'}={}){
  const measureId=String(measure).toUpperCase(),m=MEASURES[measureId];
  if(!m)throw unsupportedSalesIdentifier('MEASURE',measureId,Object.keys(MEASURES));
  if(!Array.isArray(group_by))throw new Error('INVALID_SALES_GROUP_BY');
  const groups=group_by.map(id=>String(id).toUpperCase());
  const internalGrouping=groups.includes('BRAND')||groups.length>1;
  if(new Set(groups).size!==groups.length)throw new Error('DUPLICATE_SALES_GROUP_BY');
  for(const id of groups)if(id!=='BRAND'&&!DIMENSIONS[id])throw new Error('UNSUPPORTED_DIMENSIONAL_DATASET_DIMENSION: '+id);
  const {factSet,facts}=selection,{u,base}=factSet;
  const filters=internalGrouping?selection.canonical_filters:selection.filters;
  if(period!=null&&(filters.date_from==null||filters.date_to==null||String(filters.date_from).slice(0,7)!==period||String(filters.date_to).slice(0,7)!==period))throw new Error('SALES_SELECTION_PERIOD_MISMATCH');
  const common={authority:'P1_CERTIFIED',status:'CERTIFIED',source:DATA_SOURCE,operation:'OBSERVE',grain:'FILTERED_SALES_UNIVERSE',
    measure:{id:m.id,unit:m.unit,aggregation:m.aggregation},universe:{commercial_universe:filters.commercial_universe},
    dimensions:dimensions(filters),temporal:temporal(filters),coverage:{source_n:base.length,filtered_n:facts.length,quality:quality(u)},
    lineage:{...u.lineage,certifier:'salesCertifier',certifier_version:CERTIFIER_VERSION,source_dataset:'SALES_WORK',source_filters:filters},
  };
  if(!groups.length){
    const contract={source:DATA_SOURCE,certifier_version:CERTIFIER_VERSION,measure:measureId,filters};
    return {evidence_id:evidenceId(contract),evidence_contract:'p1.quantitative_observation',evidence_version:'0.1.0',...common,payload:{value:facts.length}};
  }
  const modelLabels=new Map();
  if(groups.includes('MODEL'))for(const model of u.resolution_resources.model_catalog){
    const key=String(model.modelo_id);
    if(!modelLabels.has(key))modelLabels.set(key,model.modelo);
  }
  const counts=new Map();let unresolved=0;
  for(const row of facts){
    const tuple=groups.map(id=>member(row,id,factSet,modelLabels));
    if(tuple.some(x=>x.id==null))unresolved++;
    const key=JSON.stringify(tuple.map(x=>x.id));
    let entry=counts.get(key);
    if(!entry){entry={tuple,value:0};counts.set(key,entry);}
    tuple.forEach((x,i)=>{if(entry.tuple[i].label==null&&x.label!=null)entry.tuple[i].label=x.label;});
    entry.value++;
  }
  const sorted=[...counts.values()].sort((a,b)=>{
    if(internalGrouping)return compareSalesGroupingTuples(a.tuple.map(v=>({member_id:v.id})),b.tuple.map(v=>({member_id:v.id})));
    for(let i=0;i<groups.length;i++){
      const x=a.tuple[i].id,y=b.tuple[i].id;
      if(x==null&&y!=null)return 1;if(y==null&&x!=null)return -1;
      const d=String(x).localeCompare(String(y),undefined,{numeric:true});if(d)return d;
    }
    return 0;
  });
  const shape=groups.length===1?'DIMENSIONAL_QUANTITATIVE_DATASET':'MULTIDIMENSIONAL_QUANTITATIVE_DATASET';
  const contract={shape,measure:m.id,...(groups.length===1?{dimension:groups[0]}:{group_by:groups}),period,filters,
    ...(internalGrouping?{grouping_version:SALES_GROUPING_VERSION,selection_fingerprint:selection.fingerprint,cutoff_resolution:period?cutoff_resolution:null}:{}),
  };
  const configs=groups.map(id=>id==='BRAND'?BRAND:DIMENSIONS[id]);
  const payload=groups.length===1?{
    dimension:{id:groups[0],identity_contract:configs[0].identity_contract,identity_version:configs[0].identity_version,unresolved_member_policy:'EXPLICIT_UNRESOLVED_MEMBER'},
    members:sorted.map(x=>({member_id:x.tuple[0].id??'UNRESOLVED',member_label:x.tuple[0].id==null?'No resuelto':x.tuple[0].label,value:x.value})),
  }:{
    dimensions:groups.map((id,i)=>({id,identity_contract:configs[i].identity_contract,identity_version:configs[i].identity_version,unresolved_member_policy:'EXPLICIT_UNRESOLVED_MEMBER'})),
    members:sorted.map(x=>({members:x.tuple.map((v,i)=>({dimension:groups[i],member_id:v.id??'UNRESOLVED',member_label:v.id==null?'No resuelto':v.label})),value:x.value})),
  };
  const result={evidence_id:evidenceId(contract),evidence_contract:'p1.'+shape.toLowerCase(),evidence_version:'0.1.0',...common,
    temporal:{...common.temporal,period_identity:period,period_type:period?'COMMERCIAL_MONTH':null,cutoff:period?filters.date_to:null,cutoff_resolution:period?cutoff_resolution:null},
    coverage:{...common.coverage,dimension_resolved_n:facts.length-unresolved,dimension_unresolved_n:unresolved,dimension_resolution_rate:facts.length?(facts.length-unresolved)/facts.length:null},
    payload,lineage:{...common.lineage,...(groups.length===1?{dimension_identity:configs[0].identity_contract}:{dimension_identities:Object.fromEntries(groups.map((id,i)=>[id,configs[i].identity_contract]))}),
      ...(internalGrouping?{grouping_contract_version:SALES_GROUPING_VERSION,fact_set_fingerprint:factSet.ref.fingerprint,selection_fingerprint:selection.fingerprint}:{}),
    },
  };
  if(internalGrouping)salesGroupingEvidenceSchema.parse(result);
  return result;
}
