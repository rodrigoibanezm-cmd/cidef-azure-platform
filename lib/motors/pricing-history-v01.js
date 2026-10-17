import { azureQuery as queryDb } from '../azure-postgres.js';
import { buildPricingHistory, parsePricingHistoryInput } from '../pricing-history/buildPricingHistory.js';

export const ENGINE_NAME = 'pricing_history_v01';
export const ENGINE_VERSION = '0.1';

async function resolveIdentity(parsed, query) {
  const clauses = [];
  const params = [];
  function add(sql, value) { params.push(value); clauses.push(sql.replace('?', `$${params.length}`)); }
  if (parsed.versionId != null) add('v.version_id = ?', parsed.versionId);
  if (parsed.brand) add('upper(ma.nombre_canonico) = upper(?)', parsed.brand);
  if (parsed.model) add('upper(mo.nombre_canonico) = upper(?)', parsed.model);
  if (parsed.version) add('upper(v.nombre_canonico) = upper(?)', parsed.version);
  const rows = await query(`SELECT v.version_id, ma.nombre_canonico AS brand, mo.nombre_canonico AS model, v.nombre_canonico AS version
    FROM versiones_master_v01 v
    JOIN modelos_master_v01 mo ON mo.modelo_id = v.modelo_id
    JOIN marcas_master_v01 ma ON ma.marca_id = mo.marca_id
    WHERE ${clauses.join(' AND ')}`, params);
  if (rows.length === 0) throw new Error('PRICING_VERSION_NOT_FOUND');
  if (rows.length > 1) throw new Error('AMBIGUOUS_PRICING_VERSION');
  return rows[0];
}

export async function pricingHistoryV01(input = {}, dependencies = {}) {
  const parsed = parsePricingHistoryInput(input);
  const query = dependencies.queryDb ?? queryDb;
  const identity = await resolveIdentity(parsed, query);
  const [episodeRows, vinRows] = await Promise.all([
    query(`SELECT * FROM price_episode_canonico_v01 WHERE version_id = $1 ORDER BY vigencia_desde ASC, price_episode_id ASC`, [identity.version_id]),
    query(`SELECT price_episode_id, version_id, fecha_factura
      FROM price_episode_vin_v01
      WHERE version_id = $1
      ORDER BY price_episode_id ASC, fecha_factura ASC, vehiculo_id ASC`, [identity.version_id]),
  ]);
  return {
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    status: 'OK',
    ...buildPricingHistory({ identity, episodeRows, vinRows }, parsed),
  };
}

export const run = pricingHistoryV01;
