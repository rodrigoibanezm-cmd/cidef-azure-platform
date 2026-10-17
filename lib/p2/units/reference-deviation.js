import { assertP1, finite, invalid } from '../validation.js';

function observedValue(evidence) {
  const value = evidence?.payload?.observed_value ?? evidence?.payload?.value;
  finite(value, 'observed value');
  return value;
}

function referenceValue(evidence) {
  const value = evidence?.payload?.value;
  finite(value, 'reference value');
  return value;
}

export function executeReferenceDeviation({ evidence = {} } = {}) {
  const observed = evidence.observed;
  const reference = evidence.reference;
  assertP1(observed, 'observed');
  assertP1(reference, 'reference');

  if (observed?.measure?.unit !== reference?.measure?.unit) {
    throw invalid('INCOMPATIBLE_EVIDENCE', 'Observed and reference units differ');
  }
  if (JSON.stringify(observed?.universe ?? {}) !== JSON.stringify(reference?.universe ?? {})) {
    throw invalid('INCOMPATIBLE_EVIDENCE', 'Observed and reference universes differ');
  }
  if (JSON.stringify(observed?.dimensions ?? {}) !== JSON.stringify(reference?.dimensions ?? {})) {
    throw invalid('INCOMPATIBLE_EVIDENCE', 'Observed and reference dimensions differ');
  }

  const observedPeriod = observed?.temporal?.period_identity ?? null;
  const referencePeriod = reference?.temporal?.period_identity ?? null;
  if (observedPeriod !== referencePeriod) {
    throw invalid('INCOMPATIBLE_EVIDENCE', 'Observed and reference periods differ');
  }

  const observed_value = observedValue(observed);
  const reference_value = referenceValue(reference);
  const absolute_deviation = observed_value - reference_value;
  return {
    observed_value,
    reference_value,
    absolute_deviation,
    relative_deviation: reference_value === 0 ? null : absolute_deviation / reference_value,
    relative_deviation_status: reference_value === 0 ? 'ZERO_REFERENCE' : 'CALCULATED',
    direction: absolute_deviation > 0 ? 'ABOVE_REFERENCE' : absolute_deviation < 0 ? 'BELOW_REFERENCE' : 'ON_REFERENCE',
    reference_type: reference?.payload?.reference_type ?? null,
    reference_source: reference?.payload?.source ?? null,
  };
}
