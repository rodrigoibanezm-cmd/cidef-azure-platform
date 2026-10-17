import { queryDb } from '../neon.js';

const DIMENSIONS=Object.freeze({
  BRAND:Object.freeze({
    identity_contract:'brand_v01',
    identity_version:'0.1',
    meaning:'Canonical vehicle brand identity used by certified CIDEF data.',
  }),
});

function normalize(v){return String(v??'').trim().toUpperCase();}
function dimension(id){
  const key=normalize(id);const item=DIMENSIONS[key];
  if(!item){const e=new Error('UNSUPPORTED_IDENTITY_DIMENSION: '+key);e.code='UNSUPPORTED_IDENTITY_DIMENSION';throw e;}
  return {key,item};
}

export function listIdentityDimensions(){return Object.keys(DIMENSIONS);}

export async function resolveIdentity(input={}){
  const {key,item}=dimension(input.dimension);
  const value=String(input.value??'').trim();
  if(!value){const e=new Error('IDENTITY_VALUE_REQUIRED');e.code='IDENTITY_VALUE_REQUIRED';throw e;}

  if(key==='BRAND'){
    const rows=await queryDb(`
      SELECT marca_id AS id, trim(nombre_canonico) AS canonical_label,
             trim(nombre_normalizado) AS normalized_name
      FROM marcas_master_v01
      WHERE marca_id IS NOT NULL
        AND (
          upper(trim(nombre_canonico)) = upper(trim($1))
          OR upper(trim(nombre_normalizado)) = upper(trim($1))
        )
      ORDER BY marca_id
    `,[value]);
    const unique=[...new Map(rows.map(r=>[String(r.id),r])).values()];
    const base={dimension:key,input_value:value,identity_contract:item.identity_contract,identity_version:item.identity_version,lineage:{authority:'marcas_master_v01',match_rule:'EXACT_CANONICAL_OR_NORMALIZED'}};
    if(unique.length===0)return {...base,status:'NOT_FOUND',matches:[]};
    if(unique.length>1)return {...base,status:'AMBIGUOUS',matches:unique.map(r=>({canonical_id:String(r.id),canonical_label:r.canonical_label}))};
    const r=unique[0];
    return {...base,status:'RESOLVED',canonical_id:String(r.id),canonical_label:r.canonical_label,matches:[{canonical_id:String(r.id),canonical_label:r.canonical_label}]};
  }
}
