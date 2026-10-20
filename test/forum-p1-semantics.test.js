import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describeForum } from '../lib/data-floor/forumCertifier.js';

test('P1 FORUM publishes explicit financing semantics',()=>{
  const d=describeForum();
  assert.equal(d.version,'0.12');
  assert.equal(d.measures.UFIS.unit,'VEHICLE_UNIT');
  assert.match(d.measures.UFIS.meaning,/executed credit\/success/i);
  assert.match(d.measures.CURSES.meaning,/operations/i);
  assert.equal(d.measures.PRECURSE.unit,'OPERATION');
  assert.match(d.measures.PRECURSE.meaning,/latest available snapshot/i);
  assert.notEqual(d.measures.PRECURSE.rule,d.measures.APPLICATIONS.rule);
  assert.ok(d.dimensions.includes('STATUS'));
  assert.ok(d.dimensions.includes('CERTIFIED_STAGE'));
  assert.ok(d.dimensions.includes('NETWORK'));
  assert.ok(d.filters.includes('network'));
  assert.ok(d.fields.includes('network'));
  assert.ok(d.semantic_constraints.some(x=>/CIDEF = OWN_STORES/i.test(x)));
  assert.ok(d.semantic_constraints.some(x=>/dealer_aliases.*dealers_master.*dealer_groups/i.test(x)));
  assert.ok(d.semantic_constraints.some(x=>/Never count PRECURSE as UFI/i.test(x)));
  assert.ok(d.semantic_constraints.some(x=>/does not assert VIN identity/i.test(x)));
  assert.match(d.date_semantics.monthly_close,/full calendar month/i);
  assert.match(d.date_semantics.intramonth_comparison,/same cutoff day/i);
  assert.ok(d.semantic_constraints.some(x=>/same-day intramonth comparisons are benchmark context only/i.test(x)));
  assert.ok(d.semantic_constraints.some(x=>/Never compare COHORT_CONVERTED directly with monthly UFIS/i.test(x)));
  assert.ok(d.semantic_constraints.some(x=>/exact certified daily snapshot/i.test(x)));
  assert.ok(d.semantic_constraints.some(x=>/Penetration UFI is a cross-domain business ratio/i.test(x)));
  assert.ok(d.fields.includes('financed_amount'));
  assert.ok(d.fields.includes('contract_number'));
});

test('FORUM universe certifies PRECURSE from the latest snapshot only',()=>{
  const src=fs.readFileSync(new URL('../scripts/install-forum-universe-view.js',import.meta.url),'utf8');
  assert.match(src,/latest_precurse_snapshot AS/);
  assert.match(src,/r[.]snapshot_date = latest[.]snapshot_date/);
  assert.match(src,/WHEN p[.]numero_operacion IS NOT NULL THEN 'PRECURSE'/);
  assert.doesNotMatch(src,/WHEN e[.]has_precurse_evidence THEN 'PRECURSE'/);
  assert.match(src,/CREATE OR REPLACE VIEW public[.]forum_funnel_universe_v01/);
});

test('PRECURSE contract declares supported store and seller identities',()=>{
  const d=describeForum();
  assert.ok(d.dimensions.includes('STORE'));
  assert.ok(d.dimensions.includes('SELLER'));
  assert.ok(d.semantic_constraints.some(x=>/PRECURSE.*BRAND.*STORE.*SELLER/.test(x)));
});

test('P1 FORUM UFI executor never promotes Precurse to UFI',()=>{
  const src=fs.readFileSync(new URL('../lib/data-floor/forum/observations.js',import.meta.url),'utf8');
  assert.doesNotMatch(src,/OPEN_MONTH_CURSE_PLUS_OUTSTANDING_PRECURSE/);
  assert.match(src,/CURSE_VEHICLE_UNITS_BY_FECHA_CURSE/);
});


test('P1 FORUM scalar cohort measures keep quotation-cohort semantics distinct from UFIS',()=>{
  const src=fs.readFileSync(new URL('../lib/data-floor/forum/observations.js',import.meta.url),'utf8');
  assert.match(src,/measure==='UFIS'/);
  assert.match(src,/measure==='COHORT_CONVERTED'/);
  assert.match(src,/QUOTATION_COHORT_HAS_CERTIFIED_CURSE/);
  assert.match(src,/measure==='COHORT_APPROVED'/);
  assert.match(src,/QUOTATION_COHORT_APPROVED_NOT_CURSED/);
  assert.match(src,/measure==='COHORT_EXPIRED'/);
  assert.match(src,/QUOTATION_COHORT_EXPIRED_NOT_CURSED/);
  assert.match(src,/QUOTATION_COHORT_REJECTED_NOT_CURSED/);
  assert.match(src,/CURRENT_OUTCOME_OF_QUOTATION_COHORT/);
});


test('P1 FORUM STORE dimension uses canonical store master identity',()=>{
  const src=fs.readFileSync(new URL('../lib/data-floor/forum/observations.js',import.meta.url),'utf8');
  assert.match(src,/dimension==='STORE'.*store_v01/s);
  assert.match(src,/fromForStoreIdentity/);
  assert.match(src,/UNRESOLVED:/);
});


test('P1 FORUM SELLER dimension uses canonical person identity',()=>{
  const src=fs.readFileSync(new URL('../lib/data-floor/forum/observations.js',import.meta.url),'utf8');
  assert.match(src,/dimension==='SELLER'.*personas_master/s);
  assert.match(src,/fromForSellerIdentity/);
  assert.match(src,/UNRESOLVED:/);
});


test('PRECURSE company, store, seller, and store-seller groups share one materialized P1 universe',()=>{
  const src=fs.readFileSync(new URL('../lib/data-floor/forum/observations.js',import.meta.url),'utf8');
  assert.match(src,/WITH universe AS MATERIALIZED/);
  assert.match(src,/GROUP BY GROUPING SETS/);
  assert.match(src,/STORE_IDENTITY_JOIN/);
  assert.match(src,/SELLER_IDENTITY_JOIN/);
  assert.match(src,/bundleFilterKeys=new Set/);
  assert.match(src,/filterSql/);
  assert.match(src,/universe:f/);
});
