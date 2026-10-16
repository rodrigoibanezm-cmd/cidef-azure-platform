import { azureQuery as queryDb } from '../../azure-postgres.js';
import { DATA_SOURCE, CERTIFIER_VERSION, lineage } from './contract.js';
import { normalizedFilters, where } from './query.js';
import { vals, norm, iso } from './values.js';

export async function observeForumOperationSnapshot(input={}){
  const snapshot=iso(input.cutoff);
  if(!snapshot)throw new Error('FORUM_SNAPSHOT_DATE_REQUIRED');
  const f=normalizedFilters({filters:input.filters||{}}),snapshotFilters={...f};
  delete snapshotFilters.brand_id;
  const w=where(snapshotFilters),p=[snapshot,...w.params];
  const shifted=w.sql.replace(/\\$(\\d+)/g,(_,n)=>'$'+(Number(n)+1));
  let suffix=shifted?shifted.replace(/^WHERE /,' AND '):'';
  if(f.brand_id!=null){p.push(vals(f.brand_id).map(Number).filter(Number.isFinite));suffix+=' AND p.brand_id = ANY($'+p.length+'::bigint[])';}
  const rows=await queryDb(`SELECT r.numero_operacion,r.tipo_proceso,r.distribuidor,r.sucursal,r.vendedor,r.ejecutivo,r.modelo_vehiculo,r.version_vehiculo,
      p.brand_id,b.nombre_canonico brand
    FROM forum_funnel_raw r
    LEFT JOIN LATERAL (
      SELECT min(pa.marca_id)::bigint brand_id
      FROM producto_aliases_v01 pa
      WHERE pa.fuente='forum_funnel' AND pa.estado='RESUELTO' AND pa.marca_id IS NOT NULL
        AND ((pa.nivel='VERSION' AND upper(btrim(pa.contexto_modelo_raw))=upper(btrim(r.modelo_vehiculo)) AND pa.valor_normalizado=upper(btrim(r.version_vehiculo)))
          OR (pa.nivel='MODELO' AND pa.valor_normalizado=upper(btrim(r.modelo_vehiculo))))
      HAVING count(DISTINCT pa.marca_id)=1
    ) p ON true
    LEFT JOIN marcas_master_v01 b ON b.marca_id=p.brand_id
    WHERE r.load_kind='DAILY_SNAPSHOT' AND r.source_type='COTIZACION' AND r.snapshot_date=$1::date${suffix}
    ORDER BY r.numero_operacion`,p);
  if(!rows.length)throw new Error('FORUM_SNAPSHOT_NOT_FOUND: '+snapshot);
  const operations=rows.map(r=>({operation_number:String(r.numero_operacion),state:norm(r.tipo_proceso)||'UNRESOLVED',network:norm(r.distribuidor)==='CIDEF'?'OWN_STORES':'DEALERS',distributor:r.distribuidor,store:r.sucursal,seller:r.vendedor,executive:r.ejecutivo,brand_id:r.brand_id==null?null:String(r.brand_id),brand:r.brand,model:r.modelo_vehiculo,version:r.version_vehiculo}));
  const unique=new Set(operations.map(r=>r.operation_number));
  if(unique.size!==operations.length)throw new Error('FORUM_SNAPSHOT_DUPLICATE_OPERATION');
  return {evidence_id:'FORUM:OPERATION_STATES:'+snapshot+':'+Date.now(),evidence_contract:'P1_OPERATION_STATE_SNAPSHOT',evidence_version:CERTIFIER_VERSION,authority:'P1_CERTIFIED',status:'COMPLETE',source:DATA_SOURCE,operation:'OBSERVE',grain:'FORUM_OPERATION',measure:{id:'OPERATION_STATES',unit:'OPERATION'},universe:f,dimensions:{},temporal:{snapshot_date:snapshot,observation_semantics:'EXACT_DAILY_COTIZACION_SNAPSHOT'},coverage:{complete:true,operation_count:operations.length,unique_operation_count:unique.size},payload:{operations,rule:'DAILY_COTIZACION_SNAPSHOT_STATE'},lineage:{...lineage(),snapshot_source:'forum_funnel_raw DAILY_SNAPSHOT / COTIZACION'}};
}
