import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesPreparation } from '../lib/data-floor/sales/preparation.js';
import { observeSalesSelection } from '../lib/data-floor/sales/operations.js';

const raw = (id, vin, date, invoice, category = 'Cliente General') => ({ id,
  nro_vin_chasis: vin, fecha_factura: date, nro_factura: invoice,
  categoria_cliente: category, cliente: '123', desc_mae_marca: 'FOTON' });
const rows = [raw('sep','SEP','2026-09-20','10'), raw('old','A','2026-10-10','20'),
  raw('new','A','2026-10-25','21','Concesionaria')];
const movement = (fila, vin, date, invoice, quantity, original) => ({ periodo:'2026-10',
  fila_excel:fila, vin, fecha_documento:date, numero_documento:invoice,
  tipo_documento:quantity===1?'FAC-EL':'N/C-EL', cantidad:quantity,
  factura:original, marca:'FOTON', cierre_sha256:'fixture-only' });
const finanzas = [movement(1,'A','2026-10-10','20',1),
  movement(2,'A','2026-10-25','21',1), movement(3,'A','2026-10-28','30',-1,'20'),
  movement(4,'UNKNOWN','2026-10-29','22',1), {...movement(5,'CREDIT','2026-10-29','31',-1),marca:'DFM'}];
function prepared(finanzas) {
  return createSalesPreparation({ rows, finanzas, commercialMap:new Map(),
    historicalSalesChannelMap:new Map(), dealerBuyerMap:new Map(),
    resources:{organization:{},productAliases:[],skuEvidence:[],catalogs:{
      models:new Map(),versions:new Map(),brands:new Map([['FOTON',{marca_id:68,marca:'FOTON'}],['DONGFENG',{marca_id:71,marca:'DONGFENG'}]])}},
    attributes:{colors:new Map(),stores:new Map(),sellers:new Map()} });
}
function select(p, period, cutoff = period+'-30', universe = 'COMPANY') {
  return p.buildFactSet({commercial_universe:universe,cutoff_date:cutoff})
    .select({commercial_universe:universe,date_from:period+'-01',date_to:cutoff});
}
test('October replaces SALES with signed movements and retains exact invoice identities', () => {
  const p=prepared(finanzas), selection=select(p,'2026-10','2026-10-31');
  assert.equal(selection.facts.length,5); // Same VIN occurs three times; no LAST deduplication.
  assert.equal(observeSalesSelection(selection).payload.value,1);
  assert.deepEqual(observeSalesSelection(selection,{group_by:['NETWORK'],period:'2026-10'})
    .payload.members.map(r=>[r.member_id,r.value]),[['DEALER',1],['TIENDA_PROPIA',0],['UNRESOLVED',0]]);
  assert.equal(observeSalesSelection(selection,{group_by:['BRAND','NETWORK'],period:'2026-10'}).payload.members.find(r=>r.members[0].member_id==='71').value,-1);
  assert.equal(observeSalesSelection(select(p,'2026-10','2026-10-31','OWN_STORES')).payload.value,0);
  assert.equal(observeSalesSelection(select(p,'2026-10','2026-10-20')).payload.value,1);
  assert.equal(selection.facts.find(r=>r.vin==='UNKNOWN').canonical_commercial_universe,'UNRESOLVED');
  // A credit note without a same-month invoice remains negative, never discarded.
  assert.equal(selection.facts.find(r=>r.vin==='CREDIT').finanzas_cantidad,-1);
});
test('September without a Finanzas close preserves the existing SALES facts and result', () => {
  const before=select(prepared([]),'2026-09'), after=select(prepared(finanzas),'2026-09');
  assert.deepEqual(after.facts,before.facts);
  assert.deepEqual(observeSalesSelection(after),observeSalesSelection(before));
  assert.equal(observeSalesSelection(after).payload.value,1);
});
