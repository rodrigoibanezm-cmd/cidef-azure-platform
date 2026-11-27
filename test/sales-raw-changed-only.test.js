import test from 'node:test';
import assert from 'node:assert/strict';
import { commitTableSnapshot } from '../src/loaders/sales/db.js';
import { withSourceContext } from '../src/loaders/sales/source-io.js';

test('SALES merge only updates changed typed columns; keeps insertion and validation', async () => {
  const statements = [];
  const client = { async query(sql) {
    statements.push(sql);
    if (sql.includes('FROM pg_attribute')) {
      return { rows: [
        {name:'id',type:'bigint'}, {name:'fecha_factura',type:'timestamp without time zone'},
        {name:'precio_vta',type:'numeric'}, {name:'cliente',type:'text'},
      ] };
    }
    if (sql.includes('AS total') && sql.includes('unique_ids')) {
      return {rows:[{total:2,unique_ids:2}]};
    }
    if (sql.includes('AS total')) return {rows:[{total:2}]};
    return {rows:[]};
  }};
  await withSourceContext({client}, () => commitTableSnapshot({
    tableName:'ventas_raw', staging:'ventas_raw__loading_test',
  }));
  const update = statements.find(sql => sql.startsWith('UPDATE public.ventas_raw'));
  assert.ok(update, 'expected sales update');
  assert.match(update, /WHERE t.id::text = s.id AND \(/);
  for (const column of ['fecha_factura','precio_vta','cliente'])
    assert.ok(update.includes(`t."${column}" IS DISTINCT FROM s."${column}"::`), column);
  assert.match(update, /timestamp without time zone/);
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO public.ventas_raw')));
  assert.ok(statements.some(sql => sql.startsWith('DROP TABLE')));
  assert.equal(statements.filter(sql => sql.startsWith('DELETE FROM public.ventas_raw')).length,0);
});
