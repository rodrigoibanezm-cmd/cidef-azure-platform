import { FILTERS } from './contract.js';
import { vals, norm } from './values.js';

export const NETWORK_SQL="CASE WHEN upper(btrim(distribuidor::text))='CIDEF' THEN 'OWN_STORES' ELSE 'DEALERS' END";
export const DEALER_GROUP_SQL="CASE WHEN upper(btrim(distribuidor::text))='CIDEF' THEN 'CIDEF' ELSE coalesce(forum_dealer_group.nombre_canonico,forum_dealer_direct.nombre_canonico,btrim(distribuidor::text)) END";

export const FORUM_FROM=`forum_funnel_universe_v01
LEFT JOIN LATERAL (
  SELECT min(pa.marca_id)::bigint brand_id
  FROM producto_aliases_v01 pa
  WHERE pa.fuente='forum_funnel' AND pa.estado='RESUELTO' AND pa.marca_id IS NOT NULL
    AND ((pa.nivel='VERSION' AND upper(btrim(pa.contexto_modelo_raw))=upper(btrim(modelo_vehiculo)) AND pa.valor_normalizado=upper(btrim(version_vehiculo)))
      OR (pa.nivel='MODELO' AND pa.valor_normalizado=upper(btrim(modelo_vehiculo))))
  HAVING count(DISTINCT pa.marca_id)=1
) forum_product ON true
LEFT JOIN marcas_master_v01 forum_brand ON forum_brand.marca_id=forum_product.brand_id`;

export const DEALER_IDENTITY_JOINS=`
LEFT JOIN LATERAL (
  SELECT g.dealer_group_id,g.nombre_canonico
  FROM dealer_aliases da
  JOIN dealers_master d ON d.dealer_id=da.dealer_id
  JOIN dealer_groups g ON g.dealer_group_id=d.dealer_group_id
  WHERE da.fuente='forum_funnel'
    AND da.tipo_alias='distribuidor'
    AND da.validated=true
    AND da.valor_normalizado=master_norm(distribuidor::text)
  LIMIT 1
) forum_dealer_group ON true
LEFT JOIN dealer_groups forum_dealer_direct
  ON forum_dealer_group.dealer_group_id IS NULL
 AND forum_dealer_direct.nombre_normalizado=master_norm(distribuidor::text)`;

export const STORE_IDENTITY_JOIN=`
LEFT JOIN LATERAL (
  SELECT sa.sucursal_id,m.nombre_canonico
  FROM sucursal_aliases sa
  JOIN sucursales_master m ON m.sucursal_id=sa.sucursal_id
  WHERE sa.fuente='forum_raw'
    AND sa.validated=true
    AND master_norm(sa.valor_raw)=master_norm(sucursal::text)
  ORDER BY sa.sucursal_alias_id
  LIMIT 1
) forum_store ON true`;

export const SELLER_IDENTITY_JOIN=`
LEFT JOIN LATERAL (
  SELECT pa.persona_id,pm.nombre_canonico
  FROM persona_aliases pa
  JOIN personas_master pm ON pm.persona_id=pa.persona_id
  WHERE pa.fuente='forum_raw'
    AND pa.tipo_alias='nombre'
    AND pa.validated=true
    AND master_norm(pa.valor_raw)=master_norm(vendedor::text)
  ORDER BY pa.confidence DESC NULLS LAST, pa.persona_alias_id
  LIMIT 1
) forum_seller ON true`;

export function fromForDealerIdentity(){
  return FORUM_FROM+DEALER_IDENTITY_JOINS;
}

export function fromForStoreIdentity(){
  return FORUM_FROM+STORE_IDENTITY_JOIN;
}

export function fromForSellerIdentity(){
  return FORUM_FROM+SELLER_IDENTITY_JOIN;
}

export function normalizedFilters(input={}){
  const f={...(input.filters||{})};
  const bad=Object.keys(f).find(k=>!FILTERS.includes(k));
  if(bad)throw new Error('UNSUPPORTED_FORUM_FILTER: '+bad);
  return f;
}

export function where(f){
  const c=[],p=[];
  if(f.brand_id!=null){
    p.push(vals(f.brand_id).map(Number).filter(Number.isFinite));
    c.push('forum_product.brand_id = ANY($'+p.length+'::bigint[])');
  }
  const add=(sql,v)=>{
    p.push(v);
    c.push(sql.replace('?', '$'+p.length));
  };
  if(f.operation_number!=null)add('numero_operacion=?::bigint',f.operation_number);
  if(f.network!=null){
    p.push(vals(f.network).map(norm).filter(Boolean));
    c.push(NETWORK_SQL+' = ANY($'+p.length+'::text[])');
  }
  if(f.dealer_group!=null){
    p.push(vals(f.dealer_group).map(norm).filter(Boolean));
    c.push(DEALER_GROUP_SQL+' = ANY($'+p.length+'::text[])');
  }
  const cols={
    stage:'etapa_certificada',
    status:'estado_actual',
    distributor:'distribuidor',
    store:'sucursal',
    seller:'vendedor',
    executive:'ejecutivo',
    model:'modelo_vehiculo',
    version:'version_vehiculo',
    rut:'rut'
  };
  for(const [k,col] of Object.entries(cols)){
    if(f[k]==null)continue;
    p.push(vals(f[k]).map(norm).filter(Boolean));
    c.push('upper(btrim('+col+'::text)) = ANY($'+p.length+'::text[])');
  }
  return {sql:c.length?'WHERE '+c.join(' AND '):'',params:p};
}
