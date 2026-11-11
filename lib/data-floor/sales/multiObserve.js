import { commercialDateForDay, commercialMonthForDate } from '../../ventas/commercialMonth.js';
import { getSalesRunFactSet } from './preparation.js';
import { observeSalesSelection } from './operations.js';
import { FILTERS } from './contract.js';
import { unsupportedSalesIdentifier } from './errors.js';

const KINDS=Object.freeze(['TOTAL','STORE','STORE_FINANCIAL_ENTITY','BRAND','BRAND_NETWORK','MODEL_NETWORK_BY_BRAND','OBSERVE']);
export const SALES_BATCH_FILTERS=Object.freeze(FILTERS.filter(key=>!['commercial_universe','date_from','date_to'].includes(key)));

function normalizeOperation(operation,index){
  const kind=String(operation?.kind??'').trim().toUpperCase();
  if(!KINDS.includes(kind))throw new Error('UNSUPPORTED_SALES_MULTI_OPERATION: '+kind+'; allowed: '+KINDS.join(', '));
  if(kind==='MODEL_NETWORK_BY_BRAND'&&(operation?.brand_id==null||String(operation.brand_id).trim()===''))
    throw new Error('BRAND_ID_REQUIRED_FOR_MODEL_NETWORK');
  if(kind!=='MODEL_NETWORK_BY_BRAND'&&operation?.brand_id!=null)
    throw new Error('BRAND_ID_NOT_ALLOWED_FOR_OPERATION: '+kind);
  if(kind==='OBSERVE'){
    const {filters={},group_by=[]}=operation;
    const unsupported=Object.keys(filters).find(key=>!SALES_BATCH_FILTERS.includes(key));
    if(unsupported)throw unsupportedSalesIdentifier('FILTER',unsupported,SALES_BATCH_FILTERS);
    return Object.freeze({index,kind,filters,group_by});
  }
  return Object.freeze({index,kind,...(kind==='MODEL_NETWORK_BY_BRAND'?{brand_id:operation.brand_id}:{})});
}

export async function observeSalesMany({run_id,period,cutoff,commercial_universe='COMPANY',operations=[]}={}){
  const month=String(period??'');
  const end=String(cutoff??'').slice(0,10);
  if(!/^\d{4}-\d{2}$/.test(month))throw new Error('PERIOD_REQUIRED');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(end))throw new Error('EXPLICIT_CUTOFF_REQUIRED');
  if(commercialMonthForDate(end)!==month)throw new Error('CUTOFF_OUTSIDE_PERIOD');
  if(!Array.isArray(operations)||operations.length===0)throw new Error('SALES_MULTI_OPERATIONS_REQUIRED');
  const normalized=operations.map(normalizeOperation);

  const {factSet,preparations,recognitions}=await getSalesRunFactSet(run_id,{commercial_universe,cutoff_date:end});
  const baseFilters={commercial_universe,date_from:commercialDateForDay(month,1),date_to:end};
  const selections=new Map();
  const select=(filters)=>{
    const key=JSON.stringify(filters);
    if(!selections.has(key))selections.set(key,factSet.select(filters));
    return selections.get(key);
  };

  const results=normalized.map(operation=>{
    let filters=baseFilters,group_by=[];
    if(operation.kind==='OBSERVE'){
      filters={...baseFilters,...operation.filters};
      group_by=operation.group_by;
    }
    if(operation.kind==='STORE')group_by=['STORE'];
    if(operation.kind==='STORE_FINANCIAL_ENTITY')group_by=['STORE','FINANCIAL_ENTITY'];
    if(operation.kind==='BRAND')group_by=['BRAND'];
    if(operation.kind==='BRAND_NETWORK')group_by=['BRAND','NETWORK'];
    if(operation.kind==='MODEL_NETWORK_BY_BRAND'){
      filters={...baseFilters,brand_id:operation.brand_id};
      group_by=['MODEL','NETWORK'];
    }
    const selection=select(filters);
    const evidence=observeSalesSelection(selection,{measure:'VIN_SALES',group_by,period:group_by.length?month:null,cutoff_resolution:'EXPLICIT'});
    return Object.freeze({operation,evidence});
  });

  return Object.freeze({
    source:'SALES',period:month,cutoff:end,commercial_universe:factSet.ref.commercial_universe,
    results:Object.freeze(results),
    execution:Object.freeze({
      preparations,recognitions,enrichments:recognitions,fact_sets:recognitions,
      selections:selections.size,operations:results.length,
      fact_set_fingerprint:factSet.ref.fingerprint,
    }),
  });
}
