const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const CANONICAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export function parseFechaFactura(value) {
  if (value == null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const canonical = CANONICAL_DATE_RE.exec(raw);
  const match = canonical ?? DATE_RE.exec(raw);
  if (!match) return { error: 'unsupported_format', raw };

  const month = Number(match[canonical ? 2 : 1]);
  const day = Number(match[canonical ? 3 : 2]);
  const yearRaw = Number(match[canonical ? 1 : 3]);
  const year = !canonical && match[3].length === 2 ? 2000 + yearRaw : yearRaw;
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return { error: 'invalid_date', raw };
  }

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) return { error: 'invalid_date', raw };

  return { date, month: `${year}-${String(month).padStart(2, '0')}`, raw };
}
