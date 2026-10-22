// Invalidation only. All commercial output still comes from the existing MCP
// contracts. Reuse P1's captured preparation and field mapping to fingerprint
// the actual SALES slice, including LAST recognition at each historical cutoff.
import { prepareSalesInput } from '../data-floor/sales/preparation.js';
import { field, match } from '../data-floor/sales/dataset.js';
import { FIELDS } from '../data-floor/sales/contract.js';
import { NETWORKS } from './projection.js';
import { digest, bundleKey, periodsFor, sourceCutoffs } from './incremental.js';

const identityTables=['sucursales_master','dealers_master','dealer_groups','dealer_aliases',
  'sucursal_aliases','producto_aliases_v01','marcas_master_v01','modelos_master_v01',
  'versiones_master_v01','personas_master','persona_aliases','persona_roles','persona_sucursal'];
export async function captureDependencies(client,{year,cutoffs,engine}) {
  const periods=periodsFor(year,cutoffs);
  const prepared=await prepareSalesInput();
  const identities={};
  for(const table of identityTables){
    const {rows:[r]}=await client.query(`SELECT count(*)::int n,md5(coalesce(string_agg(h,'' ORDER BY h),'')) hash FROM (SELECT md5(t::text) h FROM public.${table} t) q`);
    identities[table]=r;
  }
  const {rows:[definition]}=await client.query("SELECT pg_get_viewdef('public.forum_funnel_universe_v01'::regclass,true) definition");
  const identity=digest({identities,definition});
  const maps={};
  for(const [key,query] of Object.entries({brands:'SELECT marca_id::text id,nombre_canonico label FROM marcas_master_v01',groups:'SELECT dealer_group_id::text id,nombre_canonico label FROM dealer_groups',models:'SELECT modelo_id::text id,nombre_canonico label FROM modelos_master_v01',sellers:'SELECT persona_id::text id,nombre_canonico label FROM personas_master'}))maps[key]=Object.fromEntries((await client.query(query)).rows.map(r=>[r.id,r.label]));
  const customerRows=(await client.query(`SELECT DISTINCT ON(upper(btrim(vin_chasis))) upper(btrim(vin_chasis)) vin,rut FROM vehiculos_raw WHERE nullif(btrim(vin_chasis),'') IS NOT NULL ORDER BY upper(btrim(vin_chasis)),fecha_factura DESC NULLS LAST`)).rows;
  const customers=new Map(customerRows.map(r=>[r.vin,r.rut]));
  // Hash only inputs used by dated FORUM measures, excluding ingestion timestamps
  // and repeated snapshot evidence counts. This SELECT computes no KPI.
  const forumRows=(await client.query(`SELECT numero_operacion,fecha_cotizacion::text,fecha_curse::text,
    estado_actual,has_curse_evidence,ufi_curse,distribuidor,sucursal,modelo_vehiculo,version_vehiculo
    FROM public.forum_funnel_universe_v01 ORDER BY numero_operacion`)).rows;
  const forum_signatures={};
  for(const period of periods){
    const cutoff=sourceCutoffs(period,cutoffs).forum;
    const inputs=forumRows.filter(r=>[r.fecha_cotizacion,r.fecha_curse].some(d=>d?.startsWith(period+'-')&&d<=cutoff));
    forum_signatures[period]=digest({identity,inputs,cutoff});
  }
  const sales_signatures={}, sales_facts={};
  for(const network of NETWORKS)for(const period of periods){
    const cutoff=sourceCutoffs(period,cutoffs).sales;
    const certified=prepared.recognize({commercial_universe:network,cutoff_date:cutoff});
    if(!certified.u.validation.valid)throw new Error('SALES_INVALIDATION_NOT_CERTIFIED');
    const facts=certified.base.filter(row=>match(row,'date_from',year+'-01-01'));
    const rows=facts.map(row=>Object.fromEntries(FIELDS.map(k=>[k,field(row,k)])));
    const key=bundleKey({network,period});
    sales_facts[key]=rows;
    sales_signatures[key]=digest({identity,cutoff,rows,network:facts.map(row=>certified.network(row)),
      validation:certified.u.validation,warnings:certified.u.warnings,metadata:rows.map(r=>[r.vin,customers.get(r.vin)||''])});
  }
  const guard=digest({prepared:prepared.content_fingerprint,identities,definition,forumRows,customerRows,cutoffs,engine});
  return {engine,year,cutoffs,periods,maps,customers,sales_signatures,forum_signatures,sales_facts,guard};
}
