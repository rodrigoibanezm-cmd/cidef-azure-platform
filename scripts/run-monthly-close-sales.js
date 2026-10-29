import { publishMonthlyCloseSales } from './publish-monthly-close-sales.js';
import { closeAzurePool } from '../lib/azure-postgres.js';

const period = process.argv[2];
if (!period) {
  console.error('Usage: node scripts/run-monthly-close-sales.js YYYY-MM');
  process.exitCode = 2;
} else {
  try {
    const result = await publishMonthlyCloseSales(period);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closeAzurePool();
  }
}
