// Same commit behavior as sample/job/src/destination.mjs, plus a snapshot so a
// restarted receiver can reload the catalog. The preserved seven tests keep
// using the original destination.

export function createStore({ idempotent = true } = {}) {
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
    snapshot() {
      return {
        idempotent,
        writeCount,
        putCount,
        rows: this.list(),
        effects: [...effects],
      };
    },
    load(saved) {
      rows.clear();
      effects.clear();
      for (const row of saved.rows) {
        rows.set(row.ghost_id, { ...row });
      }
      for (const effectId of saved.effects) {
        effects.add(effectId);
      }
      writeCount = saved.writeCount;
      putCount = saved.putCount;
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
