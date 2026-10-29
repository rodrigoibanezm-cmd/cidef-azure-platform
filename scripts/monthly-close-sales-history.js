// Cache original certified P1 envelopes; never assemble dealer series from fragments.
const TABLE = 'public.monthly_close_sales_history';
export function historyKey(input) {
  const filters = input.filters ?? {};
  const dimension = input.evidence_shape === 'PERIOD_OBSERVATION_SERIES'
    ? 'DEALER_GROUP' : input.dimension;
  const period = dimension === 'DEALER_GROUP' ? input.period_to : input.period;
  return [period, filters.commercial_universe, String(filters.brand_id ?? ''),
    dimension, dimension === 'DEALER_GROUP' ? String(filters.dealer_group_id) : ''];
}
export function validateHistoryEvidence(input, evidence) {
  const [period, universe, brand, dimension, member] = historyKey(input);
  if (evidence?.authority !== 'P1_CERTIFIED' || evidence?.status !== 'CERTIFIED'
    || evidence.source !== 'SALES' || !evidence.evidence_id
    || evidence.evidence_version !== '0.1.0'
    || evidence.measure?.id !== 'VIN_SALES'
    || evidence.universe?.commercial_universe !== universe
    || String(evidence.dimensions?.brand_id ?? '') !== brand)
    throw new Error('CACHED_P1_EVIDENCE_INCOMPATIBLE');
  if (dimension === 'DEALER_GROUP') {
    if (evidence.evidence_contract !== 'p1.period_observation_series'
      || evidence.temporal?.period_from !== input.period_from
      || evidence.temporal?.period_to !== period
      || String(evidence.dimensions?.dealer_group_id) !== member
      || Object.keys(evidence.dimensions ?? {}).length !== (brand ? 2 : 1))
      throw new Error('CACHED_P1_DEALER_SERIES_INCOMPATIBLE');
  } else if (evidence.evidence_contract !== 'p1.dimensional_quantitative_dataset'
    || evidence.temporal?.period_identity !== period
    || evidence.temporal?.cutoff !== input.cutoff
    || evidence.payload?.dimension?.id !== dimension
    || Object.keys(evidence.dimensions ?? {}).length !== (brand ? 1 : 0)) {
    throw new Error('CACHED_P1_MONTH_INCOMPATIBLE');
  }
}
export async function cachedP1(input, { pool, observe }) {
  const key = historyKey(input);
  const select = `SELECT evidence_id, evidence FROM ${TABLE}
    WHERE period=$1 AND commercial_universe=$2 AND brand_id=$3
      AND dimension=$4 AND member_id=$5`;
  const old = await pool.query(select, key);
  if (old.rows.length) {
    const row = old.rows[0];
    if (row.evidence_id !== row.evidence?.evidence_id) throw new Error('CACHED_P1_ID_MISMATCH');
    validateHistoryEvidence(input, row.evidence);
    return row.evidence;
  }
  const generated = await observe(input);
  validateHistoryEvidence(input, generated);
  const inserted = await pool.query(
    `INSERT INTO ${TABLE}
      (period,commercial_universe,brand_id,dimension,member_id,evidence_id,evidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT (period,commercial_universe,brand_id,dimension,member_id)
      DO NOTHING RETURNING evidence_id,evidence`,
    [...key, generated.evidence_id, JSON.stringify(generated)]);
  const winner = inserted.rows[0] ?? (await pool.query(select, key)).rows[0];
  if (!winner || winner.evidence_id !== winner.evidence?.evidence_id)
    throw new Error('CACHED_P1_CONCURRENT_WRITE_INVALID');
  validateHistoryEvidence(input, winner.evidence);
  return winner.evidence;
}
