import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (typeof options?.defaultValue === 'string' ? options.defaultValue : key),
  }),
}));

import { EvolutionBlockingDialog } from '../../src/components/EvolutionBlockingDialog.js';
import type { EvolutionProjection } from '@shared/evolution-pipeline-types.js';

afterEach(() => cleanup());

function blockedProjection(overrides: Partial<EvolutionProjection> = {}): EvolutionProjection {
  return {
    runId: 'evo-20260724-abc',
    stage: 'needs_human',
    blockingQuestions: [
      { id: 'q-1', stage: 'design_lofi', question: 'Maker outputs failed promotion — artifacts/prd.md missing.', createdAt: 1 },
    ],
    gates: [],
    ...overrides,
  } as unknown as EvolutionProjection;
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    projection: blockedProjection(),
    continuePending: false,
    dismissedSignature: null,
    onDismiss: vi.fn(),
    onContinue: vi.fn(),
    onOpenWarRoom: vi.fn(),
    ...overrides,
  };
}

describe('EvolutionBlockingDialog', () => {
  it('pops up with the blocking reasons and confirms with one click when no typed gate is open', () => {
    const p = props();
    render(<EvolutionBlockingDialog {...p} />);
    expect(screen.getByTestId('evolution-blocking-dialog')).toBeTruthy();
    expect(screen.getByText(/artifacts\/prd\.md missing/)).toBeTruthy();
    fireEvent.click(screen.getByText('Confirm & continue'));
    expect(p.onContinue).toHaveBeenCalledTimes(1);
    expect(p.onDismiss).toHaveBeenCalledWith(expect.stringContaining('evo-20260724-abc'));
  });

  it('routes to the War Room instead of blind-confirming when a typed gate is open', () => {
    const p = props({
      projection: blockedProjection({
        gates: [{ id: 'gate:design_review:rs-1', kind: 'design_review', stage: 'design_hifi', status: 'open', candidateRevisionIds: [], requiredAssurance: 'human_approved', openedAt: 1 }],
      } as unknown as Partial<EvolutionProjection>),
    });
    render(<EvolutionBlockingDialog {...p} />);
    expect(screen.queryByText('Confirm & continue')).toBeNull();
    fireEvent.click(screen.getByText('Open War Room'));
    expect(p.onOpenWarRoom).toHaveBeenCalledTimes(1);
    expect(p.onContinue).not.toHaveBeenCalled();
    expect(p.onDismiss).toHaveBeenCalled();
  });

  it('stays hidden for an already-dismissed blocker set but re-pops for a NEW one', () => {
    const p = props();
    const { rerender } = render(<EvolutionBlockingDialog {...p} />);
    expect(screen.getByTestId('evolution-blocking-dialog')).toBeTruthy();
    const signature = 'evo-20260724-abc|q-1|';
    rerender(<EvolutionBlockingDialog {...props({ dismissedSignature: signature })} />);
    expect(screen.queryByTestId('evolution-blocking-dialog')).toBeNull();
    // A new blocking question changes the signature → dialog re-appears.
    rerender(<EvolutionBlockingDialog {...props({
      dismissedSignature: signature,
      projection: blockedProjection({
        blockingQuestions: [
          { id: 'q-1', stage: 'design_lofi', question: 'Maker outputs failed promotion — artifacts/prd.md missing.', createdAt: 1 },
          { id: 'q-2', stage: 'tasks_ready', question: 'Auto delivery could not start: launcher crashed.', createdAt: 2 },
        ],
      } as unknown as Partial<EvolutionProjection>),
    })} />);
    expect(screen.getByTestId('evolution-blocking-dialog')).toBeTruthy();
  });

  it('renders nothing when the run is not blocked', () => {
    render(<EvolutionBlockingDialog {...props({ projection: blockedProjection({ stage: 'tasks_ready' } as unknown as Partial<EvolutionProjection>) })} />);
    expect(screen.queryByTestId('evolution-blocking-dialog')).toBeNull();
    render(<EvolutionBlockingDialog {...props({ projection: null })} />);
    expect(screen.queryByTestId('evolution-blocking-dialog')).toBeNull();
  });
});
