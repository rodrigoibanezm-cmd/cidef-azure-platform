import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parsePriceWorkbook } from './price-list.js';
import { workbookToSheetJson } from './workbookToSheetJson.js';
import { normalizePriceRecord, parseClp, parseVigencia } from './price-normalizer.js';
import { azureQuery as queryDb } from '../../lib/azure-postgres.js';

const STAGING_TABLE = 'price_import_staging';
const FP_FIELDS = ['transmision', 'cc', 'hp', 'combustible', 'traccion', 'carga_kg', 'pasajeros', 'euro'];
const VERSION_BATCH_SIZE = 100;
const HISTORY_BATCH_SIZE = 300;
const COMMERCIAL_REJECTION_REASONS = new Set(['MISSING_VIGENCIA', 'MISSING_PRICE', 'UNRECOGNIZED_LAYOUT']);

async function ensurePriceSchema() {
  await queryDb(`
    CREATE TABLE IF NOT EXISTS price_import_staging (
      id bigserial PRIMARY KEY,
      run_id text NOT NULL,
      source_file text,
      source_sheet text,
      source_row integer,
      vigencia text,
      product_group text,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await queryDb(`
    CREATE TABLE IF NOT EXISTS price_versions (
      price_version_id bigserial PRIMARY KEY,
      marca text NOT NULL,
      modelo text NOT NULL,
      version text NOT NULL,
      version_raw text,
      source_sheet text,
      activo boolean NOT NULL DEFAULT true,
      fingerprint_status text NOT NULL DEFAULT 'incomplete',
      transmision text,
      cc text,
      hp text,
      combustible text,
      traccion text,
      carga_kg text,
      pasajeros text,
      euro text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT price_versions_identity_uk UNIQUE (marca, modelo, version)
    )
  `);

  await queryDb(`
    CREATE TABLE IF NOT EXISTS price_history (
      price_history_id bigserial PRIMARY KEY,
      price_version_id bigint NOT NULL REFERENCES price_versions(price_version_id),
      vigencia_desde date NOT NULL,
      precio_neto bigint,
      precio_lista bigint,
      precio_con_iva bigint,
      bono_cidef bigint,
      bono_forum bigint,
      bono_mes bigint,
      precio_efectivo_pre_mes_sin_iva bigint,
      precio_efectivo_pre_mes_con_iva bigint,
      precio_efectivo_final_sin_iva bigint,
      precio_efectivo_final_con_iva bigint,
      source_file text NOT NULL,
      source_sheet text NOT NULL,
      source_row integer NOT NULL,
      raw_payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT price_history_source_uk UNIQUE (
        price_version_id, vigencia_desde, source_file, source_sheet, source_row
      )
    )
  `);

  await queryDb(`ALTER TABLE price_history ADD COLUMN IF NOT EXISTS precio_efectivo_pre_mes_sin_iva bigint`);
  await queryDb(`ALTER TABLE price_history ADD COLUMN IF NOT EXISTS precio_efectivo_pre_mes_con_iva bigint`);
  await queryDb(`ALTER TABLE price_history ADD COLUMN IF NOT EXISTS precio_efectivo_final_sin_iva bigint`);
  await queryDb(`ALTER TABLE price_history ADD COLUMN IF NOT EXISTS precio_efectivo_final_con_iva bigint`);

  await queryDb(`CREATE INDEX IF NOT EXISTS price_import_staging_run_idx ON price_import_staging(run_id)`);
  await queryDb(`CREATE INDEX IF NOT EXISTS price_versions_brand_active_idx ON price_versions(marca, activo)`);
  await queryDb(`CREATE INDEX IF NOT EXISTS price_history_lookup_idx ON price_history(price_version_id, vigencia_desde DESC, created_at DESC)`);
}

async function stageRecords(runId, records) {
  const batchSize = 40;
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const values = [];
    let p = 1;
    const tuples = batch.map((record) => {
      const tuple = [runId, record.source_file, record.source_sheet, Number(record.source_row) || null,
        record.vigencia, record.product_group, JSON.stringify(record)];
      values.push(...tuple);
      const refs = tuple.map((_, i) => `$${p + i}`);
      p += tuple.length;
      refs[6] = `${refs[6]}::jsonb`;
      return `(${refs.join(', ')})`;
    });
    await queryDb(`INSERT INTO ${STAGING_TABLE}
      (run_id, source_file, source_sheet, source_row, vigencia, product_group, payload)
      VALUES ${tuples.join(', ')}`, values);
  }
}

async function loadAllStagedRecords(runId) {
  const rows = await queryDb(
    `SELECT id, payload, source_file
       FROM ${STAGING_TABLE}
      WHERE run_id = $1
      ORDER BY id`,
    [runId],
  );
  if (!rows.length) throw new Error(`No staged price records found for run ${runId}`);
  return {
    records: rows.map((row) => row.payload),
    filesLoaded: new Set(rows.map((row) => row.source_file).filter(Boolean)).size,
  };
}

const norm = (v) => String(v ?? '').trim().toUpperCase();
const conflicts = (existing, item) => FP_FIELDS.some((field) =>
  existing[field] && item[field] && norm(existing[field]) !== norm(item[field]));

function requiredFingerprintFields(item) {
  const electric = /EL[EÉ]CTRIC/i.test(item.source_sheet) || /\bEV\b/i.test(item.version) || /EL[EÉ]CTRIC/i.test(item.combustible || '');
  if (electric) return ['transmision', 'hp', 'combustible', 'traccion', 'pasajeros'];
  const commercial = /COMERCIALES|PICK\s*UP|VIEW GRAND/i.test(item.source_sheet);
  if (commercial) return ['transmision', 'cc', 'hp', 'combustible'];
  return ['transmision', 'cc', 'hp', 'combustible'];
}

function fingerprintStatus(item) {
  const required = requiredFingerprintFields(item);
  const present = required.filter((field) => item[field]).length;
  if (!present) return 'incomplete';
  return present === required.length ? 'complete' : 'partial';
}

async function getPriceVersionId(item, cache) {
  const key = `${item.marca}|${item.modelo}|${item.version}`;
  if (cache.has(key)) return cache.get(key);

  const found = await queryDb(
    `SELECT price_version_id, transmision, cc, hp, combustible, traccion, carga_kg, pasajeros, euro
       FROM price_versions WHERE marca=$1 AND modelo=$2 AND version=$3 LIMIT 1`,
    [item.marca, item.modelo, item.version],
  );

  let id;
  if (!found.length) {
    const status = fingerprintStatus(item);
    const rows = await queryDb(
      `INSERT INTO price_versions
       (marca, modelo, version, version_raw, source_sheet, activo, fingerprint_status,
        transmision, cc, hp, combustible, traccion, carga_kg, pasajeros, euro)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING price_version_id`,
      [item.marca, item.modelo, item.version, item.version_raw, item.source_sheet, status,
       item.transmision, item.cc, item.hp, item.combustible, item.traccion, item.carga_kg, item.pasajeros, item.euro],
    );
    id = rows[0].price_version_id;
  } else {
    id = found[0].price_version_id;
    const conflict = conflicts(found[0], item);
    const status = conflict ? 'conflict' : fingerprintStatus(item);
    await queryDb(
      `UPDATE price_versions SET
         activo=true,
         version_raw=COALESCE(version_raw,$2), source_sheet=COALESCE(source_sheet,$3),
         fingerprint_status=CASE WHEN fingerprint_status='conflict' THEN 'conflict' ELSE $4 END,
         transmision=COALESCE(transmision,$5), cc=COALESCE(cc,$6), hp=COALESCE(hp,$7),
         combustible=COALESCE(combustible,$8), traccion=COALESCE(traccion,$9),
         carga_kg=COALESCE(carga_kg,$10), pasajeros=COALESCE(pasajeros,$11), euro=COALESCE(euro,$12),
         updated_at=now()
       WHERE price_version_id=$1`,
      [id, item.version_raw, item.source_sheet, status, item.transmision, item.cc, item.hp,
       item.combustible, item.traccion, item.carga_kg, item.pasajeros, item.euro],
    );
  }
  cache.set(key, id);
  return id;
}

async function persistCanonical(items) {
  const cache = new Map();
  let historyInserted = 0;
  for (const item of items) {
    const priceVersionId = await getPriceVersionId(item, cache);
    const rows = await queryDb(
      `INSERT INTO price_history (
         price_version_id, vigencia_desde, precio_neto, precio_lista, precio_con_iva,
         bono_cidef, bono_forum, bono_mes,
         precio_efectivo_pre_mes_sin_iva, precio_efectivo_pre_mes_con_iva,
         precio_efectivo_final_sin_iva, precio_efectivo_final_con_iva,
         source_file, source_sheet, source_row, raw_payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
       ON CONFLICT (price_version_id, vigencia_desde, source_file, source_sheet, source_row)
       DO NOTHING RETURNING price_history_id`,
      [priceVersionId, item.vigencia_desde, item.precio_neto, item.precio_lista, item.precio_con_iva,
       item.bono_cidef, item.bono_forum, item.bono_mes,
       item.precio_efectivo_pre_mes_sin_iva, item.precio_efectivo_pre_mes_con_iva,
       item.precio_efectivo_final_sin_iva, item.precio_efectivo_final_con_iva,
       item.source_file, item.source_sheet, item.source_row, JSON.stringify(item.raw_payload)],
    );
    if (rows.length) historyInserted += 1;
  }
  return { versionsTouched: cache.size, historyInserted };
}

function mergeVersionCandidates(items) {
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.marca}|${item.modelo}|${item.version}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...item, fingerprint_status: fingerprintStatus(item) });
      continue;
    }
    const hasConflict = current.fingerprint_status === 'conflict' || conflicts(current, item);
    for (const field of FP_FIELDS) {
      if (!current[field] && item[field]) current[field] = item[field];
    }
    if (!current.version_raw && item.version_raw) current.version_raw = item.version_raw;
    if (!current.source_sheet && item.source_sheet) current.source_sheet = item.source_sheet;
    current.fingerprint_status = hasConflict ? 'conflict' : fingerprintStatus(current);
  }
  return [...grouped.values()];
}

function sqlFingerprintConflict() {
  return FP_FIELDS.map((field) =>
    `(price_versions.${field} IS NOT NULL AND EXCLUDED.${field} IS NOT NULL AND UPPER(TRIM(price_versions.${field})) <> UPPER(TRIM(EXCLUDED.${field})))`
  ).join(' OR ');
}

async function upsertVersionsBulk(items) {
  const candidates = mergeVersionCandidates(items);
  const idByKey = new Map();
  const conflictSql = sqlFingerprintConflict();

  for (let offset = 0; offset < candidates.length; offset += VERSION_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + VERSION_BATCH_SIZE);
    const values = [];
    let p = 1;
    const tuples = batch.map((item) => {
      const tuple = [item.marca, item.modelo, item.version, item.version_raw, item.source_sheet,
        item.fingerprint_status, item.transmision, item.cc, item.hp, item.combustible,
        item.traccion, item.carga_kg, item.pasajeros, item.euro];
      values.push(...tuple);
      const refs = tuple.map((_, i) => `$${p + i}`);
      p += tuple.length;
      return `(${refs[0]},${refs[1]},${refs[2]},${refs[3]},${refs[4]},true,${refs[5]},${refs[6]},${refs[7]},${refs[8]},${refs[9]},${refs[10]},${refs[11]},${refs[12]},${refs[13]})`;
    });

    const rows = await queryDb(
      `INSERT INTO price_versions
       (marca, modelo, version, version_raw, source_sheet, activo, fingerprint_status,
        transmision, cc, hp, combustible, traccion, carga_kg, pasajeros, euro)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (marca, modelo, version) DO UPDATE SET
         activo=true,
         version_raw=COALESCE(price_versions.version_raw, EXCLUDED.version_raw),
         source_sheet=COALESCE(price_versions.source_sheet, EXCLUDED.source_sheet),
         fingerprint_status=CASE
           WHEN price_versions.fingerprint_status='conflict'
             OR EXCLUDED.fingerprint_status='conflict'
             OR ${conflictSql}
           THEN 'conflict'
           ELSE EXCLUDED.fingerprint_status
         END,
         transmision=COALESCE(price_versions.transmision, EXCLUDED.transmision),
         cc=COALESCE(price_versions.cc, EXCLUDED.cc),
         hp=COALESCE(price_versions.hp, EXCLUDED.hp),
         combustible=COALESCE(price_versions.combustible, EXCLUDED.combustible),
         traccion=COALESCE(price_versions.traccion, EXCLUDED.traccion),
         carga_kg=COALESCE(price_versions.carga_kg, EXCLUDED.carga_kg),
         pasajeros=COALESCE(price_versions.pasajeros, EXCLUDED.pasajeros),
         euro=COALESCE(price_versions.euro, EXCLUDED.euro),
         updated_at=now()
       RETURNING price_version_id, marca, modelo, version`,
      values,
    );

    for (const row of rows) {
      idByKey.set(`${row.marca}|${row.modelo}|${row.version}`, row.price_version_id);
    }
  }

  return { idByKey, versionsTouched: candidates.length };
}

async function insertHistoryBulk(items, idByKey) {
  let historyInserted = 0;
  let batchesProcessed = 0;

  for (let offset = 0; offset < items.length; offset += HISTORY_BATCH_SIZE) {
    const batch = items.slice(offset, offset + HISTORY_BATCH_SIZE);
    const values = [];
    let p = 1;
    const tuples = batch.map((item) => {
      const priceVersionId = idByKey.get(`${item.marca}|${item.modelo}|${item.version}`);
      if (!priceVersionId) throw new Error(`Missing price_version_id for ${item.marca}/${item.modelo}/${item.version}`);
      const tuple = [priceVersionId, item.vigencia_desde, item.precio_neto, item.precio_lista,
        item.precio_con_iva, item.bono_cidef, item.bono_forum, item.bono_mes,
        item.precio_efectivo_pre_mes_sin_iva, item.precio_efectivo_pre_mes_con_iva,
        item.precio_efectivo_final_sin_iva, item.precio_efectivo_final_con_iva,
        item.source_file, item.source_sheet, item.source_row, JSON.stringify(item.raw_payload)];
      values.push(...tuple);
      const refs = tuple.map((_, i) => `$${p + i}`);
      p += tuple.length;
      refs[15] = `${refs[15]}::jsonb`;
      return `(${refs.join(', ')})`;
    });

    const rows = await queryDb(
      `INSERT INTO price_history (
         price_version_id, vigencia_desde, precio_neto, precio_lista, precio_con_iva,
         bono_cidef, bono_forum, bono_mes,
         precio_efectivo_pre_mes_sin_iva, precio_efectivo_pre_mes_con_iva,
         precio_efectivo_final_sin_iva, precio_efectivo_final_con_iva,
         source_file, source_sheet, source_row, raw_payload
       ) VALUES ${tuples.join(', ')}
       ON CONFLICT (price_version_id, vigencia_desde, source_file, source_sheet, source_row)
       DO NOTHING RETURNING price_history_id`,
      values,
    );
    historyInserted += rows.length;
    batchesProcessed += 1;
  }

  return { historyInserted, batchesProcessed };
}

async function persistCanonicalBulk(items) {
  if (!items.length) return { versionsTouched: 0, historyInserted: 0, batchesProcessed: 0 };
  const versions = await upsertVersionsBulk(items);
  const history = await insertHistoryBulk(items, versions.idByKey);
  return {
    versionsTouched: versions.versionsTouched,
    historyInserted: history.historyInserted,
    batchesProcessed: history.batchesProcessed,
  };
}

async function fingerprintCounts() {
  const statuses = await queryDb(`SELECT fingerprint_status, count(*)::int AS n FROM price_versions GROUP BY fingerprint_status`);
  const count = (status) => statuses.find((r) => r.fingerprint_status === status)?.n || 0;
  return {
    fingerprintComplete: count('complete'),
    fingerprintPartial: count('partial'),
    fingerprintIncomplete: count('incomplete'),
    fingerprintConflicts: count('conflict'),
  };
}

function latestVigenciaCohort(normalized) {
  const dates = normalized.map((item) => item.vigencia_desde).filter(Boolean).sort();
  const latest = dates.at(-1) ?? null;
  if (!latest) return { latest: null, current: normalized, historical: [] };
  return {
    latest,
    current: normalized.filter((item) => item.vigencia_desde === latest),
    historical: normalized.filter((item) => item.vigencia_desde !== latest),
  };
}

function canonicalCoverage(normalized) {
  const byFile = new Map();
  const bySheet = new Map();

  for (const item of normalized) {
    const fileKey = item.source_file || '(unknown)';
    const sheetKey = `${fileKey}|${item.source_sheet || '(unknown)'}`;
    if (!byFile.has(fileKey)) byFile.set(fileKey, { file: fileKey, rows: 0, versions: new Set(), vigencias: new Set() });
    if (!bySheet.has(sheetKey)) bySheet.set(sheetKey, {
      file: fileKey, sheet: item.source_sheet || '(unknown)', rows: 0, versions: new Set(), vigencias: new Set(),
    });

    for (const bucket of [byFile.get(fileKey), bySheet.get(sheetKey)]) {
      bucket.rows += 1;
      bucket.versions.add(`${item.marca}|${item.modelo}|${item.version}`);
      bucket.vigencias.add(item.vigencia_desde);
    }
  }

  const render = (bucket) => ({
    file: bucket.file,
    ...(bucket.sheet ? { sheet: bucket.sheet } : {}),
    canonical_rows: bucket.rows,
    distinct_versions: bucket.versions.size,
    vigencias: [...bucket.vigencias].sort(),
  });

  return {
    canonicalRows: normalized.length,
    distinctCanonicalVersions: new Set(normalized.map((item) => `${item.marca}|${item.modelo}|${item.version}`)).size,
    coverageByFile: [...byFile.values()].map(render).sort((a, b) => a.file.localeCompare(b.file)),
    coverageBySheet: [...bySheet.values()].map(render).sort((a, b) =>
      a.file.localeCompare(b.file) || a.sheet.localeCompare(b.sheet)),
  };
}

export function auditNormalizedRecords(records, normalized) {
  const bySource = new Map();
  for (const item of normalized) {
    const key = `${item.source_file}|${item.source_sheet}`;
    if (!bySource.has(key)) bySource.set(key, new Set());
    bySource.get(key).add(item.vigencia_desde);
  }

  const compact = (r) => ({
    file: r.source_file,
    sheet: r.source_sheet,
    row: r.source_row,
    vigencia: r.vigencia,
    product_group: r.product_group,
    values: Object.fromEntries(
      Object.entries(r)
        .filter(([k, v]) => !['source_file','source_sheet','source_row','product_group','vigencia'].includes(k) && v != null && v !== '')
        .slice(0, 12)
    ),
  });

  // Diagnostic classification only. It does not change normalization or persistence.
  // The purpose is to distinguish harmless workbook structure from rows that may
  // represent a commercial condition lost by the current parser/normalizer.
  const PRICE_KEYS = [
    'precio_neto','precio_sin_i_v_a','precio_neto_8','precio_lista','precio_con_iva','precio_con_i_v_a',
    'precio_con_bonos_sin_i_v_a','precio_con_bonos_sin_iva','precio_con_bonos','precio_con_bono_sin_i_v_a',
    'precio_con_bonos_e_i_v_a','precio_con_bonos_e_iva','precio_con_bonos_con_i_v_a','precio_con_bonos_con_iva',
    'precio_con_bonos_sin_i_v_a_2','precio_con_bonos_sin_iva_2','precio_con_bonos_2',
    'precio_con_bonos_e_i_v_a_2','precio_con_bonos_e_iva_2','precio_con_bonos_con_i_v_a_2','precio_con_bonos_con_iva_2'
  ];
  const BONUS_KEYS = [
    'bono_cidef','bono_forum','bono_financiamiento','bono_financiamiento_global',
    'bono_enero','bono_febrero','bono_marzo','bono_abril','bono_mayo','bono_junio',
    'bono_julio','bono_agosto','bono_septiembre','bono_octubre','bono_noviembre','bono_diciembre'
  ];
  const hasValue = (r, keys) => keys.some((k) => r[k] != null && String(r[k]).trim() !== '');
  const hasNumericMoney = (r, keys) => keys.some((k) => parseClp(r[k]) != null);
  const hasProductSignal = (r) => Boolean(
    String(r.modelo ?? r.version ?? '').trim() ||
    ['linea_midi','linea_tm3','linea_tm5','wonder_2','linea_k1','linea_ft',
     'foton_g7_lite_euro_6','foton_g7_ultimate_euro_6','foton_g7_ultimate_at_euro_6',
     'g9_mt','g9_2','foton_v7_euro_6','foton_v9_euro_6','aeolus_y3_2','aeolus_gs_2',
     't5_2','t5_l','t5_evo_2','sx6_2','mage_2','mage_3','huge_2','precio_rich_6',
     'view_grand_cargo','view_grand_pasajero','g7_ev','s50_ev']
      .some((k) => r[k] != null && String(r[k]).trim() !== '')
  );

  const classifyRejected = (r) => {
    const vigencia = parseVigencia(r.vigencia);
    const money = hasNumericMoney(r, [...PRICE_KEYS, ...BONUS_KEYS]);
    const priceColumnsPresent = hasValue(r, PRICE_KEYS);
    const product = hasProductSignal(r);
    const payloadValues = Object.entries(r)
      .filter(([key, value]) =>
        !['source_file','source_sheet','source_row','product_group','vigencia'].includes(key) &&
        value != null && String(value).trim() !== ''
      )
      .map(([, value]) => String(value).trim());
    const legendLike = !money && payloadValues.length > 0 &&
      payloadValues.filter((value) => /^[A-Z0-9]{1,8}\s*=\s*\S+/i.test(value)).length >=
        Math.ceil(payloadValues.length * 0.6);

    if (legendLike) return 'NON_COMMERCIAL_ROW';
    if (!vigencia && money) return 'MISSING_VIGENCIA';
    if (vigencia && product && !money) return 'MISSING_PRICE';
    if (money || (vigencia && product) || priceColumnsPresent) return 'UNRECOGNIZED_LAYOUT';
    return 'NON_COMMERCIAL_ROW';
  };

  const rejected = [];
  const missingVigencia = [];
  const categories = new Map();
  for (const record of records) {
    const normalizedRecord = normalizePriceRecord(record);
    if (!record.vigencia) missingVigencia.push(record);
    if (!normalizedRecord) {
      const reason = classifyRejected(record);
      const item = { reason, ...compact(record) };
      rejected.push(item);
      if (!categories.has(reason)) categories.set(reason, []);
      categories.get(reason).push(item);
    }
  }

  const grouped = new Map();
  for (const r of rejected) {
    const key = `${r.file}|${r.sheet}`;
    if (!grouped.has(key)) grouped.set(key, { file: r.file, sheet: r.sheet, count: 0, reasons: {}, samples: [] });
    const g = grouped.get(key);
    g.count += 1;
    g.reasons[r.reason] = (g.reasons[r.reason] || 0) + 1;
    if (g.samples.length < 5) g.samples.push(r);
  }

  const rejectedByReason = [...categories.entries()]
    .map(([reason, rows]) => ({ reason, count: rows.length, rows }))
    .sort((a, b) => b.count - a.count);

  const sourceBlocks = [...bySource.entries()].map(([source, dates]) => ({
    source,
    vigencias: [...dates].sort(),
  }));

  const blockingRejected = rejected.filter((row) => COMMERCIAL_REJECTION_REASONS.has(row.reason));

  return {
    rowsStaged: records.length,
    rowsNormalized: normalized.length,
    blockingRejectedRows: blockingRejected.length,
    blockingRejectedByReason: Object.fromEntries(
      [...COMMERCIAL_REJECTION_REASONS].map((reason) => [reason, categories.get(reason)?.length ?? 0])
    ),
    rowsRejected: rejected.length,
    rowsWithoutDeclaredVigencia: missingVigencia.length,
    ...canonicalCoverage(normalized),
    rejectedByReason,
    rejectedBySource: [...grouped.values()].sort((a, b) => b.count - a.count),
    missingVigenciaRows: missingVigencia.map(compact),
    sourceBlocks,
  };
}

export async function run(input = {}) {
  const startedAt = Date.now();
  if (input?.full_rebuild === true) {
    throw new Error('FULL_HISTORICAL_SOURCE_REBUILD_DISABLED: use append-only pricing ingestion');
  }
  await ensurePriceSchema();

  const resumeRunId = typeof input?.resume_run_id === 'string' ? input.resume_run_id.trim() : '';

  if (resumeRunId) {
    try {
      const staged = await loadAllStagedRecords(resumeRunId);
      const normalized = staged.records.map(normalizePriceRecord).filter(Boolean);
      const audit = auditNormalizedRecords(staged.records, normalized);
      if (audit.blockingRejectedRows > 0) {
        throw new Error(`PRICING_SOURCE_VALIDATION_FAILED: ${audit.blockingRejectedRows} commercial rows rejected; staging preserved`);
      }
      const result = await persistCanonicalBulk(normalized);

      await queryDb(`DELETE FROM ${STAGING_TABLE} WHERE run_id = $1`, [resumeRunId]);

      return {
        runId: resumeRunId,
        resumed: true,
        mode: 'INTERNAL_LOOP_BULK',
        filesLoaded: staged.filesLoaded,
        rowsStaged: staged.records.length,
        rowsNormalized: normalized.length,
        rowsRejected: staged.records.length - normalized.length,
        ...result,
        remainingRows: 0,
        complete: true,
        ...(await fingerprintCounts()),
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw new Error(`Price import resume failed; staging preserved for run ${resumeRunId}: ${error.message}`);
    }
  }

  const runId = randomUUID();
  const normalizeName = (value) => String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/gi, ' ')
    .trim().toUpperCase();

  const files = Array.isArray(input?.workbook_files)
    ? input.workbook_files.map((file) => ({
        name: String(file?.name ?? '').trim(),
        path: String(file?.path ?? '').trim(),
      })).filter((file) => file.name && file.path)
    : [];
  if (!files.length) throw new Error('No Azure Blob price workbook supplied');


  const records = [];
  const sheetJson = [];
  for (const file of files) {
    const buffer = await readFile(file.path);
    if (input?.sheet_json === true) {
      sheetJson.push(...workbookToSheetJson(buffer, file.name));
    } else {
      records.push(...parsePriceWorkbook(buffer, file.name).records);
    }
  }

  if (input?.sheet_json === true) {
    return {
      runId,
      dryRun: true,
      mode: 'SHEET_JSON',
      filesLoaded: files.length,
      sheetsLoaded: sheetJson.length,
      sheets: sheetJson,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // The generic "FOTON" sheet in current workbooks is a legacy embedded price list
  // (e.g. vigencia 2020-09-08 in the October 2026 workbook), not part of the
  // operational price-list surfaces. Exclude it before normalization/persistence.
  const operationalRecords = records.filter((record) => norm(record.source_sheet) !== 'FOTON');
  const normalized = operationalRecords.map(normalizePriceRecord).filter(Boolean);
  const audit = auditNormalizedRecords(operationalRecords, normalized);
  const cohort = latestVigenciaCohort(normalized);
  const includeHistorical = input?.include_historical === true;
  const persistable = includeHistorical ? normalized : cohort.current;

  if (input?.dry_run === true) {
    return {
      runId,
      dryRun: true,
      filesLoaded: files.length,
      ...audit,
      operationalVigencia: cohort.latest,
      rowsEligibleForPersistence: persistable.length,
      historicalRowsSkipped: includeHistorical ? 0 : cohort.historical.length,
      historicalVigenciasSkipped: includeHistorical
        ? []
        : [...new Set(cohort.historical.map((item) => item.vigencia_desde))].sort(),
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (audit.blockingRejectedRows > 0) {
    throw new Error(`PRICING_SOURCE_VALIDATION_FAILED: ${audit.blockingRejectedRows} commercial rows rejected; nothing persisted`);
  }

  await stageRecords(runId, records);

  try {
    const result = await persistCanonicalBulk(persistable);
    await queryDb(`DELETE FROM ${STAGING_TABLE} WHERE run_id = $1`, [runId]);
    return {
      runId,
      resumed: false,
      filesLoaded: files.length,
      rowsStaged: records.length,
      rowsNormalized: normalized.length,
      rowsRejected: records.length - normalized.length,
      operationalVigencia: cohort.latest,
      rowsEligibleForPersistence: persistable.length,
      historicalRowsSkipped: includeHistorical ? 0 : cohort.historical.length,
      historicalVigenciasSkipped: includeHistorical
        ? []
        : [...new Set(cohort.historical.map((item) => item.vigencia_desde))].sort(),
      ...result,
      ...(await fingerprintCounts()),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    throw new Error(`Price import failed; staging preserved for run ${runId}: ${error.message}`);
  }
}
