import { parseCommercialUniverse } from '../../ventas-commercial/buildVentasCommercialContext.js';
import { normalize, match } from './dataset.js';
import { CERTIFIER_VERSION } from './contract.js';
import { recognizeSalesPreparation } from './recognition.js';
import { freezeSalesValue, salesContentFingerprint, serializeSalesContent } from './capture.js';

// Mirrors match(): OR values are case/space-insensitive string sets; temporal
// bounds are scalar strings. These keys are not evidence hashes or truncated
// identities. Original filters remain available for legacy envelope parity.
export function canonicalSalesFilters(filters){
  return Object.fromEntries(Object.keys(filters).sort().map(key=>[key,
    ['commercial_universe','date_from','date_to'].includes(key)?String(filters[key]):
      [...new Set((Array.isArray(filters[key])?filters[key]:[filters[key]]).map(v=>String(v).trim().toUpperCase()))].sort(),
  ]));
}
function equal(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function narrows(parent,child){
  return Object.entries(parent).every(([key,value])=>{
    if(!(key in child))return false;
    if(equal(value,child[key]))return true;
    if(key==='date_from'||key==='date_to'){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!/^\d{4}-\d{2}-\d{2}$/.test(child[key]))return false;
      return key==='date_from'?child[key]>=value:child[key]<=value;
    }
    return Array.isArray(value)&&child[key].every(v=>value.includes(v));
  });
}

// Recognition/certification is independent of selection and grouping. Each
// instance owns its selections; nothing is retained across HTTP requests.
export function buildSalesFactSet(input,preparation,options={}){
  return createSalesFactSet(recognizeSalesPreparation(input,options),preparation);
}
export function createSalesFactSet(certified,preparation){
  const {u,base,commercial_universe:universe,cutoff_date,cutoff_month,effective_cutoff_date}=certified;
  const fingerprint=salesContentFingerprint({version:'p1.sales.certified_fact_set.v1',u,base,network:base.map(row=>certified.network(row)),certifier_version:CERTIFIER_VERSION});
  const ref=freezeSalesValue({preparation_id:preparation.preparation_id,preparation_content_fingerprint:preparation.content_fingerprint,
    cutoff_date,cutoff_month,effective_cutoff_date,commercial_universe:universe,
    recognition_version:u.recognition_version,universe_version:u.version,certifier_version:CERTIFIER_VERSION,fingerprint});
  const selections=new Map(),equivalentSelections=new Map();
  const factSet={ref,u,base,network:certified.network,
    select(filters={}){
      const q=normalize({filters,commercial_universe:universe});
      if(parseCommercialUniverse(q.commercial_universe)!==universe)throw new Error('SALES_FACT_SET_SCOPE_MISMATCH');
      if(q.filters.date_to!=null&&String(q.filters.date_to)!==effective_cutoff_date)throw new Error('SALES_FACT_SET_CUTOFF_MISMATCH');
      const canonical=canonicalSalesFilters({...q.filters,commercial_universe:universe});
      const key=JSON.stringify(canonical),originalKey=serializeSalesContent(q.filters);
      if(selections.has(originalKey))return selections.get(originalKey);
      const equivalent=equivalentSelections.get(key);
      let parent=equivalent?.parent??null;
      if(!equivalent)for(const selection of equivalentSelections.values()){
        if(narrows(selection.canonical_filters,canonical)&&
           (!parent||Object.keys(selection.canonical_filters).length>Object.keys(parent.canonical_filters).length))parent=selection;
      }
      // Reapply narrowed OR sets/ranges; skip only predicates proven equal.
      const remaining=Object.entries(q.filters).filter(([k])=>!parent||!equal(parent.canonical_filters[k],canonical[k]));
      const facts=equivalent?.facts??Object.freeze((parent?.facts??base).filter(row=>remaining.every(([k,v])=>match(row,k,v))));
      const fingerprint=equivalent?.fingerprint??salesContentFingerprint({fact_set:ref.fingerprint,filters:canonical,facts:facts.map(row=>row.source_id)});
      const selection=Object.freeze({factSet,filters:freezeSalesValue(structuredClone(q.filters)),canonical_filters:freezeSalesValue(canonical),facts,parent,fingerprint});
      selections.set(originalKey,selection);
      if(!equivalent)equivalentSelections.set(key,selection);
      return selection;
    },
  };
  return Object.freeze(factSet);
}
