import { produceMonthlySalesRange } from './produce-monthly-sales.js';
import { closeAzurePool } from '../lib/azure-postgres.js';

const [from,to,...extra] = process.argv.slice(2);
if (extra.length || !from || !to) {
  console.error('Usage: node scripts/run-monthly-sales-range.js 2025-04 2026-08');
  process.exitCode = 2;
} else {
  try {
    const result = await produceMonthlySalesRange(from,to);
    console.log(JSON.stringify({months:result.months,inserted:result.results.reduce((n,r)=>n+r.inserted,0)}));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closeAzurePool();
  }
}
