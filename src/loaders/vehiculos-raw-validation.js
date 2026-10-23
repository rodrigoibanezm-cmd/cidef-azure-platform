import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import ExcelJS from 'exceljs';
import { BlobServiceClient } from '@azure/storage-blob';

// Isolated Azure validation: production vehicle tables are read-only.
const date = process.env.AZURE_SALES_SOURCE_DATE;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(date + 'T00:00:00Z')) ||
    new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date)
  throw new Error('AZURE_SALES_SOURCE_DATE must be valid YYYY-MM-DD');
const db = process.env.AZURE_DATABASE_URL;
const storage = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!db || !storage) throw new Error('Azure database and storage credentials required');
const target = 'vehiculos_raw_azure_validation';
const keep = 'nro_stock vin_chasis marca modelo patente ano color etapa bodega vigente fecha_nv nota_de_venta vendedor sucursal_venta factura numero_factura fecha_factura rut cliente fecha_entrega_planificada pendiente_entrega esta_fisico esta_reservado esta_en_transito en_patio fecha_ingreso_stk tipo_ficha fecha_eta'.split(' ');
const dateColumns = 'fecha_nv fecha_factura fecha_entrega_planificada fecha_ingreso_stk fecha_eta'.split(' ');
const lifecycle = {
  fecha_inscripcion_rvm: 'date', patente_rvm: 'text',
  rvm_data_status: 'text', fecha_entrega_dealer: 'date',
  fecha_actualizacion_rvm: 'timestamptz'
};
const q = (v) => '"' + String(v).replaceAll('"', '""') + '"';
function normalizedDate(column) {
  const v = 'btrim(' + q(column) + '::text)';
  return "CASE WHEN " + q(column) + " IS NULL OR " + v + "='' THEN NULL " +
    "WHEN " + v + " ~ '^\\d{1,2}-\\d{1,2}-\\d{4}( \\d{1,2}:\\d{2})?$' THEN to_timestamp(" + v + ",CASE WHEN " + v + " ~ ' ' THEN 'DD-MM-YYYY HH24:MI' ELSE 'DD-MM-YYYY' END)::timestamp " +
    "WHEN " + v + " ~ '^\\d{1,2}/\\d{1,2}/\\d{4}( \\d{1,2}:\\d{2})?$' THEN to_timestamp(" + v + ",CASE WHEN " + v + " ~ ' ' THEN 'DD/MM/YYYY HH24:MI' ELSE 'DD/MM/YYYY' END)::timestamp " +
    "WHEN " + v + " ~ '^\\d{1,2}/\\d{1,2}/\\d{2}( \\d{1,2}:\\d{2})?$' THEN to_timestamp(" + v + ",CASE WHEN " + v + " ~ ' ' THEN 'MM/DD/YY HH24:MI' ELSE 'MM/DD/YY' END)::timestamp ELSE NULL END";
}
const receipt = "CASE WHEN trim(fecha_recibo) ~ '^\\d{1,2}/\\d{1,2}/\\d{2} \\d{1,2}:\\d{2}$' THEN to_timestamp(trim(fecha_recibo),'MM/DD/YY HH24:MI') END";
const score = "(CASE WHEN nullif(trim(fecha_factura),'') IS NOT NULL THEN 16 ELSE 0 END) + " +
  "(CASE WHEN nullif(trim(numero_factura),'') IS NOT NULL OR nullif(trim(factura),'') IS NOT NULL THEN 8 ELSE 0 END) + " +
  "(CASE WHEN nullif(trim(nota_de_venta),'') IS NOT NULL THEN 4 ELSE 0 END) + " +
  "(CASE WHEN upper(trim(coalesce(etapa,''))) IN ('CL','CL - CLIENTE') THEN 2 ELSE 0 END) + " +
  "(CASE WHEN trim(coalesce(vigente,''))='1' THEN 1 ELSE 0 END)";
