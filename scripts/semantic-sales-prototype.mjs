// Experimental SALES candidate reader. P1 remains the recognition authority.
import { queryDb } from '../lib/neon.js';
import { FILTERS } from '../lib/data-floor/sales/contract.js';

// A filter is pushed down only when its candidate predicate is known to be
// a safe superset of the certified recognized rows for this monthly scope.
const predicates = Object.freeze({
  store_id: (value, bind) => `(EXISTS (
    SELECT 1 FROM sucursales_master s WHERE s.sucursal_id = ${bind(value)}
      AND btrim(s.id_sucursal_vta::text) = btrim(v.id_sucursal_vta::text)
  ) OR EXISTS (
    SELECT 1 FROM vehiculo_canonico vc
    WHERE vc.vin = v.nro_vin_chasis AND vc.sucursal_venta_id = ${bind(value)}
  ))`,
  dealer_id: (value, bind) => `(EXISTS (
    SELECT 1 FROM dealers_master d WHERE d.dealer_id = ${bind(value)}
      AND d.rut_normalizado IS NOT NULL
      AND regexp_replace(v.cliente, '[^0-9]', '', 'g') =
          regexp_replace(d.rut_normalizado, '[^0-9]', '', 'g')
  ) OR EXISTS (
    SELECT 1 FROM vehiculo_canonico vc
    WHERE vc.vin = v.nro_vin_chasis AND vc.dealer_id = ${bind(value)}
  ))`,
  seller_id: (value, bind) => `EXISTS (
    SELECT 1 FROM personas_master pm
    WHERE pm.persona_id = ${bind(value)}
      AND pm.usuario_canonico::text = v.nombre_usuario::text
      AND (SELECT COUNT(*) FROM personas_master px
           WHERE px.usuario_canonico::text = pm.usuario_canonico::text) = 1
  )`,
});

// Brand/model is one dependent identity predicate (aliases plus canonical).
const productPredicate = (model, brand, bind) => `(EXISTS (
  SELECT 1 FROM producto_aliases_v01 a
  JOIN modelos_master_v01 m ON m.modelo_id = a.modelo_id
  WHERE a.estado = 'RESUELTO' AND a.modelo_id = ${bind(model)}
    AND m.marca_id = ${bind(brand)}
    AND lower(a.fuente) LIKE 'ventas_raw%'
    AND a.nivel IN ('MODELO','VERSION')
    AND master_norm(v.articulo) = master_norm(a.valor_normalizado)
) OR EXISTS (
  SELECT 1 FROM vehiculo_canonico vc
  JOIN versiones_master_v01 ver ON ver.version_id = vc.version_id
  JOIN modelos_master_v01 m ON m.modelo_id = ver.modelo_id
  WHERE vc.vin = v.nro_vin_chasis
    AND m.modelo_id = ${bind(model)} AND m.marca_id = ${bind(brand)}
))`;

const supported = new Set(['commercial_universe','date_from','date_to',
  'brand_id','model_id',...Object.keys(predicates)]);
const positiveId = value => Number.isSafeInteger(value) && value > 0;

// This compiler is independent of any MCP tool, group_by, and aggregation.
// Unsupported filter shapes fall back to full P1 rather than guessing.
export function planSalesCandidates(filters, cutoffDate) {
  if (!filters || Object.keys(filters).some(key => !FILTERS.includes(key) || !supported.has(key)))
    return null;
  const {commercial_universe:universe,date_from:from,date_to:to,brand_id:brand,model_id:model,...rest} = filters;
  if (!['OWN_STORES','DEALERS'].includes(universe) ||
      !positiveId(brand) || !positiveId(model) ||
      !/^\\d{4}-\\d{2}-01$/.test(from ?? '') ||
      !/^\\d{4}-\\d{2}-\\d{2}$/.test(to ?? '') ||
      from.slice(0,7) !== to.slice(0,7) || to !== cutoffDate ||
      (universe==='DEALERS' && rest.store_id != null) ||
      (universe!=='DEALERS' && rest.dealer_id != null) ||
      Object.entries(rest).some(([key,value]) => !predicates[key] || !positiveId(value)))
    return null;
  return Object.freeze({filters:{...filters},year:Number(from.slice(0,4)),
    month:Number(from.slice(5,7)),commercial_universe:universe});
}

export async function semanticSalesCandidates(plan) {
  const {filters,year,month,commercial_universe:universe}=plan;
  if (!planSalesCandidates(filters,filters.date_to)) throw new Error('UNSUPPORTED_SALES_CANDIDATE_PLAN');
  const params=[];
  const bind=value => {params.push(value);return '$'+params.length;};
  const mm=String(month).padStart(2,'0'), yy=String(year).slice(-2);
  const datePattern='^('+year+'-'+mm+'-[0-9]{2}|[0-9]{1,2}/0?'+month+
    '/'+year+'|[0-9]{1,2}/0?'+month+'/'+yy+')([[:space:]]|$)';
  const conditions=[
    'btrim(v.categoria_cliente) = '+bind(universe==='DEALERS'?'Concesionaria':'Cliente General'),
    "nullif(btrim(v.nro_vin_chasis),'') IS NOT NULL",
    'btrim(v.fecha_factura) ~ '+bind(datePattern),
    productPredicate(filters.model_id,filters.brand_id,bind),
    ...Object.entries(predicates).filter(([key])=>filters[key]!=null)
      .map(([key,compile])=>compile(filters[key],bind)),
  ];
  const sql='SELECT DISTINCT btrim(v.nro_vin_chasis) AS vin FROM ventas_raw v WHERE '+
    conditions.join(' AND ')+' ORDER BY vin';
  const start=performance.now();
  const rows=await queryDb(sql,params);
  return {vins:rows.map(row=>row.vin),count:rows.length,
    elapsed_ms:Math.round(performance.now()-start),status:'CANDIDATES_ONLY_NOT_CERTIFIED'};
}
