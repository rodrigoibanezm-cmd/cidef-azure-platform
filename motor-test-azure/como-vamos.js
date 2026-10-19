import { randomUUID } from 'node:crypto';
import { observeDataSource } from '../lib/data-floor/registry.js';
import { executeP2 } from '../lib/p2/execute.js';
import { journalP3Tool, resolveP1EvidenceRefs } from '../lib/p3/executionJournal.js';

const BRANDS = Object.freeze({ foton: ['FOTON'], dongfeng: ['DONGFENG', 'DFM'] });
const RVM_DONGFENG = 'DFM';

function monthParts(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? ''));
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw new Error('INVALID_PERIOD');
  return { year: Number(match[1]), month: Number(match[2]) };
}
function shiftMonth(period, offset) {
  const { year, month } = monthParts(period);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}
function cutoffDay(cutoff) {
  const match = /-(\d{2})$/.exec(String(cutoff ?? ''));
  return match ? Number(match[1]) : null;
}
function dateForPeriodDay(period, day) {
  const { year, month } = monthParts(period);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, last))).toISOString().slice(0, 10);
}
function businessPeriodDay(period, sourceCutoff) {
  const { year, month } = monthParts(period);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }).slice(0, 10);
  const current = today.slice(0, 7);
  return period === current && sourceCutoff?.startsWith(period) ? sourceCutoff : dateForPeriodDay(period, Math.min(cutoffDay(sourceCutoff) || 31, new Date(Date.UTC(year, month, 0)).getUTCDate()));
}
function valueOf(evidence) {
  const value = evidence?.payload?.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('CERTIFIED_VALUE_MISSING');
  return value;
}
function brandValues(evidence, source) {
  const members = evidence?.payload?.members;
  if (!Array.isArray(members)) throw new Error('CERTIFIED_BRAND_BREAKDOWN_MISSING');
  const out = { foton: 0, dongfeng: 0 };
  for (const member of members) {
    const label = String(member.member_label ?? '').trim().toUpperCase();
    const amount = Number(member.value);
    if (!Number.isFinite(amount)) continue;
    if (BRANDS.foton.includes(label)) out.foton += amount;
    if ((source === 'RVM' ? [RVM_DONGFENG] : BRANDS.dongfeng).includes(label)) out.dongfeng += amount;
  }
  return out;
}
function assertP1(evidence) {
  if (evidence?.authority !== 'P1_CERTIFIED' || !evidence.evidence_id) throw new Error('P1_EVIDENCE_NOT_CERTIFIED');
  return evidence;
}
async function observe(runId, source, input) {
  const started = Date.now();
  try {
    const evidence = assertP1(await observeDataSource(source, input));
    await journalP3Tool({ run_id: runId, floor: 'P1', tool_name: 'data_observe', input: { run_id: runId, source, ...input }, output: evidence, duration_ms: Date.now() - started });
    return evidence;
  } catch (error) {
    await journalP3Tool({ run_id: runId, floor: 'P1', tool_name: 'data_observe', input: { run_id: runId, source, ...input }, status: 'FAILED', error_code: error?.code || error?.name || 'ERROR', output: { error: { code: error?.code || error?.name || 'ERROR', message: error?.message ?? String(error) } }, duration_ms: Date.now() - started }).catch(() => {});
    throw error;
  }
}
function contractRef(evidence) {
  return { source: evidence.source ?? null, contract: evidence.evidence_contract ?? null, version: evidence.evidence_version ?? null, evidence_id: evidence.evidence_id };
}
function cutoffOf(evidence) {
  return evidence?.temporal?.cutoff ?? evidence?.temporal?.to ?? evidence?.temporal?.snapshot_date ?? evidence?.universe?.snapshot_date ?? null;
}
function periodRow(period, cutoff, values, evidence) {
  return { period, cutoff, ...values, evidence_ids: evidence.map(item => item.evidence_id) };
}
function unavailable(id, period, error) {
  return { id, status: error?.message || 'NOT_CERTIFIED', certified: false, period, unit: id === 'rvm_share' ? 'percent' : 'unit', values: null, series: [], cutoff: null, source: null, evidence_id: null, evidence: [], limitations: [error?.message || 'NO_CERTIFIED_EVIDENCE'] };
}
function ready(id, unit, period, values, series, evidence, cutoff, source, limitations = [], certification = {}) {
  const all = [...new Map(evidence.filter(item => item?.evidence_id).map(item => [item.evidence_id, item])).values()];
  return { id, status: 'CERTIFIED', certified: true, unit, period, values, series, cutoff, source, evidence_id: all[0]?.evidence_id ?? null, evidence_ids: all.map(item => item.evidence_id), evidence: all.map(contractRef), certification, limitations };
}
async function salesIndicator(runId, period, periods) {
  const current = await observe(runId, 'SALES', { measure: 'VIN_SALES', evidence_shape: 'CUMULATIVE_PERIOD_OBSERVATION', period, filters: { commercial_universe: 'COMPANY' } });
  const currentBrands = await observe(runId, 'SALES', { measure: 'VIN_SALES', evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', period, dimension: 'BRAND', filters: { commercial_universe: 'COMPANY' } });
  const currentCutoff = cutoffOf(current);
  const day = cutoffDay(currentCutoff) || 31;
  const currentBrandValues = brandValues(currentBrands, 'SALES');
  const byPeriod = new Map([[period, periodRow(period, currentCutoff, { company: valueOf(current), ...currentBrandValues }, [current, currentBrands])]]);
  for (const itemPeriod of periods) {
    if (byPeriod.has(itemPeriod)) continue;
    const cutoff = dateForPeriodDay(itemPeriod, day);
    const total = await observe(runId, 'SALES', { measure: 'VIN_SALES', evidence_shape: 'CUMULATIVE_PERIOD_OBSERVATION', period: itemPeriod, cutoff, filters: { commercial_universe: 'COMPANY' } });
    const brands = await observe(runId, 'SALES', { measure: 'VIN_SALES', evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', period: itemPeriod, cutoff, dimension: 'BRAND', filters: { commercial_universe: 'COMPANY' } });
    byPeriod.set(itemPeriod, periodRow(itemPeriod, cutoffOf(total), { company: valueOf(total), ...brandValues(brands, 'SALES') }, [total, brands]));
  }
  return ready('sales', current.measure.unit, period, { company: valueOf(current), ...currentBrandValues }, periods.map(p => byPeriod.get(p)), [current, currentBrands, ...[...byPeriod.values()].flatMap(row => row.evidence_ids.map(id => ({ evidence_id: id })))], currentCutoff, 'SALES P1 · ventas VIN reconocidas');
}
async function forumIndicator(runId, id, period, periods, measure, latestSnapshot) {
  const localPeriod = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }).slice(0, 7);
  const latest = period === localPeriod;
  if (latest && (!latestSnapshot || !String(latestSnapshot).startsWith(period))) throw new Error('FORUM_CURRENT_CUTOFF_UNAVAILABLE');
  const day = latest ? cutoffDay(latestSnapshot) : 31;
  const byPeriod = new Map();
  for (const itemPeriod of periods) {
    const cutoff = dateForPeriodDay(itemPeriod, day);
    const total = await observe(runId, 'FORUM', { measure, evidence_shape: 'QUANTITATIVE_OBSERVATION', period: itemPeriod, cutoff });
    const brands = await observe(runId, 'FORUM', { measure, evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', period_from: itemPeriod, period_to: itemPeriod, cutoff, dimension: 'BRAND' });
    byPeriod.set(itemPeriod, periodRow(itemPeriod, cutoffOf(total), { company: valueOf(total), ...brandValues(brands, 'FORUM') }, [total, brands]));
  }
  const current = byPeriod.get(period);
  return ready(id, current?.evidence_ids ? (measure === 'UFIS' ? 'vehicle_unit' : 'operation') : 'unit', period, { company: current.company, foton: current.foton, dongfeng: current.dongfeng }, periods.map(p => byPeriod.get(p)), [...byPeriod.values()].flatMap(row => row.evidence_ids.map(id => ({ evidence_id: id }))), current.cutoff, 'FORUM P1 · ' + measure, latest ? ['CUT_OFF_IS_LATEST_FORUM_SNAPSHOT'] : []);
}
async function rvmEvidence(runId, period, filters = {}) {
  const [total, brands] = await Promise.all([
    observe(runId, 'RVM', { measure: 'RVM_UNITS', evidence_shape: 'QUANTITATIVE_OBSERVATION', period, filters }),
    observe(runId, 'RVM', { measure: 'RVM_UNITS', evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', period, dimension: 'BRAND', filters }),
  ]);
  return { total, brands, values: { company: valueOf(total), ...brandValues(brands, 'RVM') }, cutoff: cutoffOf(total) };
}
async function p2Share(runId, period, companyBrands, label) {
  const filters = {};
  const universe = await observe(runId, 'RVM', { measure: 'RVM_UNITS', evidence_shape: 'QUANTITATIVE_OBSERVATION', period, filters });
  const part = await observe(runId, 'RVM', { measure: 'RVM_UNITS', evidence_shape: 'QUANTITATIVE_OBSERVATION', period, filters: { ...filters, brand: companyBrands } });
  const refs = { part: part.evidence_id, universe: universe.evidence_id };
  const evidence = await resolveP1EvidenceRefs(runId, refs);
  const result = await executeP2({ run_id: runId, unit_id: 'p2.part_to_universe_ratio', contract_version: '0.1.0', evidence, parameters: {} });
  const started = Date.now();
  await journalP3Tool({ run_id: runId, floor: 'P2', tool_name: 'p2_execute', input: { run_id: runId, unit_id: 'p2.part_to_universe_ratio', contract_version: '0.1.0', evidence: refs, parameters: {} }, output: result, duration_ms: Date.now() - started });
  if (result.status !== 'EXECUTED' || result.result?.percentage == null) throw new Error('RVM_SHARE_P2_NOT_EXECUTED');
  return { percentage: result.result.percentage, evidence: [universe, part], p2: result, cutoff: cutoffOf(universe) };
}
async function rvmShareIndicator(runId, period, periods) {
  const series = [];
  let current = null;
  for (const itemPeriod of periods) {
    const [company, foton, dongfeng] = await Promise.all([
      p2Share(runId, itemPeriod, ['FOTON', RVM_DONGFENG], 'company'),
      p2Share(runId, itemPeriod, ['FOTON'], 'foton'),
      p2Share(runId, itemPeriod, [RVM_DONGFENG], 'dongfeng'),
    ]);
    const row = { period: itemPeriod, cutoff: company.cutoff, company: company.percentage, foton: foton.percentage, dongfeng: dongfeng.percentage, evidence_ids: [...company.evidence, ...foton.evidence, ...dongfeng.evidence].map(item => item.evidence_id), p2_evidence: [company.p2, foton.p2, dongfeng.p2] };
    series.push(row);
    if (itemPeriod === period) current = { company, foton, dongfeng, row };
  }
  return ready('rvm_share', 'percent', period, { company: current.company.percentage, foton: current.foton.percentage, dongfeng: current.dongfeng.percentage }, series.map(({ p2_evidence, ...row }) => row), [...current.company.evidence, ...current.foton.evidence, ...current.dongfeng.evidence], current.row.cutoff, 'RVM P1 + p2.part_to_universe_ratio v0.1.0', ['DONGFENG_RVM_SOURCE_LABEL_DFM'], { authority: 'P2_EXECUTED', unit_id: 'p2.part_to_universe_ratio', contract_version: '0.1.0', output: current.company.p2.result });
}

export async function buildComoVamos(period) {
  monthParts(period);
  const run_id = 'como-vamos-' + randomUUID();
  const periods = [shiftMonth(period, -3), shiftMonth(period, -2), shiftMonth(period, -1), period];
  const indicators = [];
  let latestSnapshot = null;
  try {
    const snapshot = await observe(run_id, 'FORUM', { measure: 'PRECURSE' });
    const brands = await observe(run_id, 'FORUM', { measure: 'PRECURSE', evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', dimension: 'BRAND' });
    latestSnapshot = cutoffOf(snapshot);
    indicators.push(ready('precurse', 'operation', period, { company: valueOf(snapshot), ...brandValues(brands, 'FORUM') }, [], [snapshot, brands], latestSnapshot, 'FORUM P1 · PRECURSE snapshot stock', ['STOCK_OF_LATEST_SNAPSHOT', 'NO_PERIOD_SERIES']));
  } catch (error) { indicators.push(unavailable('precurse', period, error)); }
  for (const task of [
    async () => {
      try { indicators.push(await salesIndicator(run_id, period, periods)); }
      catch (error) { indicators.push(unavailable('sales', period, error)); }
    },
    async () => {
      try { indicators.push(await forumIndicator(run_id, 'quotations', period, periods, 'QUOTATIONS', latestSnapshot)); }
      catch (error) { indicators.push(unavailable('quotations', period, error)); }
    },
    async () => {
      try { indicators.push(await forumIndicator(run_id, 'ufis', period, periods, 'UFIS', latestSnapshot)); }
      catch (error) { indicators.push(unavailable('ufis', period, error)); }
    },
    async () => {
      try {
        const rows = [];
        for (const itemPeriod of periods) {
          const observed = await rvmEvidence(run_id, itemPeriod);
          rows.push(periodRow(itemPeriod, observed.cutoff, observed.values, [observed.total, observed.brands]));
        }
        const current = rows.at(-1);
        indicators.push(ready('rvm_units', 'vehicle', period, { company: current.company, foton: current.foton, dongfeng: current.dongfeng }, rows, rows.flatMap(row => row.evidence_ids.map(id => ({ evidence_id: id }))), current.cutoff, 'RVM P1 · RVM_UNITS', ['DONGFENG_CIDEF_MAPS_TO_RVM_DFM']));
      } catch (error) { indicators.push(unavailable('rvm_units', period, error)); }
    },
    async () => {
      try { indicators.push(await rvmShareIndicator(run_id, period, periods)); }
      catch (error) { indicators.push(unavailable('rvm_share', period, error)); }
    },
  ]) await task();
  return { period, run_id, generated_at: new Date().toISOString(), indicators };
}
