import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { run as preliminary } from '../lib/motors/import-rvm-preliminary.js';
import { run as consolidated } from '../lib/motors/import-rvm.js';

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    kind: { type: 'string' }, year: { type: 'string' },
    month: { type: 'string' }, file: { type: 'string' },
  }, strict: true });
  if (!['preliminary', 'consolidated'].includes(values.kind)) throw new Error('RVM kind must be preliminary or consolidated');
  const year = Number(values.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Invalid RVM year');
  if (values.kind === 'preliminary') {
    if (values.month || values.file) throw new Error('Preliminary RVM only accepts year');
    return preliminary({ year });
  }
  const month = Number(values.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('Invalid RVM month');
  return consolidated({ year, month, ...(values.file ? { fileName: values.file } : {}) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify({ event: 'RVM_LOADED', ...result })))
    .catch(error => { console.error(JSON.stringify({ event: 'RVM_FAILED', code: error.code || error.name })); process.exitCode = 1; });
}
