export function normalizeNetworkCategory(value){
  const key=String(value??'').trim().toUpperCase();
  if(key==='CLIENTE GENERAL') return 'TIENDA_PROPIA';
  if(key==='CONCESIONARIA') return 'DEALER';
  return null;
}
