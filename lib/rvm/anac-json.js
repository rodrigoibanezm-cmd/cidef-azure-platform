// ANAC JSON -> existing RVM raw column contract. No database writes.
const FIELD = {
  ano: 'ANIO_SOL', mes: 'MES', dia: 'DIA_SOL',
  tipo_original: 'tipo_or', tipo: 'tipo', descripcion_tipo: 'descripcion_tipo',
  descripcion_segmento: 'descripcion_segmento', marca: 'MARCA',
  modelo_homologado: 'HOMOLOGADO', modeo_version: 'modelo_version',
  ano_fabricacion: 'ANIO_FAB', region: 'Region', combustible: 'combustible',
  pbv: 'pbv', n_puertas: 'numero_puertas', n_asientos: 'numero_asientos',
  carga: 'carga', comuna_adquisicion: 'comuna_adq',
  region_propietario: 'region_propietario', prenda: 'prenda', vin: 'vin',
  n_chasis: 'num_chasis', patente: 'patente', calidad: 'calidad',
  cantidad: 'cantidad',
};
const REQUIRED = ['id_rvm','MERCADO',...new Set(Object.values(FIELD))];

function dateFor(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day) throw Error('Invalid ANAC registration date');
  return date.toISOString().slice(0, 10);
}
function integer(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw Error('Invalid ANAC ' + name);
  return n;
}
export function parseAnacRvmJson(json, { year, month } = {}) {
  if (!Array.isArray(json) || !json.length) throw Error('ANAC response must be a nonempty array');
  const missing = REQUIRED.filter(k => !Object.hasOwn(json[0], k));
  if (missing.length) throw Error('ANAC missing fields: ' + missing.join(', '));
  const seen = new Set(), months = new Set(), rows = [];
  let excluded = 0;
  for (const [index, raw] of json.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw Error('Invalid ANAC record at row ' + (index + 1));
    const id = integer(raw.id_rvm, 'id_rvm');
    if (seen.has(id)) throw Error('Duplicate ANAC id_rvm: ' + id);
    seen.add(id);
    if (raw.MERCADO !== 'Livianos y Medianos') { excluded++; continue; }
    const y = integer(raw.ANIO_SOL, 'ANIO_SOL');
    const m = integer(raw.MES, 'MES');
    const day = integer(raw.DIA_SOL, 'DIA_SOL');
    if (year != null && y !== Number(year)) throw Error('ANAC year differs from requested year');
    if (month != null && m !== Number(month)) throw Error('ANAC month differs from requested month');
    const fecha = dateFor(y, m, day);
    const row = { source_row: index + 1, fecha };
    for (const [target, source] of Object.entries(FIELD)) row[target] = raw[source] ?? null;
    row.ano = y; row.mes = m; row.dia = day;
    row.cantidad = integer(raw.cantidad, 'cantidad');
    // Not supplied by ANAC: preserve missing values as null.
    row.ano_vin = null; row.pais_vin = null; row.preinscrito = null;
    rows.push(row);
    months.add(y + '-' + String(m).padStart(2, '0'));
  }
  if (!rows.length) throw Error('ANAC has no light and medium vehicle records');
  if (months.size !== 1) throw Error('ANAC snapshot spans multiple months');
  const snapshot_date = rows.reduce((latest, row) =>
    row.fecha > latest ? row.fecha : latest, rows[0].fecha);
  return { year: rows[0].ano, month: rows[0].mes, snapshot_date,
    rows, source_count: json.length, excluded_other_markets: excluded };
}
