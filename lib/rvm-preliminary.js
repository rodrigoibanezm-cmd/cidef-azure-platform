export const PRELIMINARY_MAPPING = {
  mes: 'mes',
  dia: 'dia',
  tipo_original: 'tipo_original',
  tipo: 'tipo',
  descripcion_tipo: 'descripcion_tipo',
  descripcion_segmento: 'descripcion_segmento',
  marca: 'marca',
  modelo_homologado: 'modelo_homologado',
  modelo_version: 'modeo_version',
  ano_fabricacion: 'ano_fabricacion',
  region: 'region',
  combustible: 'combustible',
  pbv: 'pbv',
  n_puertas: 'n_puertas',
  n_asientos: 'n_asientos',
  carga: 'carga',
  comuna_adquirente: 'comuna_adquisicion',
  region_adquirente: 'region_propietario',
  prenda: 'prenda',
  vin: 'vin',
  n_chasis: 'n_chasis',
  patente: 'patente',
  calidad: 'calidad',
  ano_vin: 'ano_vin',
  pais_vin: 'pais_vin',
  preinscrito: 'preinscrito',
  cantidad: 'cantidad',
};

export const REQUIRED_HEADERS = [
  'Mes','Día','Semana','Mercado','Tipo Original','Tipo','Descripción Tipo','Descripción Segmento','Marca',
  'Modelo Homologado','Modelo Versión','Año Fabricación','Región','Oficina','Color','Combustible','PBV',
  'N° Puertas','N° Asientos','Carga','Comuna Adquirente','Región Adquirente','Prenda','VIN','N° Chasis',
  'N° Motor','Patente','Calidad','Estado Solicitud','Segmento Pesados','Año VIN','País VIN','Preinscrito','cantidad',
];

export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function buildHeaderMap(values) {
  const map = new Map(values.map((value, index) => [normalizeName(value), index]));
  const aliases = {
    modelo_version: ['modeo_version'],
    comuna_adquirente: ['comuna_adquisicion'],
    region_adquirente: ['region_propietario'],
  };
  for (const [canonical, alternatives] of Object.entries(aliases)) {
    if (!map.has(canonical)) {
      const source = alternatives.find((name) => map.has(name));
      if (source) map.set(canonical, map.get(source));
    }
  }
  const missing = REQUIRED_HEADERS.filter((header) => !map.has(normalizeName(header)));
  if (missing.length) {
    throw new Error(`RVM preliminary missing columns: ${missing.join(', ')}; received headers: ${[...map.keys()].join(', ')}`);
  }
  return map;
}

function rowText(row) {
  return row.values.map((value) => String(value ?? '').trim()).filter(Boolean).join('\n').trim();
}

function validateAndDetectFooter(row) {
  const text = rowText(row);
  if (!/^filtros aplicados\s*:/i.test(text)) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(1)) {
    const normalized = line.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalized === 'mercado es livianos y medianos') continue;
    throw new Error(`Additional filter detected: ${line}`);
  }
  return true;
}

function isAuxiliaryRow(row, map) {
  const probes = ['mes','mercado','tipo_original','descripcion_segmento','marca','vin','cantidad']
    .map((key) => String(row.values[map.get(key)] ?? '').trim().toLowerCase())
    .filter(Boolean);
  return probes.some((value) => value === 'total');
}

function parseInteger(value, field) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`Invalid ${field}: ${value}`);
  return Number(text);
}

function inferYear(file, explicitYear) {
  if (explicitYear != null) {
    const year = Number(explicitYear);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error(`Invalid year: ${explicitYear}`);
    return year;
  }
  const candidates = `${file.name ?? ''} ${file.createdTime ?? ''} ${file.modifiedTime ?? ''}`.match(/\b20\d{2}\b/g) ?? [];
  const unique = [...new Set(candidates.map(Number))];
  if (unique.length === 1) return unique[0];
  throw new Error('Unable to determine RVM preliminary year deterministically; provide input.year');
}

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error(`Invalid derived date: ${year}-${month}-${day}`);
  }
  return date.toISOString().slice(0, 10);
}

function normalizeFilterText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function parsePreliminaryRows(rows, headerValues, file, input = {}) {
  const map = buildHeaderMap(headerValues);
  const year = inferYear(file, input.year);
  const valid = [];
  const months = new Set();
  const markets = new Set();

  for (const row of rows) {
    if (validateAndDetectFooter(row)) continue;
    if (isAuxiliaryRow(row, map)) continue;
    const raw = Object.fromEntries([...map.entries()].map(([key, index]) => [key, row.values[index] ?? null]));
    if (Object.values(raw).every((value) => value == null || String(value).trim() === '')) continue;

    const month = parseInteger(raw.mes, 'mes');
    const day = parseInteger(raw.dia, 'dia');
    const quantity = parseInteger(raw.cantidad, 'cantidad');
    const market = normalizeFilterText(raw.mercado);
    if (market) markets.add(market);
    months.add(month);

    const fecha = isoDate(year, month, day);
    const mapped = { ano: year, fecha, source_row: row.number };
    for (const [source, target] of Object.entries(PRELIMINARY_MAPPING)) mapped[target] = raw[source];
    mapped.mes = month;
    mapped.dia = day;
    mapped.cantidad = quantity;
    valid.push(mapped);
  }

  if (!valid.length) throw new Error('RVM preliminary has no valid data rows');
  if (months.size !== 1) throw new Error(`RVM preliminary contains more than one month: ${[...months].join(', ')}`);
  if (markets.size !== 1 || !markets.has('Livianos y Medianos')) {
    throw new Error(`Invalid Mercado filter: ${[...markets].join(', ') || '(empty)'}`);
  }

  const dates = valid.map((row) => row.fecha).sort();
  const month = [...months][0];
  return {
    year,
    month,
    min_date: dates[0],
    max_date: dates[dates.length - 1],
    snapshot_date: dates[dates.length - 1],
    rows: valid,
  };
}

export function selectLatestPreliminaryFile(files) {
  const candidates = files
    .filter((file) => /^data.*\.xls[xmb]?$/i.test(file.name ?? ''))
    .sort((a, b) => {
      const ad = new Date(a.modifiedTime ?? a.createdTime ?? 0).getTime();
      const bd = new Date(b.modifiedTime ?? b.createdTime ?? 0).getTime();
      if (ad !== bd) return bd - ad;
      return String(b.name).localeCompare(String(a.name));
    });
  if (!candidates.length) throw new Error('No RVM preliminary data*.xls* files found');
  return candidates[0];
}
