// Disposable catalog fixture. Idempotency is optional so tests can show
// that recovery does not depend on a second PUT.

export function createDestination({ idempotent = true } = {}) {
  const rows = new Map();
  const effects = new Set();
  let writeCount = 0;
  let putCount = 0;
  let loseNextResponse = false;
  let failBeforeCommit = false;

  return {
    armLostResponse() {
      loseNextResponse = true;
    },
    armFailBeforeCommit() {
      failBeforeCommit = true;
    },
    get(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    list() {
      return [...rows.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => a.ghost_id.localeCompare(b.ghost_id));
    },
    stats() {
      return { writeCount, putCount, rows: rows.size };
    },
    put(record, effectId) {
      putCount += 1;
      if (failBeforeCommit) {
        failBeforeCommit = false;
        const error = new Error('transport failed before destination commit');
        error.code = 'NO_COMMIT';
        throw error;
      }
      if (idempotent && effects.has(effectId)) {
        return { duplicate: true, record: { ...rows.get(record.ghost_id) } };
      }
      const stored = { ...record, effect_id: effectId };
      rows.set(record.ghost_id, stored);
      effects.add(effectId);
      writeCount += 1;
      if (loseNextResponse) {
        loseNextResponse = false;
        const error = new Error('lost response after destination commit');
        error.code = 'LOST_RESPONSE';
        throw error;
      }
      return { applied: true, record: { ...stored } };
    },
  };
}
