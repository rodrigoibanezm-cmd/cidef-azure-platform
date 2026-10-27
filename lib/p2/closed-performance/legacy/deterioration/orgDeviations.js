function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mad(values) {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function percentileRank(values, value) {
  if (!values.length) return null;
  const below = values.filter((item) => item < value).length;
  const equal = values.filter((item) => item === value).length;
  return (below + 0.5 * equal) / values.length;
}

export function calculateDeviations(actual, baseline, priorErrors) {
  const error = actual - baseline;
  const relative = baseline > 0 ? error / baseline : null;
  const scale = priorErrors.length >= 3 ? mad(priorErrors) : null;
  const scaledMad = scale != null && scale > 0 ? error / scale : null;
  const historicalPercentile = priorErrors.length >= 3
    ? percentileRank(priorErrors, error)
    : null;
  return {
    error,
    relative,
    scaled_mad: scaledMad,
    historical_percentile: historicalPercentile,
    error_history_available: priorErrors.length,
  };
}

export function selectDeviationFields(all, requested) {
  const output = { error: all.error, error_history_available: all.error_history_available };
  for (const name of requested) output[name] = all[name];
  return output;
}
