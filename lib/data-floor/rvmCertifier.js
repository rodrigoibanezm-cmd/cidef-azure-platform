import { createHash } from 'node:crypto';
import { azureQuery } from '../azure-postgres.js';

export const DATA_SOURCE = 'RVM';
export const CERTIFIER_VERSION = '0.6.4';

const RVM_BRAND_IDENTITY_RULE = Object.freeze({
  mode:'RAW_LABEL_NORMALIZED_ONLY',
  rule:'RVM brand identity preserves distinct source brands after UPPER/TRIM normalization. Never merge DFM, DONGFENG or DONG FENG by name similarity.',
  cidef_business_brand:'DFM',
  distinct_market_brands:['DONGFENG','DONG FENG'],
  rationale:'These labels carry different model portfolios in RVM; DONGFENG/DONG FENG must not be counted as CIDEF DFM market registrations.'
});

const FILTERS = Object.freeze([
  'date_from','date_to','data_status','snapshot_date','vin',
  'brand','model','version','segment','type','region','comuna','fuel','origin'
]);

const FIELDS = Object.freeze([
  'registration_date','vin','brand','model','version','segment','type',
  'region','comuna','fuel','origin','quantity','data_status','snapshot_date'
]);
const DIMENSION_COLUMNS = Object.freeze({REGION:'region',BRAND:'marca',MODEL:'modelo_homologado',SEGMENT:'descripcion_segmento'});
const DIMENSION_GROUPS = Object.freeze({
  REGION:['REGION'], BRAND:['BRAND'], MODEL:['MODEL'], SEGMENT:['SEGMENT'],
  BRAND_MODEL:['BRAND','MODEL'], SEGMENT_BRAND:['SEGMENT','BRAND'],
  SEGMENT_BRAND_MODEL:['SEGMENT','BRAND','MODEL']
});
const MEASURES = Object.freeze({
  RVM_UNITS: Object.freeze({
    id:'RVM_UNITS',unit:'VEHICLE',aggregation:'SUM_SOURCE_QUANTITY',
    meaning:'Sum of certified RVM registration quantity in the filtered RVM universe.'
  })
});

