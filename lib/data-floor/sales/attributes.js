import { queryDb } from '../../neon.js';

export async function vehicleColorMap(){
  const rows=await queryDb(`
    SELECT upper(btrim(vin)) AS vin, nullif(btrim(color_raw),'') AS color
    FROM vehiculo_canonico
    WHERE vin IS NOT NULL AND btrim(vin)<>''
  `);
  return new Map(rows.map(row=>[row.vin,row.color]));
}
async function storeLabelMap(){
  const rows=await queryDb(`
    SELECT sucursal_id::text AS store_id, nombre_canonico AS store_label
    FROM sucursales_master
  `);
  return new Map(rows.map(row=>[row.store_id,row.store_label]));
}
async function sellerLabelMap(){
  const rows=await queryDb(`
    SELECT persona_id::text AS seller_id, nombre_canonico AS seller_label
    FROM personas_master
  `);
  return new Map(rows.map(row=>[row.seller_id,row.seller_label]));
}
export async function loadSalesAttributes(){
  const [colors,stores,sellers]=await Promise.all([vehicleColorMap(),storeLabelMap(),sellerLabelMap()]);
  return {colors,stores,sellers};
}
export function enrichSalesAttributes(rows,{colors,stores,sellers}){
  return rows.map(row=>{
    const storeId=row.certified_store_id??row.sucursal_venta_id??null;
    return {...row,
      vehicle_color:row.vin==null?null:(colors.get(String(row.vin).trim().toUpperCase())??null),
      certified_store_label:storeId==null?null:(stores.get(String(storeId))??null),
      certified_seller_label:(row.persona_id??row.vendedor_id)==null?null:(sellers.get(String(row.persona_id??row.vendedor_id))??null)
    };
  });
}
