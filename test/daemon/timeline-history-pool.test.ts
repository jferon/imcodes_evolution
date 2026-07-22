import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  TimelineHistoryWorkerPool,
  type TimelineHistoryWorkerThreadLike,
} from '../../src/daemon/timeline-history-pool.js';
import type { TimelineHistoryBuildJobInput, TimelineHistoryWorkerRequest } from '../../src/daemon/timeline-history-worker-types.js';
import { TIMELINE_HISTORY_ERROR_REASONS } from '../../shared/timeline-history-errors.js';

class CrashWorker extends EventEmitter implements TimelineHistoryWorkerThreadLike {
  postMessage(_message: TimelineHistoryWorkerRequest): void {}
  terminate(): Promise<unknown> { return Promise.resolve(); }
  unref(): void {}
}

const job: TimelineHistoryBuildJobInput = {
  sessionName: 'deck_test_brain',
  limit: 10,
  contentTypes: ['user.message'],
  stateTypes: ['session.state'],
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TimelineHistoryWorkerPool failure throttling', () => {
  it('disables a crash-looping worker slot and rejects new jobs instead of restarting forever', async () => {
    let created = 0;
    const pool = new TimelineHistoryWorkerPool({
      workersTarget: 1,
      restartBackoffMs: 1,
      maxConsecutiveFailures: 2,
      createWorker: () => {
        created += 1;
        const worker = new CrashWorker();
        queueMicrotask(() => {
          worker.emit('error', new Error('boom'));
          worker.emit('exit', 1);
        });
        return worker;
      },
    });

    await expect(pool.dispatch(job, { deadlineAt: Date.now() + 100 })).rejects.toMatchObject({
      reason: TIMELINE_HISTORY_ERROR_REASONS.CRASHED,
    });

    await delay(25);
    expect(created).toBe(2);

    await expect(pool.dispatch(job, { deadlineAt: Date.now() + 100 })).rejects.toMatchObject({
      reason: TIMELINE_HISTORY_ERROR_REASONS.UNAVAILABLE,
    });
    expect(created).toBe(2);

    await pool.shutdown();
  });
});
