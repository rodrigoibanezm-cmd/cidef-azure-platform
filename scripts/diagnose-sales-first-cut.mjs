// Standalone read-only experiment. This is NOT a certified P1 path.
import { performance } from 'node:perf_hooks';
import { queryDb } from '../lib/neon.js';
import { dataset, field } from '../lib/data-floor/sales/dataset.js';

const filters = {commercial_universe:'OWN_STORES',brand_id:89,model_id:28,
  store_id:4,date_from:'2026-08-01',date_to:'2026-08-31'};
const time = async (name,fn) => {
  const t=performance.now(),value=await fn();
  console.log(name+'_ms='+Math.round(performance.now()-t));
  return value;
};
// Include all accepted date spellings; confirmation belongs to P1's parser.
const month=/^\d{4}-(\d{2})/.exec(filters.date_from)?.[1];
const year=filters.date_from.slice(0,4);
const dateRe='^('+year+'-'+month+'-[0-9]{2}|[0-9]{1,2}/0?'+Number(month)+'/'+year+
  '|[0-9]{1,2}/0?'+Number(month)+'/'+year.slice(2)+')([[:space:]]|$)';
const sql=`
WITH candidate AS MATERIALIZED (
 SELECT DISTINCT btrim(v.nro_vin_chasis) AS vin
 FROM ventas_raw v
 WHERE btrim(v.categoria_cliente) IN ('Cliente General','Concesionaria')
   AND nullif(btrim(v.nro_vin_chasis),'') IS NOT NULL
   AND btrim(v.fecha_factura) ~ $1
   AND (EXISTS (
       SELECT 1 FROM sucursales_master s
       WHERE s.sucursal_id=$2 AND btrim(s.id_sucursal_vta::text)=btrim(v.id_sucursal_vta::text)
     ) OR EXISTS (
       SELECT 1 FROM vehiculo_canonico vc
       WHERE vc.vin=v.nro_vin_chasis AND vc.sucursal_venta_id=$2
     ))
   AND (EXISTS (
       SELECT 1 FROM producto_aliases_v01 a
       JOIN modelos_master_v01 m ON m.modelo_id=a.modelo_id
       WHERE a.estado='RESUELTO' AND a.modelo_id=$3 AND m.marca_id=$4
         AND lower(a.fuente) LIKE 'ventas_raw%'
         AND a.nivel IN ('MODELO','VERSION')
         AND master_norm(v.articulo)=master_norm(a.valor_normalizado)
     ) OR EXISTS (
       SELECT 1 FROM vehiculo_canonico vc
       JOIN versiones_master_v01 ver ON ver.version_id=vc.version_id
       JOIN modelos_master_v01 m ON m.modelo_id=ver.modelo_id
       WHERE vc.vin=v.nro_vin_chasis AND m.modelo_id=$3 AND m.marca_id=$4
     ))
)
SELECT vin FROM candidate`;
const [raw]=await time('raw_count',()=>queryDb(
  "SELECT count(*)::int n FROM ventas_raw WHERE btrim(categoria_cliente) IN ('Cliente General','Concesionaria')"));
const candidates=await time('candidate_sql',()=>queryDb(sql,[dateRe,filters.store_id,filters.model_id,filters.brand_id]));
const candidateVins=new Set(candidates.map(r=>String(r.vin).trim()));
const [related]=await time('related_raw_count',()=>queryDb(
  `SELECT count(*)::int n FROM ventas_raw
   WHERE btrim(categoria_cliente) IN ('Cliente General','Concesionaria')
     AND btrim(nro_vin_chasis) = ANY($1::text[])`,[[...candidateVins]]));
const baseline=await time('p1_certification',()=>dataset({filters}));
const certified=baseline.filtered.map(row=>String(field(row,'vin')??'').trim());
const missed=[...new Set(certified)].filter(vin=>!candidateVins.has(vin));
const result={case:'FOTON G7 / Pajaritos / agosto 2026',raw_rows:raw.n,
  candidate_vins:candidateVins.size,related_raw_rows:related.n,certified_vins:certified.length,
  missed_certified_vins:missed.length,missing_vin_examples:missed.slice(0,10),
  warning:'Candidate SQL is experimental; matching VINs alone does not certify coverage or equivalence.'};
console.log(JSON.stringify(result,null,2));
if(missed.length||certified.some(vin=>!vin))process.exitCode=1;
