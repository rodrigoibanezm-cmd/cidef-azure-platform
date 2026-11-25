/** Explicit evidence selection is a transport adapter, not a commercial engine.
 * The owning source supplies exceptional request schemas only where its existing
 * default declarative resolver cannot select the advertised shape.
 */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const own = (obj, key) => Object.hasOwn(obj, key);
const object = value => value != null && typeof value === 'object' && !Array.isArray(value);
const scalar = value => (typeof value === 'string' && value.trim() !== '') || Number.isSafeInteger(value);
const actualDate = value => typeof value === 'string' && DATE.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;

export function describeEvidenceRequests(contract, explicit = {}) {
  return Object.fromEntries((contract.evidence_shapes ?? []).map(shape => [shape,
    explicit[shape] ?? {route:'DECLARATIVE', request:{evidence_shape:shape},
      constraints:'Use source measure, time, filters and group_by as described. Requested shape must match the result.'}]));
}

// Several domains use uppercase legacy evidence_contract identifiers. Those
// identify the factual envelope, not necessarily the request shape.
export function evidenceMatchesShape(evidence, shape) {
  const actual = String(evidence?.evidence_contract ?? '').toUpperCase().replace(/^P1[._]/,'');
  if (actual === shape || actual === 'SQL_FIRST_PARTIAL_' + shape) return true;
  return actual === 'FACTUAL_OBSERVATION' &&
    ['QUANTITATIVE_OBSERVATION','CUMULATIVE_PERIOD_OBSERVATION'].includes(shape);
}

export async function resolveEvidenceRequest(contract, handlers, request, runId) {
  const {evidence_shape:shape, ...base} = request;
  if (!contract.evidence_shapes?.includes(shape)) throw new Error('UNSUPPORTED_EVIDENCE_SHAPE: '+shape);
  const special = handlers.explicit?.[shape];
  if (!special) {
    const evidence = await handlers.resolveObservation(base, runId);
    if (!evidenceMatchesShape(evidence, shape)) throw new Error('REQUESTED_EVIDENCE_SHAPE_NOT_AVAILABLE: '+shape);
    return evidence;
  }
  const {time={},filters={},group_by=[],measure:identifier}=base;
  if (!object(time)||!object(filters)||!Array.isArray(group_by)||group_by.length)
    throw new Error('INVALID_EVIDENCE_REQUEST');
  const measure=String(identifier??'').toUpperCase().replace(new RegExp('^'+contract.source+'\\.'),'');
  const measures=Array.isArray(contract.measures)?contract.measures.map(m=>m.id):Object.keys(contract.measures??{});
  if (!measures.includes(measure)) throw new Error('UNSUPPORTED_EVIDENCE_MEASURE: '+measure);
  if (Object.keys(time).some(k=>!own(special.time,k)) ||
      Object.entries(special.time).some(([k,rule])=>rule.required && time[k]==null))
    throw new Error('INVALID_EVIDENCE_TIME');
  for(const [key,value] of Object.entries(time)){
    const type=special.time[key].type;
    if ((type==='MONTH' && (typeof value!=='string'||!MONTH.test(value))) ||
        (type==='DATE' && !actualDate(value))) throw new Error('INVALID_EVIDENCE_TIME: '+key);
  }
  if (Object.keys(filters).some(k=>!own(special.filters,k))) throw new Error('UNSUPPORTED_EVIDENCE_FILTER');
  for(const [key,rule] of Object.entries(special.filters)){
    const value=filters[key];
    if ((rule.required && value==null) || (value!=null && (!scalar(value) ||
        (rule.values && !rule.values.includes(value))))) throw new Error('INVALID_EVIDENCE_FILTER: '+key);
  }
  if (time.period && time.cutoff && time.cutoff.slice(0,7)!==time.period) throw new Error('CUTOFF_OUTSIDE_PERIOD');
  const input={measure,evidence_shape:shape,filters,
    ...Object.fromEntries(Object.entries(time).map(([k,v])=>[special.time[k].argument??k,v]))};
  const evidence=await handlers.observe(input);
  if (!evidenceMatchesShape(evidence,shape)) throw new Error('REQUESTED_EVIDENCE_SHAPE_NOT_AVAILABLE: '+shape);
  return evidence;
}
