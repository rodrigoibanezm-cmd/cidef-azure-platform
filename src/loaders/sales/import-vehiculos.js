// Adapted from cidef-data-loader; only Azure I/O changes.
import { findDailyXlsx, downloadBlobObject, blobSource } from './source-io.js';
import { parseSheet } from './xlsx.js';
import {
  beginTableSnapshot,
  appendTableRows,
  commitTableSnapshot,
  abortTableSnapshot,
} from './db.js';
import { cleanVehicleSource } from './vehicle-source-cleaning.js';
import {
  preserveVehicleLifecycleInSnapshot,
  syncVehiculosFromRvm,
} from './sync-vehiculos-rvm.js';

const FILE_PREFIX = 'ventas/Base_Unidades_por_Vistas_';
const SHEET_NAME = 'Inventario Vehiculos Global';
const TABLE_NAME = 'vehiculos_raw';

export async function run() {
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
    await commitTableSnapshot(snapshot);
    await syncVehiculosFromRvm();
    return {
      source: blobSource(file),
      sheet: SHEET_NAME,
      table: TABLE_NAME,
      strategy: 'FULL_SNAPSHOT_REPLACE',
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
