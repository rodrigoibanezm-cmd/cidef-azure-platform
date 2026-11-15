// Isolated SQL vs the existing SALES recognition authority. Read-only.
import { performance } from 'node:perf_hooks';
import { queryDb } from '../lib/neon.js';
import { loadVentasRows } from '../lib/ventas/loadVentasRows.js';
import { calculateVentasContext } from '../lib/ventas/buildVentasContext.js';

const cutoff = process.argv[2] ?? '2026-08-31';
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw Error('Use YYYY-MM-DD');
const sql = `
WITH source AS (
 SELECT id, nullif(btrim(nro_vin_chasis),'') vin, btrim(fecha_factura) raw_date
 FROM ventas_raw WHERE btrim(categoria_cliente) IN ('Cliente General','Concesionaria')
), parts AS (
 SELECT *, CASE
   WHEN raw_date ~ '^\\d{4}-\\d{2}-\\d{2}( \\d{1,2}:\\d{2}(:\\d{2})?)?$'
     THEN 'ISO'
   WHEN raw_date ~ '^\\d{1,2}/\\d{1,2}/\\d{2}( \\d{1,2}:\\d{2}(:\\d{2})?)?$'
     OR raw_date ~ '^\\d{1,2}/\\d{1,2}/\\d{4}( \\d{1,2}:\\d{2}(:\\d{2})?)?$'
     THEN 'DMY' ELSE NULL END fmt
 FROM source
), normalized AS (
 SELECT *, CASE
   WHEN fmt='ISO' THEN split_part(raw_date,' ',1)
   WHEN fmt='DMY' THEN
     (CASE WHEN length(split_part(split_part(raw_date,' ',1),'/',3))=2
       THEN '20' ELSE '' END) || split_part(split_part(raw_date,' ',1),'/',3)
       || '-' || lpad(split_part(raw_date,'/',2),2,'0')
       || '-' || lpad(split_part(raw_date,'/',1),2,'0')
   END AS day_text,
   CASE WHEN position(' ' in raw_date)>0
     THEN split_part(raw_date,' ',2) ELSE '00:00:00' END AS time_text
 FROM parts
), dates AS (
 SELECT *, day_text || ' ' ||
   lpad(split_part(time_text,':',1),2,'0') || ':' ||
   lpad(split_part(time_text,':',2),2,'0') || ':' ||
   lpad(nullif(split_part(time_text,':',3),'')::text,2,'0') AS date_text
 FROM normalized
), parsed AS (
 SELECT *, CASE
   WHEN fmt IS NOT NULL AND day_text ~ '^\\d{4}-\\d{2}-\\d{2}$'
     AND substring(day_text,6,2) BETWEEN '01' AND '12'
     AND substring(day_text,9,2) BETWEEN '01' AND '31'
     AND split_part(time_text,':',1)::int BETWEEN 0 AND 23
     AND split_part(time_text,':',2)::int BETWEEN 0 AND 59
     AND coalesce(nullif(split_part(time_text,':',3),''),'0')::int BETWEEN 0 AND 59
   THEN to_timestamp(date_text,'YYYY-MM-DD HH24:MI:SS') ELSE NULL END ts
 FROM dates
), eligible AS (
 SELECT *, CASE WHEN ts IS NOT NULL AND
   to_char(ts,'YYYY-MM-DD HH24:MI:SS')=date_text
   THEN true ELSE false END valid
 FROM parsed
), selected AS (
 SELECT *, row_number() OVER (PARTITION BY vin ORDER BY ts DESC,
   CASE WHEN id::text ~ '^[-+]?[0-9]+(\\.[0-9]+)?$'
     THEN id::numeric ELSE NULL END ASC NULLS LAST, id::text ASC) rank
 FROM eligible WHERE valid AND ts <= ($1::date + interval '1 day' - interval '1 millisecond')
)
SELECT id::text source_id,vin FROM selected WHERE vin IS NULL OR rank=1
`;
const t0=performance.now();
const [rows,raw]=await Promise.all([
  queryDb(sql,[cutoff]),loadVentasRows()
]);
const sqlMs=Math.round(performance.now()-t0);
const t1=performance.now();
const baseline=calculateVentasContext(raw,{cutoffDate:cutoff});
const jsMs=Math.round(performance.now()-t1);
const key=r=>JSON.stringify([r.vin??null,String(r.source_id??'')]);
const a=new Set(rows.map(key)), b=new Set(baseline.recognizedSales.map(key));
const onlySql=[...a].filter(k=>!b.has(k));
const onlyJs=[...b].filter(k=>!a.has(k));
console.log(JSON.stringify({cutoff,source_rows:raw.length,sql_ms:sqlMs,js_recognition_ms:jsMs,
  sql_recognized:a.size,js_recognized:b.size,only_sql:onlySql.length,only_js:onlyJs.length,
  sql_examples:onlySql.slice(0,5),js_examples:onlyJs.slice(0,5),
  scope:'Recognition only; not commercial identities or full P1 evidence'},null,2));
if (onlySql.length||onlyJs.length) process.exitCode=1;
