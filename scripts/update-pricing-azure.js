import path from 'node:path';
import { parsePriceWorkbook } from './pricing/price-list.js';
import { normalizePriceRecord } from './pricing/price-normalizer.js';
import { run as importPrices, auditNormalizedRecords } from './pricing/import-lista-precios-azure.js';
import { getAzurePool } from '../lib/azure-postgres.js';

const expectedDate = '2026-10-14';
const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: node scripts/update-pricing-azure.js <downloaded-xlsb-path>');
const sourceFile = path.basename(inputPath);
if (!/LISTA.*PRECIOS.*14[-_ ]?10[-_ ]?2026/i.test(sourceFile.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
  throw new Error(`Unexpected pricing source file name: ${sourceFile}`);
}

const { records } = parsePriceWorkbook(await import('node:fs/promises').then(({ readFile }) => readFile(inputPath)), sourceFile);
const operationalRecords = records.filter((row) => String(row.source_sheet ?? '').trim().toUpperCase() !== 'FOTON');
const normalized = operationalRecords.map(normalizePriceRecord).filter(Boolean);
const audit = auditNormalizedRecords(operationalRecords, normalized);
if (audit.blockingRejectedRows > 0) {
  throw new Error(`PRICING_SOURCE_VALIDATION_FAILED: ${audit.blockingRejectedRows} commercial rows rejected; no Azure writes performed`);
}
const current = normalized.filter((row) => row.vigencia_desde === expectedDate);
if (!current.length) throw new Error(`No normalized pricing rows for ${expectedDate}`);
const dongfeng007 = current.find((row) => row.marca === 'DONGFENG' && row.modelo === '007' && row.version === '007 Automática');
const dongfeng008 = current.find((row) => row.marca === 'DONGFENG' && row.modelo === '008' && row.version === '008 Automática');
if (!dongfeng007 || dongfeng007.precio_lista !== 27890000 || dongfeng007.bono_forum !== 900000 || dongfeng007.precio_efectivo_final_sin_iva !== 23990000) {
  throw new Error('DONGFENG 007 source row did not match the certified 2026-10-14 values');
}
if (!dongfeng008 || dongfeng008.precio_lista !== 32590000 || dongfeng008.bono_forum !== 1000000 || dongfeng008.precio_efectivo_final_sin_iva !== 28990000) {
  throw new Error('DONGFENG 008 source row did not match the certified 2026-10-14 values');
}

const pool = getAzurePool();
const priorPricingResult = await pool.query(
  `SELECT COUNT(*)::int AS history_rows,
          COUNT(DISTINCT price_version_id)::int AS versions,
          COUNT(DISTINCT (price_version_id, source_sheet, source_row))::int AS source_rows
     FROM price_history
    WHERE source_file=$1 AND vigencia_desde=$2::date`,
  [sourceFile, expectedDate],
);
const priorDongfengResult = await pool.query(
  `SELECT pv.modelo,COALESCE(pv.version_raw,pv.version) AS version,
          ph.precio_lista,ph.bono_forum,ph.precio_efectivo_final_sin_iva,
          ph.source_sheet,ph.source_row
     FROM price_history ph
     JOIN price_versions pv USING(price_version_id)
    WHERE ph.source_file=$1 AND ph.vigencia_desde=$2::date
      AND pv.marca='DONGFENG' AND pv.modelo IN ('007','008')
    ORDER BY pv.modelo,ph.source_sheet,ph.source_row`,
  [sourceFile, expectedDate],
);
const pricingPresentBefore = {
  ...priorPricingResult.rows[0],
  dongfeng_007_008: priorDongfengResult.rows,
};

const importResult = await importPrices({ workbook_files: [{ name: sourceFile, path: inputPath }] });
const masterText = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
const uniqueProducts = new Map();
for (const item of current) uniqueProducts.set([item.marca, item.modelo, item.version].join('|'), item);

const client = await pool.connect();
const inserted = { brands: 0, models: 0, versions: 0, aliases: 0 };
const canonicalVersionReuses = [];
const productIds = [];
try {
  await client.query('BEGIN');
  for (const item of uniqueProducts.values()) {
    const marca = masterText(item.marca);
    const modelo = masterText(item.modelo);
    const version = masterText(item.version);
    await client.query(
      `INSERT INTO marcas_master_v01 (nombre_canonico,nombre_normalizado)
       VALUES ($1,$2) ON CONFLICT (nombre_normalizado) DO NOTHING`, [item.marca, marca]);
    const brand = (await client.query(
      `SELECT marca_id,nombre_canonico FROM marcas_master_v01 WHERE nombre_normalizado=$1`, [marca])).rows;
    if (brand.length !== 1 || brand[0].nombre_canonico !== item.marca) {
      throw new Error(`Conflicting canonical brand identity: ${item.marca}`);
    }
    const marcaId = brand[0].marca_id;

    const modelBefore = (await client.query(
      `SELECT modelo_id,nombre_canonico FROM modelos_master_v01 WHERE marca_id=$1 AND nombre_normalizado=$2`,
      [marcaId, modelo])).rows;
    if (!modelBefore.length) inserted.models++;
    await client.query(
      `INSERT INTO modelos_master_v01 (marca_id,nombre_canonico,nombre_normalizado)
       VALUES ($1,$2,$3) ON CONFLICT (marca_id,nombre_normalizado) DO NOTHING`,
      [marcaId, item.modelo, modelo]);
    const model = (await client.query(
      `SELECT modelo_id,nombre_canonico FROM modelos_master_v01 WHERE marca_id=$1 AND nombre_normalizado=$2`,
      [marcaId, modelo])).rows;
    if (model.length !== 1 || model[0].nombre_canonico !== item.modelo) {
      throw new Error(`Conflicting canonical model identity: ${item.marca}/${item.modelo}`);
    }
    const modeloId = model[0].modelo_id;

    const versionBefore = (await client.query(
      `SELECT version_id,nombre_canonico FROM versiones_master_v01 WHERE modelo_id=$1 AND nombre_normalizado=$2`,
      [modeloId, version])).rows;
    if (!versionBefore.length) inserted.versions++;
    await client.query(
      `INSERT INTO versiones_master_v01 (modelo_id,nombre_canonico,nombre_normalizado)
       VALUES ($1,$2,$3) ON CONFLICT (modelo_id,nombre_normalizado) DO NOTHING`,
      [modeloId, item.version, version]);
    const versionRows = (await client.query(
      `SELECT version_id,nombre_canonico FROM versiones_master_v01 WHERE modelo_id=$1 AND nombre_normalizado=$2`,
      [modeloId, version])).rows;
    if (versionRows.length !== 1) {
      throw new Error(`Conflicting canonical version identity: ${item.marca}/${item.modelo}/${item.version}`);
    }
    const canonicalVersion = versionRows[0].nombre_canonico;
    if (masterText(canonicalVersion) !== masterText(item.version)) {
      throw new Error(`Conflicting canonical version identity: ${item.marca}/${item.modelo}/${item.version} (existing: ${canonicalVersion})`);
    }
    const versionId = versionRows[0].version_id;
    if (canonicalVersion !== item.version) {
      canonicalVersionReuses.push({
        marca:item.marca,modelo:item.modelo,received:item.version,
        canonical:canonicalVersion,version_id:versionId,
      });
    }
    const aliases = (await client.query(
      `SELECT alias_id,version_id,estado FROM producto_aliases_v01
       WHERE fuente='lista_precios' AND nivel='VERSION'
         AND contexto_marca_raw=$1 AND contexto_modelo_raw=$2 AND valor_raw=$3`,
      [item.marca,item.modelo,item.version_raw ?? item.version])).rows;
    if (aliases.length > 1 || (aliases.length === 1 && aliases[0].version_id != null && String(aliases[0].version_id) !== String(versionId))) {
      throw new Error(`Conflicting price alias: ${item.marca}/${item.modelo}/${item.version}`);
    }
    if (!aliases.length) {
      await client.query(
        `INSERT INTO producto_aliases_v01 (
          nivel,fuente,valor_raw,valor_normalizado,contexto_marca_raw,contexto_modelo_raw,
          marca_id,modelo_id,version_id,evidencia_tipo,evidencia_count,primera_observacion,
          ultima_observacion,estado
        ) VALUES ('VERSION','lista_precios',$1,$2,$3,$4,$5,$6,$7,'PRICE_VERSION_EXACT',1,$8,$8,'RESUELTO')`,
        [item.version_raw ?? item.version, masterText(item.version_raw ?? item.version),
         item.marca,item.modelo,marcaId,modeloId,versionId,item.vigencia_desde]);
      inserted.aliases++;
    } else if (aliases[0].version_id == null || aliases[0].estado !== 'RESUELTO') {
      await client.query(
        `UPDATE producto_aliases_v01 SET valor_normalizado=$1,marca_id=$2,modelo_id=$3,version_id=$4,
          evidencia_tipo='PRICE_VERSION_EXACT',evidencia_count=1,primera_observacion=$5,
          ultima_observacion=$5,estado='RESUELTO',updated_at=now() WHERE alias_id=$6`,
        [masterText(item.version_raw ?? item.version),marcaId,modeloId,versionId,item.vigencia_desde,aliases[0].alias_id]);
    }
    if (item.marca === 'DONGFENG' && ['007','008'].includes(item.modelo)) {
      productIds.push({ marca:item.marca,modelo:item.modelo,version:item.version,marca_id:marcaId,modelo_id:modeloId,version_id:versionId });
    }
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
console.log(JSON.stringify({
  engine:'Azure append-only pricing import',
  source_file:sourceFile,
  operational_vigencia:expectedDate,
  pricing_present_before:pricingPresentBefore,
  rows_staged:importResult.rowsStaged,
  rows_normalized:importResult.rowsNormalized,
  price_versions_touched:importResult.versionsTouched,
  price_history_inserted:importResult.historyInserted,
  masters_added:inserted,
  canonical_version_reuses:canonicalVersionReuses,
  dongfeng_products:productIds,
  audit:{blockingRejectedRows:audit.blockingRejectedRows,rowsWithoutDeclaredVigencia:audit.rowsWithoutDeclaredVigencia}
},null,2));
