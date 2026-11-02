import { rvmDb } from './rvm-db.js';

const FINAL = 'rvm_raw';
const STAGE = 'rvm_stage_raw';
const KEEP = [
  'ano','mes','dia','tipo_original','tipo','descripcion_tipo','descripcion_segmento','marca',
  'modelo_homologado','modeo_version','ano_fabricacion','region','combustible','pbv',
  'n_puertas','n_asientos','carga','comuna_adquisicion','region_propietario','prenda','vin',
  'n_chasis','patente','calidad','ano_vin','pais_vin','preinscrito','cantidad'
];

function db() {
  return rvmDb();
}
const qi = (v) => `"${String(v).replace(/"/g, '""')}"`;

export async function ensureFinalSchema() {
  const sql = db();
  await sql.query(`
    CREATE TABLE IF NOT EXISTS ${FINAL} (
      ano integer, mes integer, dia integer,
      tipo_original text, tipo text, descripcion_tipo text, descripcion_segmento text,
      marca text, modelo_homologado text, modeo_version text, ano_fabricacion integer,
      region text, combustible text, pbv text, n_puertas integer, n_asientos integer,
      carga numeric, comuna_adquisicion text, region_propietario text, prenda text,
      vin text, n_chasis text, patente text, calidad text, ano_vin integer,
      pais_vin text, preinscrito text, cantidad integer, fecha date,
      documento_origen text, fecha_creacion_documento timestamptz,
      fecha_ingesta timestamptz, source_row integer
    )
  `);
  const additions = [
    ['tipo_original', 'text'], ['descripcion_tipo', 'text'], ['region', 'text'], ['pbv', 'text'],
    ['n_puertas', 'integer'], ['n_asientos', 'integer'], ['carga', 'numeric'], ['ano_vin', 'integer'],
    ['documento_origen', 'text'], ['fecha_creacion_documento', 'timestamptz'],
    ['fecha_ingesta', 'timestamptz'], ['source_row', 'integer'],
    ['data_status', 'text'], ['snapshot_date', 'date'],
  ];
  for (const [column, type] of additions) {
    await sql.query(`ALTER TABLE ${FINAL} ADD COLUMN IF NOT EXISTS ${qi(column)} ${type}`);
  }
  await sql.query(`UPDATE ${FINAL} SET data_status='CONSOLIDATED' WHERE data_status IS NULL`);
}

export async function documentLoaded(name) {
  const sql = db();
  const [r] = await sql.query(
    `SELECT EXISTS(SELECT 1 FROM ${FINAL} WHERE documento_origen=$1) AS loaded`,
    [name],
  );
  return r.loaded;
}

export async function clearDocumentRange(name, rowFrom, rowTo) {
  const sql = db();
  await sql.query(
    `DELETE FROM ${FINAL}
     WHERE documento_origen=$1
       AND source_row BETWEEN $2 AND $3`,
    [name, rowFrom, rowTo],
  );
}

export async function documentPeriod(name) {
  const sql = db();
  return sql.query(
    `SELECT DISTINCT ano::int AS year, mes::int AS month
     FROM ${FINAL}
     WHERE documento_origen=$1 AND data_status='CONSOLIDATED'
     ORDER BY year,month`,
    [name],
  );
}

export async function clearPreliminaryCoveredByDocument(name) {
  const sql = db();
  const result = await sql.query(
    `DELETE FROM ${FINAL} p
     WHERE p.data_status='PRELIMINARY'
       AND EXISTS (
         SELECT 1
         FROM ${FINAL} c
         WHERE c.documento_origen=$1
           AND c.data_status='CONSOLIDATED'
           AND c.ano=p.ano
           AND c.mes=p.mes
       )
     RETURNING 1`,
    [name],
  );
  return result.length;
}

