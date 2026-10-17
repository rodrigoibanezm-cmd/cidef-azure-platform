import { canonicalPricingRow, validateCanonicalPricingRow } from './canonicalPricingRow.js';

const VERSION_FIELDS = [
  'version',
  'linea_midi', 'linea_tm3', 'linea_tm5', 'wonder_2', 'linea_k1', 'linea_ft',
  'foton_g7_lite_euro_6', 'foton_g7_ultimate_euro_6', 'foton_g7_ultimate_at_euro_6',
  'g9_mt', 'g9_2', 'foton_v7_euro_6', 'foton_v9_euro_6',
  'aeolus_y3_2', 'aeolus_gs_2', 't5_2', 't5_l', 't5_evo_2', 'sx6_2',
  'mage_2', 'mage_3', 'huge_2', 'precio_rich_6',
  'view_grand_cargo', 'view_grand_pasajero', 'g7_ev', 's50_ev',
];

const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const firstText = (record, keys) => {
  for (const key of keys) {
    const value = cleanText(record[key]);
    if (value) return value;
  }
  return null;
};

export function parseVigencia(value) {
  const text = cleanText(value);
  const match = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

export function parseClp(value) {
  const text = cleanText(value);
  if (!text || /^\$?\s*-\s*$/.test(text)) return null;
  if (/[A-Za-z]/.test(text)) return null;
  const negative = /^\$?\s*\(/.test(text);
  const digits = text.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const amount = Number(digits);
  return Number.isSafeInteger(amount) ? (negative ? -amount : amount) : null;
}

function brandFor(record) {
  const sheet = cleanText(record.source_sheet).toUpperCase();
  if (sheet.startsWith('FOTON')) return 'FOTON';
  if (sheet.startsWith('DONGFENG')) return 'DONGFENG';
  const brand = cleanText(record.marca).toUpperCase();
  return brand || null;
}

function firstVersion(record) {
  return firstText(record, VERSION_FIELDS);
}

function fingerprintFor(record) {
  const version = firstVersion(record) || '';
  return {
    transmision: firstText(record, ['transmision', 'transm', 'transm_2']),
    cc: firstText(record, ['cc', 'c_c', 'cilindrada']),
    hp: firstText(record, ['hp', 'h_p', 'potencia_hp', 'potencia_maxima']),
    combustible: firstText(record, ['combustible', 'tipo_de_motor']),
    traccion: firstText(record, ['traccion']) || (version.match(/\b4X[24]\b/i)?.[0]?.toUpperCase() ?? null),
    carga_kg: firstText(record, ['carga_kg', 'carga_kg_2', 'carga']),
    pasajeros: firstText(record, ['pasajeros', 'pasajero']),
    euro: firstText(record, ['euro', 'norma_euro']) || (version.match(/EURO\s*(?:VI|6|V|5|IV|4)/i)?.[0] ?? null),
  };
}

export function normalizePriceRecord(record) {
  const marca = brandFor(record);
  let modelo = cleanText(record.product_group || record.modelo);
  let version = firstVersion(record);

  if (!modelo && record.modelo) modelo = cleanText(record.modelo);
  if (!version && record.modelo) {
    const transmission = cleanText(record.transmision || record.transm);
    version = transmission ? `${modelo} ${transmission}` : modelo;
  }

  const vigenciaDesde = parseVigencia(record.vigencia);
  const sheet = cleanText(record.source_sheet).toUpperCase();
  const precioNeto = parseClp(record.precio_neto || record.precio_sin_i_v_a || record.precio_neto_8);
  const precioLista = parseClp(record.precio_lista);
  const precioConIva = parseClp(record.precio_con_iva || record.precio_con_i_v_a);
  const monthlyBonus = parseClp(
    record.bono_enero || record.bono_febrero || record.bono_marzo || record.bono_abril ||
    record.bono_mayo || record.bono_junio || record.bono_julio || record.bono_agosto ||
    record.bono_septiembre || record.bono_octubre || record.bono_noviembre || record.bono_diciembre
  );

  let preSin = null;
  let preIva = null;
  let finalSin = null;
  let finalIva = null;

  if (sheet === 'DONGFENG') {
    // This layout historically labels its second effective-price column as IVA,
    // but source certification established that it is normally the FINAL
    // effective condition after bono_mes. Do not fabricate an IVA dimension.
    preSin = parseClp(record.precio_con_bonos);
    finalSin = parseClp(record.precio_con_bonos_con_iva) ?? preSin;

    // Two historical layouts publish an explicit second condition under _2.
    // Preserve it when present.
    const explicitSecond = parseClp(record.precio_con_bonos_con_iva_2);
    if (explicitSecond != null) {
      preSin = finalSin;
      finalSin = explicitSecond;
    }
  } else if (sheet === 'DONGFENG PICK UP') {
    // Pickup publishes an actual net/IVA pair for the final effective price.
    finalSin = parseClp(record.precio_neto_con_bonos || record.precio_con_bonos_sin_i_v_a || record.precio_con_bonos_sin_iva);
    finalIva = parseClp(record.precio_con_bonos_e_iva || record.precio_con_bonos_e_i_v_a || record.precio_con_bonos_con_iva);
  } else if (sheet === 'DONGFENG ELÉCTRICOS' || sheet === 'ELECTRICOS' || sheet === 'ELÉCTRICOS') {
    // Electric layouts publish a single effective condition; PRE is not a
    // separately published dimension.
    finalSin = parseClp(record.precio_con_bonos_sin_i_v_a || record.precio_con_bonos_sin_iva || record.precio_con_bonos);
    finalIva = parseClp(record.precio_con_bonos_e_i_v_a || record.precio_con_bonos_e_iva);
  } else {
    // FOTON commercial layouts may publish explicit PRE net/IVA and repeated
    // FINAL columns after the monthly bonus.
    preSin = parseClp(record.precio_con_bonos_sin_i_v_a || record.precio_con_bonos_sin_iva || record.precio_con_bonos || record.precio_con_bono_sin_i_v_a);
    preIva = parseClp(record.precio_con_bonos_e_i_v_a || record.precio_con_bonos_e_iva || record.precio_con_bonos_con_i_v_a || record.precio_con_bonos_con_iva);
    finalSin = parseClp(record.precio_con_bonos_sin_i_v_a_2 || record.precio_con_bonos_sin_iva_2 || record.precio_con_bonos_2) ?? preSin;
    finalIva = parseClp(record.precio_con_bonos_e_i_v_a_2 || record.precio_con_bonos_e_iva_2 || record.precio_con_bonos_con_i_v_a_2 || record.precio_con_bonos_con_iva_2) ?? preIva;
  }

  if (!marca || !modelo || !version || !vigenciaDesde || ![precioNeto, precioLista, precioConIva, preSin, preIva, finalSin, finalIva].some((v) => v != null)) return null;

  const canonical = canonicalPricingRow({
    marca, modelo, version,
    codigo: firstText(record, ['codigo', 'codigo_version', 'cod']),
    vigencia_desde: vigenciaDesde,
    precio_neto: precioNeto, precio_lista: precioLista, precio_con_iva: precioConIva,
    bono_cidef: parseClp(record.bono_cidef),
    bono_forum: parseClp(record.bono_forum || record.bono_financiamiento || record.bono_financiamiento_global),
    bono_mes: monthlyBonus,
    precio_efectivo_pre_mes_sin_iva: preSin,
    precio_efectivo_pre_mes_con_iva: preIva,
    precio_efectivo_final_sin_iva: finalSin,
    precio_efectivo_final_con_iva: finalIva,
    source_file: cleanText(record.source_file),
    source_sheet: cleanText(record.source_sheet),
    source_row: Number(record.source_row) || null,
  });

  const validation = validateCanonicalPricingRow(canonical);
  if (!validation.valid) return null;
  return { ...canonical, version_raw: version, ...fingerprintFor(record), raw_payload: record };
}
