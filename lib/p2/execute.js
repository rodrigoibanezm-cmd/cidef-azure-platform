import { randomUUID } from 'node:crypto';
import { resolveP2Unit } from './registry.js';
export async function executeP2({run_id,unit_id,contract_version=null,evidence={},parameters={}}={}){
  const execution_id=randomUUID();
  try{
    const unit=resolveP2Unit(unit_id,contract_version);
    const result=await unit.executor.execute({evidence,parameters});
    return {status:'EXECUTED',result,limitations:unit.semantic_contract.does_not_support,lineage:{run_id,execution_id,unit_id:unit.unit_id,contract_version:unit.contract_version,executor_id:unit.executor.executor_id,executor_version:unit.executor.executor_version,evidence_refs:Object.entries(evidence).map(([slot,e])=>({slot,evidence_id:e?.evidence_id,evidence_contract:e?.evidence_contract,evidence_version:e?.evidence_version})),parameters,executed_at:new Date().toISOString()}};
  }catch(error){return {status:'INVALID_EXECUTION',error:{code:['INVALID_EVIDENCE','INCOMPATIBLE_EVIDENCE','INVALID_PARAMETERS','INVARIANT_VIOLATION','UNSUPPORTED_GRAIN','EXECUTION_ERROR'].includes(error.code)?error.code:'EXECUTION_ERROR',message:error.message,details:error.details??{}}};}
}
