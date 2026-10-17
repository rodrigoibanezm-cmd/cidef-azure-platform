import { workbookToSheetJson } from './workbookToSheetJson.js';

const clean = (v, i) => {
  const s = String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || `col_${i + 1}`;
};

function unique(row) {
  const seen = new Map();
  return row.map((v, i) => {
    const base = clean(v, i);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}_${n + 1}` : base;
  });
}

const DATE_RE = /\b(\d{2}-\d{2}-\d{4})\b/;

function vigenciaInRow(row) {
  const text = row.filter((v) => v !== null && v !== undefined && v !== '').join(' ');
  const match = text.match(DATE_RE);
  return match ? match[1] : null;
}

function headerRow(row) {
  const text = row.filter(Boolean).join(' ').toLowerCase();
  return row.filter(Boolean).length >= 4 && text.includes('precio') &&
    (text.includes('linea') || text.includes('modelo') || text.includes('transm'));
}

export function parsePriceSheetJson(sheets) {
  const records = [];

  for (const sheet of sheets) {
    const sheetName = sheet.source_sheet;
    const rows = sheet.rows ?? [];
    const matrix = rows.map((item) => ({
      sourceRow: item.row,
      cells: (item.formatted_cells?.length ? item.formatted_cells : item.cells ?? [])
        .map((value) => value === null || value === undefined ? null : String(value)),
    }));

    const firstDeclaredVigencia = matrix.map(({ cells }) => vigenciaInRow(cells)).find(Boolean) || null;
    let currentVigencia = firstDeclaredVigencia;
    let headers = null;
    let group = null;

    matrix.forEach(({ sourceRow, cells: row }) => {
      const declaredVigencia = vigenciaInRow(row);
      if (declaredVigencia && !headerRow(row)) currentVigencia = declaredVigencia;

      if (headerRow(row)) {
        headers = unique(row);
        const structuralIndex = row.findIndex((value) =>
          /^(c[oó]digo|transm(?:isi[oó]n)?\.?|c\.?c\.?|h\.?p\.?|origen|combustible|modelo|marca)$/i
            .test(String(value ?? '').trim())
        );
        if (row[0]) {
          group = String(row[0]).trim();
        } else if (structuralIndex >= 2 && row[1]) {
          // Legacy blocks may leave column A empty and put the model family in B.
          // In that shape B is the row-level version column for following records.
          group = String(row[1]).trim();
          headers[1] = 'version';
        }
        return;
      }
      if (!headers || row.filter(Boolean).length < 2) return;

      const rec = {
        source_file: sheet.source_file,
        source_sheet: sheetName,
        vigencia: currentVigencia,
        source_row: String(sourceRow),
        product_group: group,
      };
      headers.forEach((key, i) => {
        const value = row[i];
        rec[key] = value === null || value === undefined || value === '' ? null : String(value);
      });
      records.push(rec);
    });
  }

  const columns = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const rows = records.map((r) => columns.map((c) => r[c] ?? null));
  return { columns, rows, records };
}

export function parsePriceWorkbook(buffer, sourceFile) {
  return parsePriceSheetJson(workbookToSheetJson(buffer, sourceFile));
}
