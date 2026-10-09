/** File-backed evaluation fixture for atomic budget reservation and retry idempotency. */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function policyLedger(path, totalBudget) {
  const lockPath = `${path}.lock`;
  async function locked(fn) {
    await mkdir(dirname(path), { recursive: true });
    let acquired = false;
    for (let i = 0; i < 200; i++) {
      try { await mkdir(lockPath); acquired = true; break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; await pause(5); }
    }
    if (!acquired) throw new Error('Evaluation ledger lock timed out');
    try {
      let state;
      try { state = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; state = { totalBudget: String(totalBudget), entries: {} }; }
      if (state.totalBudget !== String(totalBudget)) throw new Error('Evaluation ledger budget changed across restart');
      const result = await fn(state);
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(tmp, path);
      return result;
    } finally { await rm(lockPath, { recursive: true, force: true }); }
  }
  return {
    reserve(id, amount, binding) {
      return locked((state) => {
        if (!binding || !['url', 'network', 'asset', 'payTo'].every((key) => typeof binding[key] === 'string' && binding[key])) {
          throw new Error('Evaluation reservation requires URL, network, asset, and recipient binding');
        }
        if (state.entries[id]) {
          const existing = state.entries[id];
          if (existing.amount !== String(amount) || JSON.stringify(existing.binding) !== JSON.stringify(binding)) {
            throw new Error(`Idempotency key ${id} was reused with a different offer`);
          }
          return { ...existing, reused: true };
        }
        const atomic = BigInt(amount);
        if (atomic <= 0n) throw new Error('Amount must be positive');
        const used = Object.values(state.entries).reduce((sum, entry) =>
          sum + (entry.state === 'released' ? 0n : BigInt(entry.amount)), 0n);
        if (used + atomic > BigInt(state.totalBudget)) return { state: 'denied', amount: String(amount), reused: false };
        state.entries[id] = { state: 'reserved', amount: String(amount), binding };
        return { ...state.entries[id], reused: false };
      });
    },
    transition(id, from, to, evidence = {}) {
      return locked((state) => {
        const entry = state.entries[id];
        if (!entry || entry.state !== from) throw new Error(`Cannot transition ${id} from ${from}`);
        const allowed = { reserved: ['released', 'unknown', 'settled'], unknown: ['settled'] };
        if (!allowed[from]?.includes(to)) throw new Error(`Illegal evaluation transition ${from} -> ${to}`);
        if (to === 'settled' && (!evidence.simulatedVerified || !/^0x[0-9a-fA-F]{64}$/.test(evidence.transaction ?? ''))) {
          throw new Error('Simulated settlement requires a reconciled transaction marker');
        }
        entry.state = to;
        if (evidence.transaction) entry.transaction = evidence.transaction;
        return { ...entry };
      });
    },
    inspect() { return locked((state) => structuredClone(state)); },
  };
}
