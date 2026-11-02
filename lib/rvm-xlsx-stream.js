import unzipper from 'unzipper';
import sax from 'sax';

function localName(name = '') {
  return String(name).split(':').pop();
}

function colIndex(ref = '') {
  const letters = String(ref).match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return letters ? Math.max(0, n - 1) : null;
}

async function parseXmlEntry(entry, handlers) {
  if (!entry) return;
  const parser = sax.createStream(true, { trim: false });
  for (const [event, handler] of Object.entries(handlers)) parser.on(event, handler);
  await new Promise((resolve, reject) => {
    parser.on('error', reject);
    parser.on('end', resolve);
    entry.stream().on('error', reject).pipe(parser);
  });
}

async function parseSharedStrings(entry) {
  if (!entry) return [];
  const strings = [];
  let inSi = false;
  let inT = false;
  let text = '';
  await parseXmlEntry(entry, {
    opentag(node) {
      const name = localName(node.name);
      if (name === 'si') { inSi = true; text = ''; }
      else if (inSi && name === 't') inT = true;
    },
    text(value) { if (inSi && inT) text += value; },
    cdata(value) { if (inSi && inT) text += value; },
    closetag(rawName) {
      const name = localName(rawName);
      if (name === 't') inT = false;
      if (name === 'si') { strings.push(text); inSi = false; text = ''; }
    },
  });
  return strings;
}

async function sheetPathByName(zip, requestedName) {
  if (!requestedName) return null;
  const workbookEntry = zip.files.find((f) => f.path === 'xl/workbook.xml');
  const relsEntry = zip.files.find((f) => f.path === 'xl/_rels/workbook.xml.rels');
  if (!workbookEntry || !relsEntry) throw new Error('RVM workbook metadata is incomplete');

  const sheets = [];
  await parseXmlEntry(workbookEntry, {
    opentag(node) {
      if (localName(node.name) === 'sheet') {
        sheets.push({ name: node.attributes.name, relId: node.attributes['r:id'] ?? node.attributes.id });
      }
    },
  });
  const target = sheets.find((sheet) => sheet.name === requestedName);
  if (!target) throw new Error(`RVM worksheet not found: ${requestedName}`);

  const rels = new Map();
  await parseXmlEntry(relsEntry, {
    opentag(node) {
      if (localName(node.name) === 'Relationship') rels.set(node.attributes.Id ?? node.attributes.id, node.attributes.Target ?? node.attributes.target);
    },
  });
  const targetPath = rels.get(target.relId);
  if (!targetPath) throw new Error(`RVM worksheet relationship not found: ${requestedName}`);
  return targetPath.startsWith('/') ? targetPath.slice(1) : `xl/${targetPath.replace(/^\.\//, '')}`;
}

function cellValue(type, raw, inline, sharedStrings) {
  if (type === 's') return sharedStrings[Number(raw)] ?? raw ?? null;
  if (type === 'inlineStr') return inline || null;
  if (raw === '' || raw == null) return null;
  return String(raw);
}

function attachRowParser(stream, sharedStrings, onRow, onDone, onError) {
  const parser = sax.createStream(true, { trim: false });
  let currentRow = null;
  let currentCell = null;
  let captureV = false;
  let captureT = false;

  parser.on('opentag', (node) => {
    const name = localName(node.name);
    if (name === 'row') currentRow = { number: Number(node.attributes.r || 0), values: [], nextCellIndex: 0 };
    else if (name === 'c' && currentRow) {
      const explicitIndex = colIndex(node.attributes.r || '');
      const index = explicitIndex ?? currentRow.nextCellIndex;
      currentCell = { index, type: node.attributes.t || '', raw: '', inline: '' };
      currentRow.nextCellIndex = index + 1;
    } else if (name === 'v' && currentCell) captureV = true;
    else if (name === 't' && currentCell?.type === 'inlineStr') captureT = true;
  });
  parser.on('text', (value) => {
    if (captureV && currentCell) currentCell.raw += value;
    if (captureT && currentCell) currentCell.inline += value;
  });
  parser.on('cdata', (value) => { if (captureT && currentCell) currentCell.inline += value; });
  parser.on('closetag', (rawName) => {
    const name = localName(rawName);
    if (name === 'v') captureV = false;
    if (name === 't') captureT = false;
    if (name === 'c' && currentCell && currentRow) {
      currentRow.values[currentCell.index] = cellValue(currentCell.type, currentCell.raw, currentCell.inline, sharedStrings);
      currentCell = null;
    }
    if (name === 'row' && currentRow) {
      delete currentRow.nextCellIndex;
      onRow(currentRow);
      currentRow = null;
    }
  });
  parser.on('error', onError);
  parser.on('end', onDone);
  stream.on('error', onError);
  stream.pipe(parser);
  return parser;
}

export async function openRvmWorkbook(buffer, options = {}) {
  const zip = await unzipper.Open.buffer(buffer);
  const sharedEntry = zip.files.find((f) => f.path === 'xl/sharedStrings.xml');
  const requestedPath = await sheetPathByName(zip, options.sheetName);
  const sheetEntry = requestedPath
    ? zip.files.find((f) => f.path === requestedPath)
    : zip.files.filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path))[0];
  if (!sheetEntry) throw new Error(options.sheetName ? `RVM worksheet not found: ${options.sheetName}` : 'RVM workbook has no worksheet XML');

  const sharedStrings = await parseSharedStrings(sharedEntry);

  async function firstRow() {
    return new Promise((resolve, reject) => {
      const stream = sheetEntry.stream();
      let settled = false;
      attachRowParser(
        stream,
        sharedStrings,
        (row) => {
          if (settled) return;
          settled = true;
          stream.destroy();
          resolve(row);
        },
        () => { if (!settled) reject(new Error('RVM workbook has no rows')); },
        (error) => { if (!settled) reject(error); },
      );
    });
  }

  async function *rows() {
    const pending = [];
    let notify;
    let done = false;
    let failed;
    const stream = sheetEntry.stream();
    attachRowParser(
      stream,
      sharedStrings,
      (row) => {
        pending.push(row);
        if (notify) { notify(); notify = null; }
      },
      () => { done = true; if (notify) notify(); },
      (error) => { failed = error; done = true; if (notify) notify(); },
    );

    while (!done || pending.length) {
      if (!pending.length) await new Promise((resolve) => { notify = resolve; });
      if (failed) throw failed;
      while (pending.length) yield pending.shift();
    }
  }

  return { firstRow, rows, sheetName: options.sheetName ?? sheetEntry.path };
}
