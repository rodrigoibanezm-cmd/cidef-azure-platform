export function invalid(code,message,details={}){const e=new Error(message);e.code=code;e.details=details;return e;}
export function assertP1(e,slot){
  if(!e||e.authority!=='P1_CERTIFIED') throw invalid('INVALID_EVIDENCE',slot+' must have authority P1_CERTIFIED');
  if(!e.evidence_id||!e.evidence_contract||!e.evidence_version||!e.lineage) throw invalid('INVALID_EVIDENCE',slot+' lacks certified evidence identity/lineage');
}
export function finite(v,label){if(typeof v!=='number'||!Number.isFinite(v))throw invalid('INVALID_EVIDENCE',label+' must be a finite number');}
export function same(a,b,key,label=key){if(JSON.stringify(a?.[key]??null)!==JSON.stringify(b?.[key]??null))throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible '+label);}
