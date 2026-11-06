import { refreshDealerSellout } from '../lib/data-floor/refreshDealerSellout.js';
import { closeAzurePool } from '../lib/azure-postgres.js';

try {
  const result = await refreshDealerSellout();
  console.log(JSON.stringify({event:'DEALER_SELLOUT_PUBLISHED',...result}));
} catch (error) {
  console.error(JSON.stringify({event:'DEALER_SELLOUT_FAILED',error:error.message}));
  process.exitCode = 1;
} finally {
  await closeAzurePool();
}