export async function resetStage() {
  const sql = db();
  await sql.query(`DROP TABLE IF EXISTS ${STAGE}`);
  await sql.query(`CREATE TABLE ${STAGE} (mercado text, source_row integer, ${KEEP.map(c => `${qi(c)} text`).join(',')})`);
}

export async function appendStage(rows) {
  if (!rows.length) return;
  const sql = db();
  const cols = ['mercado','source_row',...KEEP];
  const values = [];
  let p = 1;
  const tuples = rows.map(row => `(${row.map(v => { values.push(v); return `$${p++}`; }).join(',')})`);
  await sql.query(`INSERT INTO ${STAGE} (${cols.map(qi).join(',')}) VALUES ${tuples.join(',')}`, values);
}

export async function normalizeAndAppend(file, replacePeriod = null) {
  const sql = db();
  const [{ before_count: beforeCount }] = await sql.query(
    `SELECT COUNT(*)::int AS before_count FROM ${FINAL} WHERE documento_origen=$1`,
    [file.name],
  );
  if (replacePeriod) {
    await sql.query('BEGIN');
    try {
      await sql.query(
        `DELETE FROM ${FINAL}
         WHERE ano=$1 AND mes=$2 AND data_status='CONSOLIDATED'`,
        [replacePeriod.year, replacePeriod.month],
      );
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    }
  }
  try {
  await sql.query(`
    INSERT INTO ${FINAL} (${KEEP.map(qi).join(',')},fecha,documento_origen,fecha_creacion_documento,fecha_ingesta,source_row,data_status,snapshot_date)
    SELECT
      NULLIF(trim(ano),'')::int,NULLIF(trim(mes),'')::int,NULLIF(trim(dia),'')::int,
      upper(trim(tipo_original)),upper(trim(tipo)),upper(trim(descripcion_tipo)),upper(trim(descripcion_segmento)),
      upper(trim(marca)),upper(trim(modelo_homologado)),upper(trim(modeo_version)),
      CASE WHEN trim(ano_fabricacion)~'^\\d{4}$' THEN trim(ano_fabricacion)::int END,
      upper(regexp_replace(trim(region),'\\s+',' ','g')),upper(trim(combustible)),upper(trim(pbv)),
      CASE WHEN trim(n_puertas)~'^-?\\d+$' THEN trim(n_puertas)::int END,
      CASE WHEN trim(n_asientos)~'^-?\\d+$' THEN trim(n_asientos)::int END,
      CASE WHEN trim(carga)~'^-?\\d+(\\.\\d+)?$' THEN trim(carga)::numeric END,
      upper(regexp_replace(trim(comuna_adquisicion),'\\s+',' ','g')),
      upper(regexp_replace(trim(region_propietario),'\\s+',' ','g')),upper(trim(prenda)),upper(trim(vin)),upper(trim(n_chasis)),
      upper(trim(patente)),upper(trim(calidad)),
      CASE WHEN trim(ano_vin)~'^\\d{4}$' THEN trim(ano_vin)::int END,
      upper(trim(pais_vin)),upper(trim(preinscrito)),
      CASE WHEN trim(cantidad)~'^-?\\d+$' THEN trim(cantidad)::int END,
      make_date(trim(ano)::int,trim(mes)::int,trim(dia)::int),$1,$2::timestamptz,now(),source_row,'CONSOLIDATED',NULL::date
    FROM ${STAGE}
    WHERE trim(mercado)='Livianos y Medianos'
  `, [file.name, file.createdTime ?? file.modifiedTime ?? null]);
  const [{ count }] = await sql.query(`SELECT COUNT(*)::int AS count FROM ${FINAL} WHERE documento_origen=$1`, [file.name]);
  await sql.query(`DROP TABLE IF EXISTS ${STAGE}`);
  if (replacePeriod) await sql.query('COMMIT');
  return Number(count) - Number(beforeCount);
  } catch (error) {
    if (replacePeriod) await sql.query('ROLLBACK');
    throw error;
  }
}

export { KEEP };
