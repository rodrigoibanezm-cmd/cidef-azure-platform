import path from 'node:path';
import { parsePriceWorkbook } from './pricing/price-list.js';
import { normalizePriceRecord } from './pricing/price-normalizer.js';
import { run as importPrices, auditNormalizedRecords } from './pricing/import-lista-precios-azure.js';
import { priceEpisodeCanonicalizerV01 } from './pricing/price-episode-canonicalizer-v01.js';
import { closeAzurePool, getAzurePool } from '../lib/azure-postgres.js';

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
const afterPricingResult = await pool.query(
  `SELECT COUNT(*)::int AS history_rows,
          COUNT(DISTINCT price_version_id)::int AS versions,
          COUNT(DISTINCT (price_version_id, source_sheet, source_row))::int AS source_rows
     FROM price_history
    WHERE source_file=$1 AND vigencia_desde=$2::date`,
  [sourceFile, expectedDate],
);
const afterDongfengResult = await pool.query(
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
const pricingAfterImport = {
  ...afterPricingResult.rows[0],
  dongfeng_007_008: afterDongfengResult.rows,
};
console.log(JSON.stringify({
  stage:'price_history_import_committed',
  source_file:sourceFile,
  vigencia:expectedDate,
  pricing_present_before:pricingPresentBefore,
  pricing_after_import:pricingAfterImport,
  rows_staged:importResult.rowsStaged,
  rows_normalized:importResult.rowsNormalized,
  price_versions_touched:importResult.versionsTouched,
  price_history_inserted:importResult.historyInserted,
},null,2));
const masterText = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
const normalizeProductText = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');
const uniqueProducts = new Map();
for (const item of current) uniqueProducts.set([item.marca, item.modelo, item.version].join('|'), item);

const client = await pool.connect();
const inserted = { brands: 0, models: 0, versions: 0, aliases: 0 };
const canonicalVersionReuses = [];
const aliasCorrections = [];
const aliasResolutions = [];
const productIds = [];
try {
  await client.query('BEGIN');
  const aliasRows = (await client.query(
    `SELECT pa.alias_id,pa.version_id,pa.estado,pa.valor_raw,
            pa.contexto_marca_raw,pa.contexto_modelo_raw,
            vm.modelo_id AS mapped_modelo_id,mo.marca_id AS mapped_marca_id,
            vm.nombre_canonico AS mapped_version
       FROM producto_aliases_v01 pa
       LEFT JOIN versiones_master_v01 vm ON vm.version_id=pa.version_id
       LEFT JOIN modelos_master_v01 mo ON mo.modelo_id=vm.modelo_id
      WHERE pa.fuente='lista_precios' AND pa.nivel='VERSION'`,
  )).rows;
  const masterRows = (await client.query(
    `SELECT v.version_id,v.nombre_canonico AS version_canonica,v.nombre_normalizado AS version_normalizada,
            mo.modelo_id,mo.nombre_canonico AS modelo_canonico,mo.nombre_normalizado AS modelo_normalizado,
            ma.marca_id,ma.nombre_canonico AS marca_canonica,ma.nombre_normalizado AS marca_normalizada
       FROM versiones_master_v01 v
       JOIN modelos_master_v01 mo ON mo.modelo_id=v.modelo_id
       JOIN marcas_master_v01 ma ON ma.marca_id=mo.marca_id`,
  )).rows;
  for (const item of uniqueProducts.values()) {
    const marca = masterText(item.marca);
    const modelo = masterText(item.modelo);
    const version = masterText(item.version);
    const inputAliasKey = [
      normalizeProductText(item.marca),
      normalizeProductText(item.modelo),
      normalizeProductText(item.version_raw ?? item.version),
    ].join('|');
    const aliases = aliasRows.filter((alias) => [
      normalizeProductText(alias.contexto_marca_raw),
      normalizeProductText(alias.contexto_modelo_raw),
      normalizeProductText(alias.valor_raw),
    ].join('|') === inputAliasKey);
    const resolvedTargets = [...new Set(aliases
      .filter((alias) => String(alias.estado).toUpperCase() === 'RESUELTO' && alias.version_id != null)
      .map((alias) => String(alias.version_id)))];
    if (resolvedTargets.length > 1) {
      throw new Error(`Ambiguous price alias ${item.marca}/${item.modelo}/${item.version}: ${resolvedTargets.join(',')}`);
    }

    let marcaId;
    let modeloId;
    let versionId;
    let canonicalVersion;
    const exactMasterKey = [
      normalizeProductText(item.marca),normalizeProductText(item.modelo),normalizeProductText(item.version),
    ].join('|');
    const exactMasterCandidates = masterRows.filter((row) => [
      normalizeProductText(row.marca_canonica ?? row.marca_normalizada),
      normalizeProductText(row.modelo_canonico ?? row.modelo_normalizado),
      normalizeProductText(row.version_canonica ?? row.version_normalizada),
    ].join('|') === exactMasterKey);
    if (!resolvedTargets.length && exactMasterCandidates.length > 1) {
      throw new Error(`Ambiguous exact product master ${item.marca}/${item.modelo}/${item.version}: ${exactMasterCandidates.map((row) => row.version_id).join(',')}`);
    }
    if (resolvedTargets.length === 1) {
      const target = aliases.find((alias) => String(alias.version_id) === resolvedTargets[0]);
      if (target.mapped_modelo_id == null || target.mapped_marca_id == null || !target.mapped_version) {
        throw new Error(`Resolved price alias points to missing master identity: ${item.marca}/${item.modelo}/${item.version}`);
      }
      marcaId = target.mapped_marca_id;
      modeloId = target.mapped_modelo_id;
      versionId = target.version_id;
      canonicalVersion = target.mapped_version;
      aliasResolutions.push({
        marca:item.marca,modelo:item.modelo,version:item.version,
        alias_id:target.alias_id,version_id:versionId,canonical_version:canonicalVersion,
      });
    } else if (exactMasterCandidates.length === 1) {
      const identity = exactMasterCandidates[0];
      marcaId = identity.marca_id;
      modeloId = identity.modelo_id;
      versionId = identity.version_id;
      canonicalVersion = identity.version_canonica;
    } else {
      await client.query(
        `INSERT INTO marcas_master_v01 (nombre_canonico,nombre_normalizado)
         VALUES ($1,$2) ON CONFLICT (nombre_normalizado) DO NOTHING`, [item.marca, marca]);
      const brand = (await client.query(
        `SELECT marca_id,nombre_canonico FROM marcas_master_v01 WHERE nombre_normalizado=$1`, [marca])).rows;
      if (brand.length !== 1 || brand[0].nombre_canonico !== item.marca) {
        throw new Error(`Conflicting canonical brand identity: ${item.marca}`);
      }
      marcaId = brand[0].marca_id;

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
      modeloId = model[0].modelo_id;

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
      canonicalVersion = versionRows[0].nombre_canonico;
      versionId = versionRows[0].version_id;
    }
    if (canonicalVersion !== item.version) {
      canonicalVersionReuses.push({
        marca:item.marca,modelo:item.modelo,received:item.version,
        canonical:canonicalVersion,version_id:versionId,
      });
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
    } else {
      for (const alias of aliases.filter((row) =>
        String(row.estado).toUpperCase() !== 'RESUELTO' || String(row.version_id ?? '') !== String(versionId))) {
        if (String(alias.estado).toUpperCase() === 'RESUELTO' && alias.version_id != null) {
          throw new Error(`Resolved price alias target changed during resolution: alias_id=${alias.alias_id}`);
        }
        await client.query(
          `UPDATE producto_aliases_v01 SET valor_normalizado=$1,marca_id=$2,modelo_id=$3,version_id=$4,
            evidencia_tipo='PRICE_VERSION_EXACT',evidencia_count=1,primera_observacion=COALESCE(primera_observacion,$5),
            ultima_observacion=$5,estado='RESUELTO',updated_at=now() WHERE alias_id=$6`,
          [masterText(item.version_raw ?? item.version),marcaId,modeloId,versionId,item.vigencia_desde,alias.alias_id]);
        aliasCorrections.push({
          alias_id:alias.alias_id,previous_version_id:alias.version_id,
          canonical_version_id:versionId,canonical_version:canonicalVersion,
        });
      }
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
  alias_corrections:aliasCorrections,
  dongfeng_products:productIds,
  audit:{blockingRejectedRows:audit.blockingRejectedRows,rowsWithoutDeclaredVigencia:audit.rowsWithoutDeclaredVigencia}
},null,2));

let canonicalizer;
try {
  const targetTables = (await pool.query(
    `SELECT to_regclass('public.price_episode_vin_v01') AS vin_table,
            to_regclass('public.price_episode_canonico_v01') AS episode_table`,
  )).rows[0];
  const missingTables = [
    !targetTables.vin_table && 'public.price_episode_vin_v01',
    !targetTables.episode_table && 'public.price_episode_canonico_v01',
  ].filter(Boolean);
  canonicalizer = await priceEpisodeCanonicalizerV01({ dry_run: missingTables.length > 0 });
  if (canonicalizer.price_versions?.unresolved > 0) {
    throw new Error(`Azure pricing canonicalization unresolved price_versions=${canonicalizer.unresolved_price_version_ids?.join(',')}`);
  }
  canonicalizer = {
    ...canonicalizer,
    materialization: missingTables.length
      ? { status:'blocked_missing_tables', missing:missingTables }
      : { status:'completed' },
  };
} finally {
  await closeAzurePool();
}
console.log(JSON.stringify({ engine:'Neon-compatible price episode canonicalizer', ...canonicalizer },null,2));
