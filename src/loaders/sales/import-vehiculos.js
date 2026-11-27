// Adapted from cidef-data-loader; only Azure I/O changes.
import { findDailyXlsx, downloadBlobObject, blobSource } from './source-io.js';
import { parseSheet } from './xlsx.js';
import {
  beginTableSnapshot,
  appendTableRows,
  commitTableSnapshot,
  abortTableSnapshot,
  queryDb,
  quoteIdent,
} from './db.js';
import { cleanVehicleSource } from './vehicle-source-cleaning.js';
import {
  preserveVehicleLifecycleInSnapshot,
  syncVehiculosFromRvm,
} from './sync-vehiculos-rvm.js';

const FILE_PREFIX = 'ventas/Base_Unidades_por_Vistas_';
const SHEET_NAME = 'Inventario Vehiculos Global';
const TABLE_NAME = 'vehiculos_raw';


export function vehicleChangesSql(staging, fields) {
  if (!fields.some(field => field.name === 'vin_chasis')) throw new Error('VIN column required');
  const stage = quoteIdent(staging);
  const differing = fields.map(({ name, type }) =>
    `v.${quoteIdent(name)} IS DISTINCT FROM s.${quoteIdent(name)}::${type}`).join(' OR ');
  return `SELECT array_agg(DISTINCT upper(btrim(s.vin_chasis))) AS vins
    FROM ${stage} s
    LEFT JOIN public.vehiculos_raw v
      ON upper(btrim(v.vin_chasis))=upper(btrim(s.vin_chasis))
    WHERE s.vin_chasis IS NOT NULL AND btrim(s.vin_chasis)<>''
      AND (v.vin_chasis IS NULL OR ${differing})`;
}

export async function run({ skipRvmSync = false } = {}) {
  const startedAt = Date.now();
  const file = await findDailyXlsx(FILE_PREFIX);
  const buffer = await downloadBlobObject(file.Key);
  const { columns, rows } = parseSheet(buffer, SHEET_NAME);

  const snapshot = await beginTableSnapshot(TABLE_NAME, columns);
  try {
    const loaded = await appendTableRows(snapshot, rows);
    const cleaned = await cleanVehicleSource(snapshot.staging);
    if (!cleaned.after) throw new Error("Empty cleaned vehicle snapshot blocked");
    await preserveVehicleLifecycleInSnapshot(snapshot.staging);
    // El archivo diario puede omitir VIN antiguos: conservarlos del RAW existente.
    const existingColumns = await queryDb(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
    `, [TABLE_NAME]);
    const sourceColumns = new Set(existingColumns.map(row => row.column_name));
    const stagingColumns = await queryDb(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position
    `, [snapshot.staging]);
    const shared = stagingColumns.map(row => row.column_name).filter(name => sourceColumns.has(name));
    const names = shared.map(quoteIdent).join(', ');
    const [historical] = await queryDb(`
      WITH preserved AS (
        INSERT INTO ${quoteIdent(snapshot.staging)} (${names})
        SELECT ${shared.map(name => 'v.' + quoteIdent(name)).join(', ')}
        FROM public.vehiculos_raw v
        WHERE NOT EXISTS (
          SELECT 1 FROM ${quoteIdent(snapshot.staging)} s
          WHERE upper(btrim(s.vin_chasis)) = upper(btrim(v.vin_chasis))
        )
        RETURNING 1
      )
      SELECT count(*)::int AS rows_preserved FROM preserved
    `);
    // Compare after cleaning, lifecycle preservation and historical VIN carry-forward.
    // Only return changed VIN identities; the existing replacement remains unchanged.
    const targetFields = await queryDb(`
      SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type
      FROM pg_attribute a
      WHERE a.attrelid='public.vehiculos_raw'::regclass AND a.attnum>0 AND NOT a.attisdropped
    `);
    const typed = targetFields.filter(field => shared.includes(field.name));
    const [delta] = await queryDb(vehicleChangesSql(snapshot.staging, typed));
    const changedVins = delta.vins || [];
    await commitTableSnapshot(snapshot);
    if (!skipRvmSync) await syncVehiculosFromRvm();
    return {
      source: blobSource(file),
      sheet: SHEET_NAME,
      table: TABLE_NAME,
      strategy: 'LATEST_VINS_WITH_HISTORICAL_PRESERVED',
      rowsPreserved: historical.rows_preserved,
      changedVins,
      changedVinCount: changedVins.length,
      rowsLoaded: rows.length,
      rowsFinal: cleaned.after,
      columnsFinal: cleaned.kept_columns.length,
      batchSize: loaded.batchSize,
      cleaned,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    await abortTableSnapshot(snapshot);
    throw error;
  }
}
