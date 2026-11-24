import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFechaFactura } from '../lib/ventas/parseFechaFactura.js';
import { monthCandidateDatePattern, planSalesCandidates } from '../scripts/semantic-sales-prototype.mjs';

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
  const conditions=source.slice(source.indexOf('  const conditions=['),source.indexOf("  const sql='SELECT DISTINCT"));
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
  assert.match(sales,/OR nullif\(btrim\(nro_vin_chasis\),'')/); // replaced below
  assert.match(sku,/OR nullif\(btrim\(nro_vin_chasis\),'')/); // replaced below
});
