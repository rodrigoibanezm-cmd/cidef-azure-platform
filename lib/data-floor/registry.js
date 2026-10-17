import { describeSales, inspectSales, fetchSales, observeSalesEvidence, buildSalesTemporalFingerprint } from './salesCertifier.js';
import { describeInventory, inspectInventory, fetchInventory } from './inventoryCertifier.js';
import { describeRvm, inspectRvm, fetchRvm, observeRvmEvidence } from './rvmCertifier.js';
import { describeForum, inspectForum, fetchForum, observeForumEvidence } from './forumCertifier.js';
import { describeTargets, inspectTargets, fetchTargets, observeTargetsEvidence } from './targetsCertifier.js';

import { describeCrm, inspectCrm, observeCrmEvidence } from './crmCertifier.js';
import { describePricing, inspectPricing, observePricingEvidence } from './pricingCertifier.js';

const SOURCES = Object.freeze({
  SALES: Object.freeze({ describe: describeSales, inspect: inspectSales, fetch: fetchSales, observe: observeSalesEvidence, temporalFingerprint: buildSalesTemporalFingerprint }),
  INVENTORY: Object.freeze({ describe: describeInventory, inspect: inspectInventory, fetch: fetchInventory }),
  RVM: Object.freeze({ describe: describeRvm, inspect: inspectRvm, fetch: fetchRvm, observe: observeRvmEvidence }),
  FORUM: Object.freeze({ describe: describeForum, inspect: inspectForum, fetch: fetchForum, observe: observeForumEvidence }),
  CRM: Object.freeze({ describe: describeCrm, inspect: inspectCrm, observe: observeCrmEvidence }),
  TARGETS: Object.freeze({ describe: describeTargets, inspect: inspectTargets, fetch: fetchTargets, observe: observeTargetsEvidence }),
  PRICING: Object.freeze({ describe: describePricing, inspect: inspectPricing, observe: observePricingEvidence }),
});

function source(id){
  const key=String(id||'').trim().toUpperCase();
  const item=SOURCES[key];
  if(!item) throw new Error('UNKNOWN_DATA_SOURCE: '+key);
  return {key,item};
}

export function describeDataSource(id){
  const {item}=source(id);
  return item.describe();
}
export async function inspectDataSource(id,input={}){
  const {item}=source(id);
  return item.inspect(input);
}
export async function fetchDataSource(id,input={}){
  const {item}=source(id);
  if(!item.fetch) throw new Error('FETCH_NOT_SUPPORTED: '+String(id||'').trim().toUpperCase());
  return item.fetch(input);
}
export async function observeDataSource(id,input={}){
  const {item}=source(id);
  if(!item.observe) throw new Error('OBSERVE_NOT_SUPPORTED: '+String(id||'').trim().toUpperCase());
  return item.observe(input);
}
export async function temporalFingerprintDataSource(id,input={},focusEvidence=null){
  const {item}=source(id);
  if(!item.temporalFingerprint)return null;
  return item.temporalFingerprint(input,focusEvidence);
}
export function listDataSources(){ return Object.keys(SOURCES); }
