/**
 * Minimal durable dispatch journal for Auto Deliver implementation sends
 * (discussion 30f25d75-67c, repair checklist #10).
 *
 * Append-only, hash-only (never prompt bodies): each dispatch writes a
 * `pending_send` record BEFORE `runtime.send`, then an outcome record after.
 * On daemon startup, entries from previous boots whose last state is still
 * `pending_send` are marked `reconciled_interrupted` — the crash window
 * between journal-write and transport-accept becomes an explicit record
 * instead of silence. `sent` means LOCAL transport acceptance only; it is
 * never provider-observed proof. No auto-resume: reconciliation records, it
 * does not replay.
 */
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const AUTO_DELIVER_DISPATCH_JOURNAL_PATH = join(homedir(), '.imcodes', 'auto-deliver-dispatch-journal.jsonl');
const MAX_JOURNAL_BYTES = 5 * 1024 * 1024;

export type DispatchJournalState =
  | 'pending_send'
  | 'local_transport_accepted'
  | 'queued'
  | 'resend_queued'
  | 'skipped_terminal'
  | 'reconciled_interrupted';

export interface DispatchJournalRecord {
  entryId: string;
  ts: number;
  state: DispatchJournalState;
  runId?: string;
  commandId?: string;
  sessionName?: string;
  promptSha256?: string;
  promptBytes?: number;
  skillHashes?: Array<{ roleId: string; sha256: string }>;
  providerSessionId?: string | null;
  bootId?: string;
}

/** Stable per-process boot identity so reconciliation can scope to prior boots. */
const BOOT_ID = `${process.pid}-${Date.now().toString(36)}`;

export function currentDispatchJournalBootId(): string {
  return BOOT_ID;
}

async function rotateIfNeeded(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (info.size > MAX_JOURNAL_BYTES) await rename(path, `${path}.1`);
  } catch {
    /* absent — nothing to rotate */
  }
}

/** Append one record. Failures are swallowed — journaling must never break dispatch. */
export async function appendDispatchJournalRecord(record: DispatchJournalRecord, journalPath = AUTO_DELIVER_DISPATCH_JOURNAL_PATH): Promise<void> {
  try {
    await mkdir(dirname(journalPath), { recursive: true });
    await rotateIfNeeded(journalPath);
    await appendFile(journalPath, `${JSON.stringify({ ...record, bootId: record.bootId ?? BOOT_ID })}\n`, 'utf8');
  } catch {
    /* best-effort durability; the send path must not fail on journal errors */
  }
}

export interface DispatchJournalReconciliation {
  interruptedEntryIds: string[];
}

/**
 * Mark prior-boot entries stuck at `pending_send` as `reconciled_interrupted`.
 * Read-modify is append-only: reconciliation appends records, never rewrites.
 */
export async function reconcileDispatchJournalOnStartup(journalPath = AUTO_DELIVER_DISPATCH_JOURNAL_PATH): Promise<DispatchJournalReconciliation> {
  let raw: string;
  try {
    raw = await readFile(journalPath, 'utf8');
  } catch {
    return { interruptedEntryIds: [] };
  }
  const lastStateByEntry = new Map<string, DispatchJournalRecord>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as DispatchJournalRecord;
      if (typeof record.entryId === 'string' && typeof record.state === 'string') {
        lastStateByEntry.set(record.entryId, record);
      }
    } catch {
      /* skip corrupt line — the journal is advisory evidence, not a DB */
    }
  }
  const interrupted: string[] = [];
  for (const [entryId, record] of lastStateByEntry) {
    if (record.state === 'pending_send' && record.bootId !== BOOT_ID) {
      interrupted.push(entryId);
      await appendDispatchJournalRecord({
        entryId,
        ts: Date.now(),
        state: 'reconciled_interrupted',
        ...(record.runId ? { runId: record.runId } : {}),
        ...(record.commandId ? { commandId: record.commandId } : {}),
      }, journalPath);
    }
  }
  return { interruptedEntryIds: interrupted };
}
