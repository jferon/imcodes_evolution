import { describe, expect, it } from 'vitest';
import { withEvolutionMutationCommit } from '../../src/daemon/evolution-mutation-controller.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Evolution mutation controller', () => {
  it('serializes mutations for the same run in acceptance order', async () => {
    const firstMayFinish = deferred<void>();
    const firstStarted = deferred<void>();
    const events: string[] = [];

    const first = withEvolutionMutationCommit('run-a', async () => {
      events.push('first:start');
      firstStarted.resolve();
      await firstMayFinish.promise;
      events.push('first:end');
      return 'first';
    });
    await firstStarted.promise;

    const second = withEvolutionMutationCommit('run-a', async () => {
      events.push('second:start');
      events.push('second:end');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    firstMayFinish.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('does not let a blocked run stall an unrelated run', async () => {
    const runABlocked = deferred<void>();
    const runAStarted = deferred<void>();

    const runA = withEvolutionMutationCommit('run-a', async () => {
      runAStarted.resolve();
      await runABlocked.promise;
      return 'a';
    });
    await runAStarted.promise;

    await expect(withEvolutionMutationCommit('run-b', async () => 'b')).resolves.toBe('b');
    runABlocked.resolve();
    await expect(runA).resolves.toBe('a');
  });

  it('releases the queue after a failed mutation', async () => {
    await expect(withEvolutionMutationCommit('run-failure', async () => {
      throw new Error('write failed');
    })).rejects.toThrow('write failed');

    await expect(withEvolutionMutationCommit('run-failure', async () => 'recovered')).resolves.toBe('recovered');
  });
});
