import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFechaFactura } from '../lib/ventas/parseFechaFactura.js';
import { monthCandidateDatePattern, planSalesCandidates } from '../scripts/semantic-sales-prototype.mjs';
import { createSalesFactSet } from '../lib/data-floor/sales/factSet.js';
import { observeSalesSelection } from '../lib/data-floor/sales/operations.js';

test('every P1-accepted monthly date is included in SQL candidate date predicate',()=>{
  for(let year=2024;year<=2026;year++)for(let month=1;month<=12;month++){
    const postgresRegex=monthCandidateDatePattern(year,month)
      .replaceAll('[[:space:]]','\\s');
    const regex=new RegExp(postgresRegex);
    const mm=String(month).padStart(2,'0');
    for(const day of [1,9,15,28]){
      const dd=String(day).padStart(2,'0');
      const candidates=[
        `${year}-${mm}-${dd}`,
        `${year}-${mm}-${dd} 09:25:31`,
        `${month}/${day}/${year}`,
        `${mm}/${dd}/${String(year).slice(-2)}`,
        `  ${month}/${day}/${year} 12:30 `,
      ];
      for(const raw of candidates){
        const parsed=parseFechaFactura(raw);
        assert.equal(parsed?.month,`${year}-${mm}`,raw);
        assert.ok(regex.test(raw.trim()),raw);
      }
    }
  }
  // P1 parses 8/9 as August 9, not September 8.
  assert.match('8/9/2026',new RegExp(monthCandidateDatePattern(2026,8).replaceAll('[[:space:]]','\\s')));
  assert.doesNotMatch('8/9/2026',new RegExp(monthCandidateDatePattern(2026,9).replaceAll('[[:space:]]','\\s')));
});

test('candidate SQL cannot push down identities resolved only after P1 recognition',()=>{
  const source=readFileSync(new URL('../scripts/semantic-sales-prototype.mjs',import.meta.url),'utf8');
  const conditions=source.slice(source.indexOf('export function buildSalesCandidateVinSql('),source.indexOf('export async function semanticSalesCandidates('));
  assert.doesNotMatch(conditions,/productPredicate|store_id|dealer_id|seller_id|marca_id|modelo_id/);
  assert.match(conditions,/categoria_cliente/);
  assert.match(conditions,/fecha_factura/);
  assert.ok(planSalesCandidates({
    commercial_universe:'OWN_STORES',date_from:'2026-08-01',date_to:'2026-08-31',
    brand_id:89,model_id:28,store_id:4,seller_id:232,
  },'2026-08-31'));
});

test('VIN candidate readers retain every non-VIN sale and related SKU evidence',()=>{
  const sales=readFileSync(new URL('../lib/ventas/loadVentasRows.js',import.meta.url),'utf8');
  const sku=readFileSync(new URL('../lib/product-model-resolution/loadSkuEvidence.js',import.meta.url),'utf8');
  assert.ok(sales.includes("OR nullif(btrim(nro_vin_chasis),'') IS NULL"));
  assert.ok(sku.includes("OR nullif(btrim(nro_vin_chasis),'') IS NULL"));
});

test('candidate VINs and sales source rows come from one PostgreSQL snapshot',()=>{
  const code=readFileSync(new URL('../lib/data-floor/sales/preparation.js',import.meta.url),'utf8');
  assert.match(code,/WITH candidate_vins AS MATERIALIZED/);
  assert.match(code,/VENTAS_CONTEXT_SELECT/);
  assert.match(code,/sourceRows=await queryDb/);
  assert.match(code,/sourceRows,\s*timings:diagnostic_timings/);
  const planner=readFileSync(new URL('../scripts/semantic-sales-prototype.mjs',import.meta.url),'utf8');
  assert.match(planner,/export function buildSalesCandidateVinSql/);
  assert.match(planner,/const \{sql,params\}=buildSalesCandidateVinSql\(plan\)/);
});

test('scope-certified evidence is P1-certified but never claims full-source coverage',()=>{
  const filters={commercial_universe:'OWN_STORES',date_from:'2026-08-01',
    date_to:'2026-08-31',brand_id:89,model_id:28,store_id:4};
  const fixture={
    commercial_universe:'OWN_STORES',cutoff_date:'2026-08-31',
    effective_cutoff_date:'2026-08-31',network:()=> 'TIENDA_PROPIA',
    base:[{source_id:1,vin:'VIN',fecha_venta_iso:'2026-08-10T00:00:00.000Z',
      marca_id:89,modelo_id:28,certified_store_id:4}],
    u:{lineage:{},coverage:{},validation:{valid:true},
      resolution_resources:{model_catalog:[]}},
  };
  const preparation={preparation_id:'test',content_fingerprint:'test'};
  const partial=createSalesFactSet(fixture,preparation,filters);
  const scoped=createSalesFactSet(fixture,preparation,filters,true);
  const p=observeSalesSelection(partial.select(filters));
  const c=observeSalesSelection(scoped.select(filters));
  assert.equal(p.authority,'P1_PARTIAL_SOURCE');
  assert.equal(p.status,'PARTIAL_SOURCE');
  assert.equal(c.authority,'P1_CERTIFIED');
  assert.equal(c.status,'CERTIFIED');
  assert.equal(c.coverage.source_scope,'SCOPED_CERTIFIED');
  assert.equal(c.lineage.scope_certification,'SQL_FIRST_MONTHLY_SOURCE_SUPERSET_V1');
  assert.equal(c.payload.value,p.payload.value);
  assert.throws(()=>scoped.select({...filters,store_id:5}),/SALES_PARTIAL_SOURCE_FILTER_MISMATCH/);
});
