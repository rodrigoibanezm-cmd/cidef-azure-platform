export function normalizeProductKey(value) {
  if (value == null) return null;
  const text = String(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
  return text || null;
}
