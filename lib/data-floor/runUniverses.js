const RUN_IDLE_MS = 5 * 60_000;
const inFlight = new Map();

function sortJsonKeys(_key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}

export function shareRunExecution(runId, source, operation, parameters, execute) {
  const key = JSON.stringify([runId, source, operation, parameters], sortJsonKeys);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = Promise.resolve().then(execute).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

// Each domain owns its preparation, universe builder, and compatibility key.
export function createRunUniverses(prepare, buildUniverse) {
  const runs = new Map();

  return async function getRunUniverse(runId, key, options) {
    if (!runId) {
      const prepared = await prepare();
      return {universe: buildUniverse(prepared, options), preparations: 1, builds: 1};
    }

    let run = runs.get(runId);
    const preparations = run ? 0 : 1;
    if (!run) {
      run = {preparation: prepare(), universes: new Map(), idleTimer: null};
      runs.set(runId, run);
    }
    clearTimeout(run.idleTimer);

    let prepared;
    try {
      prepared = await run.preparation;
    } catch (error) {
      if (runs.get(runId) === run) runs.delete(runId);
      throw error;
    }

    try {
      // Construction and registration are synchronous after the shared load.
      const existing = run.universes.get(key);
      if (existing) return {universe: existing, preparations, builds: 0};

      const universe = buildUniverse(prepared, options);
      run.universes.set(key, universe);
      return {universe, preparations, builds: 1};
    } finally {
      clearTimeout(run.idleTimer);
      run.idleTimer = setTimeout(() => runs.delete(runId), RUN_IDLE_MS).unref();
    }
  };
}
