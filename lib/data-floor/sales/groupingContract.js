import { z } from 'zod';
import { DIMENSIONS, CERTIFIER_VERSION } from './contract.js';

// Internal only. Existing discovery, MCP schemas and single-axis contracts
// are deliberately untouched. Dimension order is the requested tuple order.
export const SALES_GROUPING_VERSION='0.1.0';
export const SALES_BRAND_DIMENSION=Object.freeze({field:'brand_id',identity_contract:'marcas_master_v01',identity_version:'0.1'});
const ids=['BRAND',...Object.keys(DIMENSIONS)];
const dimension=z.object({id:z.enum(ids),identity_contract:z.string(),identity_version:z.literal('0.1'),unresolved_member_policy:z.literal('EXPLICIT_UNRESOLVED_MEMBER')}).strict();
const member=z.object({member_id:z.string(),member_label:z.string().nullable(),value:z.number().int().nonnegative()}).strict();
const tupleMember=z.object({dimension:z.enum(ids),member_id:z.string(),member_label:z.string().nullable()}).strict();
const coverage=z.object({source_n:z.number().int().nonnegative(),filtered_n:z.number().int().nonnegative(),
  quality:z.object({coverage:z.record(z.unknown()).nullable(),validation:z.record(z.unknown()).nullable(),warnings:z.array(z.string())}).strict(),
  dimension_resolved_n:z.number().int().nonnegative(),dimension_unresolved_n:z.number().int().nonnegative(),dimension_resolution_rate:z.number().min(0).max(1).nullable(),
}).strict();
export const salesGroupingEvidenceSchema=z.object({
  evidence_id:z.string().regex(/^p1\.sales\.[a-f0-9]{24}$/),
  evidence_contract:z.enum(['p1.dimensional_quantitative_dataset','p1.multidimensional_quantitative_dataset']),
  evidence_version:z.literal(SALES_GROUPING_VERSION),authority:z.literal('P1_CERTIFIED'),status:z.literal('CERTIFIED'),source:z.literal('SALES'),operation:z.literal('OBSERVE'),grain:z.literal('FILTERED_SALES_UNIVERSE'),
  measure:z.object({id:z.literal('VIN_SALES'),unit:z.literal('VIN'),aggregation:z.literal('COUNT_RECOGNIZED_SALE')}).strict(),
  universe:z.object({commercial_universe:z.enum(['COMPANY','OWN_STORES','DEALERS'])}).strict(),dimensions:z.record(z.unknown()),
  temporal:z.object({date_from:z.string().nullable(),date_to:z.string().nullable(),date_semantics:z.literal('fecha_factura'),period_identity:z.string().nullable(),period_type:z.literal('COMMERCIAL_MONTH').nullable(),cutoff:z.string().nullable(),cutoff_resolution:z.string().nullable()}).strict(),
  coverage,
  lineage:z.object({recognition:z.string(),commercial_scope:z.string(),commercial_authority:z.string(),product_identity:z.string(),organizational_identity:z.string(),seller_membership:z.string(),
    certifier:z.literal('salesCertifier'),certifier_version:z.literal(CERTIFIER_VERSION),source_dataset:z.literal('SALES_WORK'),source_filters:z.record(z.unknown()),
    grouping_contract_version:z.literal(SALES_GROUPING_VERSION),fact_set_fingerprint:z.string().regex(/^sha256:[a-f0-9]{64}$/),selection_fingerprint:z.string().regex(/^sha256:[a-f0-9]{64}$/),
    dimension_identity:z.string().optional(),dimension_identities:z.record(z.string()).optional(),
  }).passthrough(),
  payload:z.union([
    z.object({dimension:dimension.extend({id:z.enum(['BRAND','DEALER_GROUP'])}),members:z.array(member)}).strict(),
    z.object({dimensions:z.array(dimension).min(2),members:z.array(z.object({members:z.array(tupleMember).min(2),value:z.number().int().nonnegative()}).strict())}).strict(),
  ]),
}).strict().superRefine((out,ctx)=>{
  const dims='dimension' in out.payload?[out.payload.dimension]:out.payload.dimensions;
  const multi=dims.length>1;
  const error=message=>ctx.addIssue({code:z.ZodIssueCode.custom,message});
  if(out.evidence_contract!==('p1.'+(multi?'multidimensional_quantitative_dataset':'dimensional_quantitative_dataset')))error('shape/contract mismatch');
  if(new Set(dims.map(d=>d.id)).size!==dims.length)error('duplicate dimension');
  for(const d of dims){const config=d.id==='BRAND'?SALES_BRAND_DIMENSION:DIMENSIONS[d.id];if(d.identity_contract!==config.identity_contract)error('dimension identity mismatch');}
  if(multi){for(const d of dims)if(out.lineage.dimension_identities?.[d.id]!==d.identity_contract)error('dimension lineage mismatch');}
  else if(out.lineage.dimension_identity!==dims[0].identity_contract)error('dimension lineage mismatch');
  let total=0,unresolved=0;const seen=new Set();let previous=null;
  for(const row of out.payload.members){
    const tuple=multi?row.members:[{dimension:dims[0].id,member_id:row.member_id,member_label:row.member_label}];
    if(tuple.length!==dims.length||tuple.some((v,i)=>v.dimension!==dims[i]?.id))error('tuple dimension mismatch');
    const key=JSON.stringify(tuple.map(v=>v.member_id));if(seen.has(key))error('duplicate member');seen.add(key);
    if(previous&&compareSalesGroupingTuples(previous,tuple)>0)error('member ordering mismatch');previous=tuple;
    if(tuple.some(v=>v.member_id==='UNRESOLVED'))unresolved+=row.value;
    for(const v of tuple){
      if(v.member_id==='UNRESOLVED'&&v.member_label!=='No resuelto')error('unresolved policy mismatch');
      if(v.dimension==='NETWORK'&&(!['TIENDA_PROPIA','DEALER','UNRESOLVED'].includes(v.member_id)||(v.member_id!=='UNRESOLVED'&&v.member_label!==v.member_id)))error('NETWORK member policy mismatch');
    }
    total+=row.value;
  }
  const c=out.coverage;
  if(total!==c.filtered_n||unresolved!==c.dimension_unresolved_n||c.dimension_resolved_n+c.dimension_unresolved_n!==c.filtered_n||c.source_n<c.filtered_n)error('coverage reconciliation mismatch');
  if(c.dimension_resolution_rate!==(c.filtered_n?c.dimension_resolved_n/c.filtered_n:null))error('resolution rate mismatch');
});

// Numeric canonical ids first compare numerically; other ids use code units,
// with explicit UNRESOLVED last. No host locale participates in this contract.
export function compareSalesGroupingTuples(a,b){
  for(let i=0;i<a.length;i++){
    const x=a[i]?.member_id??'UNRESOLVED',y=b[i]?.member_id??'UNRESOLVED';
    if(x===y)continue;if(x==='UNRESOLVED')return 1;if(y==='UNRESOLVED')return -1;
    if(/^\d+$/.test(x)&&/^\d+$/.test(y)&&BigInt(x)!==BigInt(y))return BigInt(x)<BigInt(y)?-1:1;
    return x<y?-1:1;
  }
  return 0;
}
