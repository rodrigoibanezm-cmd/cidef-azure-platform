import { invalid } from '../validation.js';

const DIMENSIONS = Object.freeze({
  SELLER: Object.freeze({ universe: 'OWN_STORES', identity: 'personas_master', version: '0.1' }),
  MODEL: Object.freeze({ universe: 'COMPANY', identity: 'modelos_master_v01', version: '0.1' }),
});

export function salesPerformanceDimension(id) {
  if (typeof id !== 'string' || !Object.hasOwn(DIMENSIONS, id)) {
    throw invalid('UNSUPPORTED_GRAIN', 'Only SELLER and MODEL have supported P1 identity contracts; DEALER_GROUP is blocked');
  }
  return DIMENSIONS[id];
}