async function main() {
  const container = process.env.AZURE_CONTAINER || 'cidef';
  const key = 'ventas/Base_Unidades_por_Vistas_' + date.replaceAll('-', '_') + '.xlsx';
  const blob = BlobServiceClient.fromConnectionString(storage).getContainerClient(container).getBlobClient(key);
  if (!await blob.exists()) throw new Error('Missing Azure Blob: ' + key);
  const local = path.join(os.tmpdir(), 'vehicles-' + process.pid + '.xlsx');
  const client = new pg.Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  const stage = target + '__loading_' + process.pid;
  let connected = false;
  try {
    await blob.downloadToFile(local);
    await client.connect(); connected = true;
    await client.query('BEGIN');
    await client.query('CREATE TABLE ' + q(stage) + ' (placeholder text)');
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(local, { worksheets:'emit', sharedStrings:'cache', styles:'ignore', hyperlinks:'ignore', entries:'emit' });
    let cols = null, pending = [], rowsRead = 0, found = false;
    async function flush() {
      if (!pending.length) return;
      const vals = pending.flat();
      const tuples = pending.map((row,i) => '(' + row.map((_,j) => '$' + (i*cols.length+j+1)).join(',') + ')').join(',');
      await client.query('INSERT INTO ' + q(stage) + ' (' + cols.map(q).join(',') + ') VALUES ' + tuples, vals);
      pending = [];
    }
    for await (const sheet of reader) {
      if (sheet.name !== 'Inventario Vehiculos Global') continue;
      found = true;
      for await (const row of sheet) {
        const values = Array.from({ length:row.cellCount }, (_,i) => {
          const cell = row.getCell(i+1);
          return cell.value == null || cell.value === '' ? null : String(cell.text);
        });
        if (!cols) {
          const seen = new Map();
          cols = values.map((value,i) => {
            const base = String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'col_'+(i+1);
            const n=seen.get(base)||0; seen.set(base,n+1);
            return n ? base+'_'+(n+1):base;
          });
          const missing = [...keep,'tipo','fecha_recibo','nro_recibo'].filter(c => !cols.includes(c));
          if (missing.length) throw new Error('Missing vehicle columns: '+missing.join(','));
          await client.query('ALTER TABLE '+q(stage)+' DROP COLUMN placeholder, ADD COLUMN '+cols.map(c=>q(c)+' text').join(', ADD COLUMN '));
          continue;
        }
        if (!values.some(v=>v!=null && v!=='')) continue;
        rowsRead++;
        pending.push(cols.map((_,i)=>values[i]??null));
        if (pending.length>=50) await flush();
      }
      break;
    }
    if (!found || !cols || !rowsRead) throw new Error('Vehicle sheet missing or empty');
    await flush();
    async function remove(sql) { return (await client.query(sql)).rowCount; }
    const nonVehicle = await remove('DELETE FROM '+q(stage)+" WHERE tipo IS NULL OR trim(tipo)<>'Vehiculo Nuevo'");
    const rankVin = 'WITH r AS (SELECT ctid,row_number() OVER (PARTITION BY trim(vin_chasis) ORDER BY '+score+' DESC,'+receipt+" DESC NULLS LAST,CASE WHEN trim(nro_recibo) ~ '^\\d+$' THEN trim(nro_recibo)::bigint END DESC NULLS LAST,ctid DESC) AS rn FROM "+q(stage)+" WHERE nullif(trim(vin_chasis),'') IS NOT NULL) DELETE FROM "+q(stage)+' t USING r WHERE t.ctid=r.ctid AND r.rn>1';
    const duplicateVin = await remove(rankVin);
    const rankStock = 'WITH r AS (SELECT ctid,row_number() OVER (PARTITION BY trim(nro_stock) ORDER BY '+receipt+" DESC NULLS LAST,CASE WHEN trim(nro_recibo) ~ '^\\d+$' THEN trim(nro_recibo)::bigint END DESC NULLS LAST,ctid DESC) AS rn FROM "+q(stage)+" WHERE nullif(trim(vin_chasis),'') IS NULL) DELETE FROM "+q(stage)+' t USING r WHERE t.ctid=r.ctid AND r.rn>1';
    const duplicateStock = await remove(rankStock);
    for (const c of dateColumns) await client.query('ALTER TABLE '+q(stage)+' ALTER COLUMN '+q(c)+' TYPE timestamp without time zone USING '+normalizedDate(c));
    await client.query('ALTER TABLE '+q(stage)+' '+cols.filter(c=>!keep.includes(c)).map(c=>'DROP COLUMN '+q(c)).join(','));
    for (const [c,type] of Object.entries(lifecycle)) await client.query('ALTER TABLE '+q(stage)+' ADD COLUMN '+q(c)+' '+type);
    await client.query('UPDATE '+q(stage)+' s SET fecha_inscripcion_rvm=v.fecha_inscripcion_rvm, patente_rvm=v.patente_rvm, rvm_data_status=v.rvm_data_status, fecha_entrega_dealer=v.fecha_entrega_dealer, fecha_actualizacion_rvm=v.fecha_actualizacion_rvm FROM public.vehiculos_raw v WHERE upper(btrim(s.vin_chasis))=upper(btrim(v.vin_chasis))');
    const result = await client.query('SELECT count(*)::int AS rows,count(DISTINCT upper(btrim(vin_chasis)))::int AS vins FROM '+q(stage));
    await client.query('DROP TABLE IF EXISTS public.'+q(target));
    await client.query('ALTER TABLE '+q(stage)+' RENAME TO '+q(target));
    await client.query('COMMIT');
    console.log(JSON.stringify({source:'azure://'+container+'/'+key,target,rowsRead,removed:{nonVehicle,duplicateVin,duplicateStock},result:result.rows[0],status:'ISOLATED_VALIDATION_NOT_CERTIFIED'},null,2));
  } catch(e) { if(connected) await client.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { if(connected) await client.end().catch(()=>{}); await fs.unlink(local).catch(()=>{}); }
}
await main();
