import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { NETWORKS, monthEnd } from './projection.js';

export const CACHE_VERSION = 'forum.incremental.v1';
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export const bundleKey = row => row.network + ':' + row.period;
// Only volatile evidence/provenance is removed. Every business value, member,
// identity, cutoff, quality flag and dimension remains in the comparison.
const volatile = new Set(['evidence_id','run_id','source_signature','refresh','execution',
  'preparation_id','preparation_content_fingerprint','fact_set_fingerprint','fingerprint',
  'content_fingerprint','component_evidence_ids']);
export function commercialValue(value) {
  if (Array.isArray(value)) return value.map(commercialValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(k=>!volatile.has(k)).sort().map(k=>[k,commercialValue(value[k])]));
  return value;
}
export function assertSnapshotParity(actual, expected) {
  assert.deepEqual(actual.map(r=>({period:r.period,network:r.network,dimension:r.dimension,
    sales_cutoff:r.sales_cutoff,forum_cutoff:r.forum_cutoff,payload:commercialValue(r.payload)})),
  expected.map(r=>({period:r.period,network:r.network,dimension:r.dimension,
    sales_cutoff:r.sales_cutoff,forum_cutoff:r.forum_cutoff,payload:commercialValue(r.payload)})), 'INCREMENTAL_FULL_PARITY_FAILED');
}
export function contentHash(payload) { const {refresh,...rest}=payload; return digest(rest); }
export function validCache(row, engine) {
  const r=row?.payload?.refresh;
  return r?.version===CACHE_VERSION && r.engine===engine && r.content_hash===contentHash(row.payload);
}
export function tagBundle(row, signatures, engine) {
  row.payload.refresh={version:CACHE_VERSION,engine,...signatures,content_hash:contentHash(row.payload)};
  return row;
}
export function signaturesFor(context, network, period) {
  const sales=context.sales_signatures[bundleKey({network,period})];
  const forum=context.forum_signatures[period];
  const prefix=Object.keys(context.forum_signatures).filter(p=>p<=period).sort().map(p=>[p,context.forum_signatures[p]]);
  return {sales_signature:sales,forum_signature:forum,bundle_signature:digest({sales,prefix})};
}
export function planBundle(context, network, period, cached, forceFull=false) {
  const signatures=signaturesFor(context,network,period);
  const valid=!forceFull && validCache(cached,context.engine);
  const old=cached?.payload?.refresh;
  return {signatures,reuse:valid && old.bundle_signature===signatures.bundle_signature,
    sales:!valid || old.sales_signature!==signatures.sales_signature,
    forum:!valid || old.forum_signature!==signatures.forum_signature};
}
export function periodsFor(year,cutoffs) {
  const last=Math.max(Number(cutoffs.sales.slice(5,7)),Number(cutoffs.forum.slice(5,7)));
  return Array.from({length:last},(_,i)=>year+'-'+String(i+1).padStart(2,'0'));
}
export function sourceCutoffs(period,cutoffs) {
  const sales=[monthEnd(period),cutoffs.sales].sort()[0], forum=[monthEnd(period),cutoffs.forum].sort()[0];
  if(sales<period+'-01'||forum<period+'-01')throw new Error('INDEPENDENT_SOURCE_PERIOD_UNAVAILABLE: '+period);
  return {sales,forum};
}
// Hash actual source files, including imported contracts/resolvers, rather than
// assuming a package version changes on every semantic edit. No engine edits.
export async function engineSignature(root = new URL('../../',import.meta.url)) {
  const files=[];
  async function walk(url){ for(const ent of (await readdir(url,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const child=new URL(ent.name+(ent.isDirectory()?'/':''),url);
    if(ent.isDirectory())await walk(child);else if(ent.name.endsWith('.js'))files.push([child.href.slice(root.href.length),await readFile(child,'utf8')]);
  }}
  await walk(new URL('lib/',root));
  files.push(['publisher',await readFile(new URL('scripts/refresh-forum-ventas-snapshot-azure.js',root),'utf8')]);
  return digest(files);
}
export function indexCache(rows) { return new Map(rows.map(row=>[bundleKey(row),row])); }
export function inspectPlan(context, cache, forceFull=false) {
  return NETWORKS.flatMap(network=>context.periods.map(period=>({network,period,...planBundle(context,network,period,cache.get(bundleKey({network,period})),forceFull)})));
}
