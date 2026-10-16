const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function assertMonth(month) {
  const value = String(month || '');
  if (!MONTH_RE.test(value)) throw new Error('commercial month must use YYYY-MM');
  return value;
}

function asUtcDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('date must be valid');
    return value;
  }
  const raw = String(value || '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new Error('date must use YYYY-MM-DD');
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y)
    || date.getUTCMonth() !== Number(m) - 1
    || date.getUTCDate() !== Number(d)
  ) throw new Error('date must use valid YYYY-MM-DD');
  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function commercialMonthDays(month) {
  const value = assertMonth(month);
  const [year, monthNumber] = value.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

export function commercialMonthRange(month) {
  const value = assertMonth(month);
  const days = commercialMonthDays(value);
  const start = new Date(`${value}-01T00:00:00.000Z`);
  const end = new Date(`${value}-${String(days).padStart(2, '0')}T23:59:59.999Z`);
  return {
    month: value,
    start,
    end,
    start_date: formatDate(start),
    end_date: formatDate(end),
    days,
  };
}

export function commercialMonthForDate(value) {
  const date = asUtcDate(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function commercialDayForDate(value) {
  const date = asUtcDate(value);
  return date.getUTCDate();
}

export function commercialDateForDay(month, day) {
  const range = commercialMonthRange(month);
  const value = Number(day);
  if (!Number.isInteger(value) || value < 1 || value > range.days) {
    throw new Error(`commercial day must be between 1 and ${range.days}`);
  }
  return formatDate(new Date(range.start.getTime() + (value - 1) * DAY_MS));
}
