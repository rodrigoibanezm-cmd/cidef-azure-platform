import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runSalesRefresh } from '../src/loaders/sales/refresh.js';
import { validDate } from '../src/loaders/sales/source-io.js';
import { closeAzurePool } from '../lib/azure-postgres.js';

export function requestedDates(argv) {
  const { values } = parseArgs({ args: argv, options: {
    dates: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  } });
  if (values.dates && !values.from && !values.to) return values.dates.split(',');
  if (!values.dates && validDate(values.from) && validDate(values.to) && values.from <= values.to) {
    const dates = [];
    for (let day = new Date(values.from + 'T00:00:00Z'); day.toISOString().slice(0, 10) <= values.to; day.setUTCDate(day.getUTCDate() + 1)) {
      dates.push(day.toISOString().slice(0, 10));
    }
    return dates;
  }
  throw new Error('Use --dates YYYY-MM-DD[,YYYY-MM-DD] or --from YYYY-MM-DD --to YYYY-MM-DD');
}

export async function main(argv = process.argv.slice(2)) {
  const dates = requestedDates(argv);
  const url = process.env.AZURE_DATABASE_URL;
  if (!url || !new URL(url).hostname.endsWith('.postgres.database.azure.com')) {
    throw new Error('AZURE_DATABASE_URL must point to PostgreSQL Azure; no database fallback');
  }
  try {
    return await runSalesRefresh({ dates, log: entry => console.log(JSON.stringify(entry)) });
  } finally {
    await closeAzurePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ status: 'FAILED', date: error.sourceDate,
      completedDates: error.completedDates || [],
      // Avoid logging provider/driver error messages that can contain credentials or row data.
      code: error.code || error.name,
      message: error.code ? 'Provider/database error; inspect the error code' : error.message,
    }));
    process.exitCode = 1;
  });
}