function values(v){ return Array.isArray(v) ? v : [v]; }
function iso(v){
  if(v==null) return null;
  if(v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0,10);
  const s=String(v).trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  const d=new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
}
function norm(v){ return v==null ? null : String(v).trim().toUpperCase(); }
function canonicalRegionSql(column='region'){ return `upper(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`; }
function canonicalRegion(v){ return v==null ? null : String(v).trim().replace(/\s+/g,' ').toUpperCase(); }
function stable(value){ if(Array.isArray(value)) return value.map(stable); if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])); return value; }
function evidenceId(payload){ return 'p1.rvm.'+createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex').slice(0,24); }
function periodBounds(period){
  if(!/^\d{4}-\d{2}$/.test(String(period||''))) throw new Error('INVALID_RVM_PERIOD');
  const [y,m]=String(period).split('-').map(Number);
  const last=new Date(Date.UTC(y,m,0)).getUTCDate();
  return {from:String(period)+'-01',to:String(period)+'-'+String(last).padStart(2,'0')};
}
function dimensions(filters){
  const keys=['brand','model','version','segment','type','region','comuna','fuel','origin'];
  return Object.fromEntries(keys.filter(k=>filters[k]!=null).map(k=>[k,filters[k]]));
}

function normalize(input={}){
  const filters={...(input.filters??{})};
  const unsupported=Object.keys(filters).find(k=>!FILTERS.includes(k));
  if(unsupported) throw new Error('UNSUPPORTED_RVM_FILTER: '+unsupported);

  const dataStatus=norm(filters.data_status ?? 'CONSOLIDATED');
  if(!['CONSOLIDATED','PRELIMINARY'].includes(dataStatus)) throw new Error('INVALID_RVM_DATA_STATUS');
  filters.data_status=dataStatus;

  const snapshot=filters.snapshot_date==null ? null : iso(filters.snapshot_date);
  if(dataStatus==='CONSOLIDATED' && snapshot!=null) throw new Error('SNAPSHOT_DATE_ONLY_VALID_FOR_PRELIMINARY');
  if(filters.date_from!=null) filters.date_from=iso(filters.date_from);
  if(filters.date_to!=null) filters.date_to=iso(filters.date_to);
  if(filters.date_from && filters.date_to && filters.date_from>filters.date_to) throw new Error('INVALID_RVM_DATE_RANGE');
  if(snapshot) filters.snapshot_date=snapshot;
  return {filters};
}

function periodFromFilters(filters){
  const from=filters.date_from?.slice(0,7),to=filters.date_to?.slice(0,7);
  return from&&to&&from===to ? from : null;
}
async function availablePeriodUniverse(period){
  const b=periodBounds(period);
  const [row={}]=await azureQuery(`
    SELECT coalesce(bool_or(data_status='CONSOLIDATED'),false) AS has_consolidated,
      max(snapshot_date) FILTER (WHERE data_status='PRELIMINARY')::text AS snapshot_date
    FROM rvm_raw WHERE fecha >= $1::date AND fecha <= $2::date
  `,[b.from,b.to]);
  const snapshot=iso(row.snapshot_date);
  return row.has_consolidated || !snapshot
    ? {data_status:'CONSOLIDATED'}
    : {data_status:'PRELIMINARY',snapshot_date:snapshot};
}
async function latestPreliminarySnapshot(period){
  const b=periodBounds(period);
  const [row={}]=await azureQuery(`
    SELECT max(snapshot_date)::text AS snapshot_date
    FROM rvm_raw
    WHERE data_status='PRELIMINARY'
      AND snapshot_date IS NOT NULL
      AND fecha >= $1::date AND fecha <= $2::date
  `,[b.from,b.to]);
  return iso(row.snapshot_date);
}
async function resolveUniverse(input={},period=null){
  const raw={...(input.filters??{})};
  const explicitStatus=raw.data_status!=null;
  const explicitSnapshot=raw.snapshot_date!=null;
  const requestedPeriod=period??periodFromFilters(raw);
  if(explicitSnapshot && !explicitStatus) raw.data_status='PRELIMINARY';
  // Validate caller filters before discovery I/O. Explicit status/snapshot wins.
  normalize({filters:raw});
  if(!explicitStatus && !explicitSnapshot && requestedPeriod){
    Object.assign(raw,await availablePeriodUniverse(requestedPeriod));
  }
  let filters=normalize({filters:raw}).filters;
  if(filters.data_status==='PRELIMINARY' && !filters.snapshot_date){
    if(!requestedPeriod) throw new Error('RVM_PERIOD_REQUIRED_FOR_PRELIMINARY_SNAPSHOT_RESOLUTION');
    const snapshot=await latestPreliminarySnapshot(requestedPeriod);
    if(!snapshot) throw new Error('PRELIMINARY_SNAPSHOT_NOT_FOUND_FOR_PERIOD: '+requestedPeriod);
    filters={...filters,snapshot_date:snapshot};
  }
  return filters;
}

function where(filters){
  const clauses=[]; const params=[];
  const add=(sql,value)=>{params.push(value);clauses.push(sql.replace('?', '$'+params.length));};
  add('data_status = ?::text',filters.data_status);
  if(filters.date_from) add('fecha >= ?::date',filters.date_from);
  if(filters.date_to) add('fecha <= ?::date',filters.date_to);
  if(filters.snapshot_date) add('snapshot_date = ?::date',filters.snapshot_date);

  const cols={
    vin:'vin',brand:'marca',model:'modelo_homologado',version:'modeo_version',
    segment:'descripcion_segmento',type:'descripcion_tipo',region:'region',
    comuna:'comuna_adquisicion',fuel:'combustible',origin:'pais_vin'
  };
  for(const [key,col] of Object.entries(cols)){
    if(filters[key]==null) continue;
    const vals=values(filters[key]).map(norm).filter(Boolean);
    params.push(vals);
    if(key==='region'){
      params[params.length-1]=vals.map(canonicalRegion);
      clauses.push(`${canonicalRegionSql(col)} = ANY($${params.length}::text[])`);
    } else {
      clauses.push(`upper(btrim(${col})) = ANY($${params.length}::text[])`);
    }
  }
  return {sql:clauses.length?'WHERE '+clauses.join(' AND '):'',params};
}

function field(row,key){
  const map={
    registration_date:iso(row.fecha),vin:row.vin,brand:row.marca,
    model:row.modelo_homologado,version:row.modeo_version,
    segment:row.descripcion_segmento,type:row.descripcion_tipo,region:row.region,
    comuna:row.comuna_adquisicion,fuel:row.combustible,origin:row.pais_vin,
    quantity:Number(row.cantidad??0),data_status:row.data_status,
    snapshot_date:iso(row.snapshot_date)
  };
  return map[key];
}

async function sourceSize(filters){
  const params=[filters.data_status];
  let sql='WHERE data_status = $1::text';
  if(filters.data_status==='PRELIMINARY'){
    params.push(filters.snapshot_date);
    sql+=' AND snapshot_date = $2::date';
  }
  const [row={}]=await azureQuery(`SELECT count(*)::bigint AS n FROM rvm_raw ${sql}`,params);
  return Number(row.n??0);
}

function lineage(filters){
  return {
    universe:'rvm_raw',
    raw_source:'rvm_raw',
    registration_date_authority:'rvm_raw.fecha',
    status_rule:filters.data_status,
    snapshot_rule:filters.data_status==='PRELIMINARY' ? 'resolved exact preliminary snapshot_date' : 'snapshot_date not applicable'
  };
}

export function describeRvm(){
  return {
    source:DATA_SOURCE,version:CERTIFIER_VERSION,
    meaning:'Certified RVM vehicle registration facts.',
    grain:'one observed RVM registration row; quantity preserves source units',
    date_semantics:{
      registration_date:'rvm_raw.fecha',
      consolidated:'closed RVM observations',
      preliminary:'latest available snapshot_date for the requested open period unless an explicit valid snapshot is supplied'
    },
    filters:FILTERS,fields:FIELDS,measures:MEASURES,
    dimensions:Object.keys(DIMENSION_GROUPS),
    brand_identity:RVM_BRAND_IDENTITY_RULE,
    semantic_constraints:[
      'RVM dimensional BRAND and MODEL identities use raw source labels normalized with UPPER/TRIM; canonical BRAND ids from data_resolve are not RVM filters.',
      'Compound dimensions: BRAND_MODEL = BRAND x MODEL; SEGMENT_BRAND = SEGMENT x BRAND; SEGMENT_BRAND_MODEL = SEGMENT x BRAND x MODEL. Members retain each component in dimensions.',
      'Without explicit status/snapshot, a single period prefers available CONSOLIDATED data; otherwise selects its latest available PRELIMINARY snapshot. Explicit selections are preserved.',
      'Use dimensional data_observe with segment/brand filters for market openings; RVM_UNITS sums source quantity, not distinct VIN.'
    ],
    operations:['DESCRIBE','INSPECT','FETCH','OBSERVE'],
    evidence_shapes:['QUANTITATIVE_OBSERVATION','PERIOD_OBSERVATION_SERIES','DIMENSIONAL_QUANTITATIVE_DATASET'],
    boolean_logic:'AND between filters; OR within array values',
    lineage:lineage({data_status:'CONSOLIDATED'})
  };
}

export async function inspectRvm(input={}){
  const filters=await resolveUniverse(input); const w=where(filters);
  const sourceN=await sourceSize(filters);
  const [row={}]=await azureQuery(`
    SELECT count(*)::bigint AS row_count,
      coalesce(sum(cantidad),0)::bigint AS units,
      count(DISTINCT nullif(btrim(vin),''))::bigint AS distinct_vin,
      count(DISTINCT nullif(btrim(marca),''))::bigint AS distinct_brand,
      count(DISTINCT nullif(btrim(modelo_homologado),''))::bigint AS distinct_model,
      count(DISTINCT nullif(btrim(region),''))::bigint AS distinct_region,
      min(fecha)::text AS min_date,max(fecha)::text AS max_date,
      count(*) FILTER (WHERE vin IS NULL OR btrim(vin)='')::bigint AS missing_vin,
      count(*) FILTER (WHERE fecha IS NULL)::bigint AS missing_registration_date
    FROM rvm_raw ${w.sql}`,w.params);
  const rows=Number(row.row_count??0),missingVin=Number(row.missing_vin??0),missingDate=Number(row.missing_registration_date??0);
  return {
    source:DATA_SOURCE,operation:'INSPECT',filters,
    size:{source_n:sourceN,filtered_n:rows,units:Number(row.units??0)},
    shape:{
      distinct_vin:Number(row.distinct_vin??0),distinct_brand:Number(row.distinct_brand??0),
      distinct_model:Number(row.distinct_model??0),distinct_region:Number(row.distinct_region??0),
      date_from:iso(row.min_date),date_to:iso(row.max_date)
    },
    quality:{
      coverage:{
        vin:{present_n:rows-missingVin,missing_n:missingVin},
        registration_date:{present_n:rows-missingDate,missing_n:missingDate}
      },
      validation:{data_status_valid:true,snapshot_rule_valid:true},
      warnings:[...(missingVin?['RVM_VIN_MISSING_PRESENT']:[]),...(missingDate?['RVM_REGISTRATION_DATE_MISSING_PRESENT']:[])]
    },
    lineage:lineage(filters)
  };
}

export async function fetchRvm(input={}){
  const filters=await resolveUniverse(input); const fields=input.fields?.length?input.fields:FIELDS;
  const bad=fields.find(k=>!FIELDS.includes(k));
  if(bad) throw new Error('UNSUPPORTED_RVM_FIELD: '+bad);
  const w=where(filters);
  const sourceN=await sourceSize(filters);
  const rows=await azureQuery(`
    SELECT fecha,vin,marca,modelo_homologado,modeo_version,descripcion_segmento,
      descripcion_tipo,region,comuna_adquisicion,combustible,pais_vin,cantidad,
      data_status,snapshot_date
    FROM rvm_raw ${w.sql}
    ORDER BY fecha,vin NULLS LAST`,w.params);
  const out=rows.map(row=>Object.fromEntries(fields.map(k=>[k,field(row,k)])));
  const missingVin=rows.filter(r=>r.vin==null||String(r.vin).trim()==='').length;
  const missingDate=rows.filter(r=>r.fecha==null).length;
  return {
    source:DATA_SOURCE,operation:'FETCH',dataset:'RVM_WORK',version:CERTIFIER_VERSION,
    filters,grain:'RVM_REGISTRATION_OBSERVATION',
    size:{source_n:sourceN,filtered_n:out.length,units:rows.reduce((s,r)=>s+Number(r.cantidad??0),0)},
    rows:out,
    quality:{
      coverage:{
        vin:{present_n:rows.length-missingVin,missing_n:missingVin},
        registration_date:{present_n:rows.length-missingDate,missing_n:missingDate}
      },
      validation:{data_status_valid:true,snapshot_rule_valid:true},
      warnings:[...(missingVin?['RVM_VIN_MISSING_PRESENT']:[]),...(missingDate?['RVM_REGISTRATION_DATE_MISSING_PRESENT']:[])]
    },
    lineage:lineage(filters)
  };
}


function monthSequence(from,to){
  if(!/^\d{4}-\d{2}$/.test(String(from||''))||!/^\d{4}-\d{2}$/.test(String(to||''))) throw new Error('INVALID_PERIOD_RANGE');
  const [fy,fm]=String(from).split('-').map(Number),[ty,tm]=String(to).split('-').map(Number);
  if(fm<1||fm>12||tm<1||tm>12) throw new Error('INVALID_PERIOD_RANGE');
  const out=[];let y=fy,m=fm;
  while(y<ty||(y===ty&&m<=tm)){out.push(`${y}-${String(m).padStart(2,'0')}`);m++;if(m===13){m=1;y++;}if(out.length>240)throw new Error('PERIOD_RANGE_TOO_LARGE');}
  if(!out.length) throw new Error('INVALID_PERIOD_RANGE');
  return out;
}

async function observeRvmQuantitative(input,measure){
  const filters={...(input.filters??{})};
  if(input.period!=null){
    if(filters.date_from!=null||filters.date_to!=null) throw new Error('RVM_PERIOD_DATE_CONFLICT');
    const b=periodBounds(input.period);filters.date_from=b.from;filters.date_to=b.to;
  }
  const normalized=await resolveUniverse({filters},input.period??null),w=where(normalized),sourceN=await sourceSize(normalized);
  const [row={}]=await azureQuery(`SELECT count(*)::bigint AS row_count, coalesce(sum(cantidad),0)::bigint AS units FROM rvm_raw ${w.sql}`,w.params);
  const rowCount=Number(row.row_count??0),units=Number(row.units??0);
  const contract={source:DATA_SOURCE,certifier_version:CERTIFIER_VERSION,shape:'QUANTITATIVE_OBSERVATION',measure:measure.id,period:input.period??null,filters:normalized};
  return {
    evidence_id:evidenceId(contract),evidence_contract:'p1.quantitative_observation',evidence_version:'0.1.0',
    authority:'P1_CERTIFIED',status:'CERTIFIED',source:DATA_SOURCE,operation:'OBSERVE',
    grain:'FILTERED_RVM_REGISTRATION_UNIVERSE',measure:{id:measure.id,unit:measure.unit,aggregation:measure.aggregation},
    universe:{data_status:normalized.data_status,snapshot_date:normalized.snapshot_date??null,cutoff:normalized.data_status==='PRELIMINARY'?(normalized.snapshot_date??null):(input.period?periodBounds(input.period).to:null)},
    dimensions:dimensions(normalized),
    temporal:{period_identity:input.period??null,date_from:normalized.date_from??null,date_to:normalized.date_to??null,cutoff:normalized.data_status==='PRELIMINARY'?(normalized.snapshot_date??null):(input.period?periodBounds(input.period).to:null),date_semantics:'rvm_raw.fecha'},
    coverage:{source_n:sourceN,filtered_n:rowCount,units},payload:{value:units},
    lineage:{...lineage(normalized),certifier:'rvmCertifier',certifier_version:CERTIFIER_VERSION,source_dataset:'rvm_raw',source_filters:normalized},
  };
}

async function observeRvmPeriodSeries(input,measure){
  const from=String(input.period_from??''),to=String(input.period_to??''),periods=monthSequence(from,to);
  const baseFilters={...(input.filters??{})};
  delete baseFilters.date_from;delete baseFilters.date_to;delete baseFilters.period;
  const observations=[];
  for(const period of periods){
    const observed=await observeRvmQuantitative({measure:measure.id,period,filters:baseFilters},measure);
    observations.push({period_identity:period,value:observed.payload.value,evidence_id:observed.evidence_id});
  }
  const normalized=normalize({filters:baseFilters}).filters;
  const contract={source:DATA_SOURCE,certifier_version:CERTIFIER_VERSION,shape:'PERIOD_OBSERVATION_SERIES',measure:measure.id,period_from:from,period_to:to,filters:normalized};
  return {
    evidence_id:evidenceId(contract),evidence_contract:'p1.period_observation_series',evidence_version:'0.1.0',
    authority:'P1_CERTIFIED',status:'CERTIFIED',source:DATA_SOURCE,operation:'OBSERVE',
    grain:'CALENDAR_MONTH',measure:{id:measure.id,unit:measure.unit,aggregation:measure.aggregation},
    universe:{data_status:normalized.data_status,snapshot_date:normalized.snapshot_date??null},
    dimensions:dimensions(normalized),
    temporal:{period_type:'CALENDAR_MONTH',period_from:from,period_to:to,ordering:'ASCENDING',date_semantics:'rvm_raw.fecha'},
    coverage:{requested_periods:periods.length,observed_periods:observations.length,gaps:[]},
    payload:{observations},
    lineage:{...lineage(normalized),certifier:'rvmCertifier',certifier_version:CERTIFIER_VERSION,source_dataset:'rvm_raw',source_filters:normalized,component_evidence_ids:observations.map(x=>x.evidence_id)},
  };
}

async function observeRvmDimensional(input,measure){
  const dimension=String(input.dimension??'').toUpperCase();
  const axes=DIMENSION_GROUPS[dimension];
  if(!axes) throw new Error('UNSUPPORTED_RVM_DIMENSIONAL_DATASET_DIMENSION: '+dimension);
  const filters={...(input.filters??{})};
  if(input.period!=null){
    if(filters.date_from!=null||filters.date_to!=null) throw new Error('RVM_PERIOD_DATE_CONFLICT');
    const b=periodBounds(input.period);filters.date_from=b.from;filters.date_to=b.to;
  }
  const normalized=await resolveUniverse({filters},input.period??null),w=where(normalized),sourceN=await sourceSize(normalized);
  const single=axes.length===1;
  const expressions=axes.map(axis=>axis==='REGION'?canonicalRegionSql('region'):`upper(btrim(${DIMENSION_COLUMNS[axis]}))`);
  const idKey=axis=>single?'member_id':axis.toLowerCase()+'_id';
  const labelKey=axis=>single?'member_label':axis.toLowerCase()+'_label';
  const selections=axes.map((axis,i)=>{
    const label=axis==='REGION'?"regexp_replace(btrim(region), '\\s+', ' ', 'g')":`btrim(${DIMENSION_COLUMNS[axis]})`;
    return `${expressions[i]} AS ${idKey(axis)}, min(${label}) AS ${labelKey(axis)}`;
  });
  const rows=await azureQuery(`
    SELECT ${selections.join(',\n      ')},
      count(*)::bigint AS row_count,
      coalesce(sum(cantidad),0)::bigint AS units
    FROM rvm_raw ${w.sql}
    GROUP BY ${expressions.join(', ')}
    ORDER BY units DESC, ${axes.map(idKey).join(', ')}
  `,w.params);
  const members=rows.map(row=>({
    member_id:single?(row.member_id??'UNRESOLVED'):JSON.stringify(axes.map(axis=>row[idKey(axis)]??null)),
    member_label:single?(row.member_label??'UNRESOLVED'):axes.map(axis=>row[labelKey(axis)]??'UNRESOLVED').join(' / '),
    value:Number(row.units??0),
    row_count:Number(row.row_count??0),
    ...(!single?{dimensions:Object.fromEntries(axes.map(axis=>[axis.toLowerCase(),row[idKey(axis)]??null]))}:{})
  }));
  const total=members.reduce((sum,row)=>sum+row.value,0);
  const contract={source:DATA_SOURCE,certifier_version:CERTIFIER_VERSION,shape:'DIMENSIONAL_QUANTITATIVE_DATASET',measure:measure.id,dimension,period:input.period??null,filters:normalized};
  return {
    evidence_id:evidenceId(contract),evidence_contract:'p1.dimensional_quantitative_dataset',evidence_version:'0.1.0',
    authority:'P1_CERTIFIED',status:'CERTIFIED',source:DATA_SOURCE,operation:'OBSERVE',
    grain:'RVM_'+dimension,measure:{id:measure.id,unit:measure.unit,aggregation:measure.aggregation},
    universe:{data_status:normalized.data_status,snapshot_date:normalized.snapshot_date??null,cutoff:normalized.data_status==='PRELIMINARY'?(normalized.snapshot_date??null):(input.period?periodBounds(input.period).to:null)},
    dimensions:{...dimensions(normalized),breakdown:dimension},
    temporal:{period_identity:input.period??null,date_from:normalized.date_from??null,date_to:normalized.date_to??null,cutoff:normalized.data_status==='PRELIMINARY'?(normalized.snapshot_date??null):(input.period?periodBounds(input.period).to:null),date_semantics:'rvm_raw.fecha'},
    coverage:{source_n:sourceN,member_count:members.length,units:total},
    payload:{dimension,members,total},
    lineage:{...lineage(normalized),certifier:'rvmCertifier',certifier_version:CERTIFIER_VERSION,source_dataset:'rvm_raw',source_filters:normalized,...(dimension==='REGION'?{region_identity:'UPPER_COLLAPSED_WHITESPACE'}:{dimensional_identity:'RAW_UPPER_TRIM'})}
  };
}

export async function observeRvmEvidence(input={}){
  const measureId=String(input.measure??'RVM_UNITS').toUpperCase(),measure=MEASURES[measureId];
  if(!measure) throw new Error('UNSUPPORTED_RVM_MEASURE: '+measureId);
  const shape=String(input.evidence_shape??'QUANTITATIVE_OBSERVATION').toUpperCase();
  if(shape==='QUANTITATIVE_OBSERVATION') return observeRvmQuantitative(input,measure);
  if(shape==='PERIOD_OBSERVATION_SERIES') return observeRvmPeriodSeries(input,measure);
  if(shape==='DIMENSIONAL_QUANTITATIVE_DATASET') return observeRvmDimensional(input,measure);
  throw new Error('UNSUPPORTED_EVIDENCE_SHAPE: '+shape);
}

