import XLSX from 'xlsx';

const nonEmpty = (value) => value !== null && value !== undefined && value !== '';

function jsonValue(value) {
  if (!nonEmpty(value)) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Lossless-ish workbook projection for inspection/adaptation.
 *
 * One JSON document per sheet. Rows preserve their original Excel row number
 * and cell positions; no commercial interpretation happens here.
 */
export function workbookToSheetJson(buffer, sourceFile) {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: false });

  return workbook.SheetNames.map((sheetName) => {
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: null,
      raw: true,
      blankrows: true,
    });
    const formattedMatrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: null,
      raw: false,
      blankrows: true,
    });

    const rows = matrix
      .map((cells, index) => ({
        row: index + 1,
        cells: cells.map(jsonValue),
        formatted_cells: (formattedMatrix[index] ?? []).map(jsonValue),
      }))
      .filter((item) => item.cells.some(nonEmpty) || item.formatted_cells.some(nonEmpty));

    return {
      source_file: sourceFile,
      source_sheet: sheetName,
      row_count: rows.length,
      max_columns: rows.reduce((max, item) => Math.max(max, item.cells.length), 0),
      rows,
    };
  });
}

export function workbookToSheetJsonDocuments(buffer, sourceFile) {
  return workbookToSheetJson(buffer, sourceFile).map((sheet) => ({
    file_name: `${sourceFile}__${sheet.source_sheet}.json`,
    sheet,
  }));
}
