const runMutationTails = new Map<string, Promise<void>>();

/**
 * Serializes durable mutation commits for one Evolution run while allowing
 * unrelated runs to progress independently. Callers still validate their CAS
 * token before mutating; this queue prevents two accepted commits from
 * interleaving runRevision increments and atomic run.json writes.
 */
export async function withEvolutionMutationCommit<T>(
  runId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = runMutationTails.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  runMutationTails.set(runId, tail);
  await previous.catch(() => undefined);
  try {
    return await mutation();
  } finally {
    release();
    if (runMutationTails.get(runId) === tail) runMutationTails.delete(runId);
  }
}
