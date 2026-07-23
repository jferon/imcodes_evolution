/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const saveUserPrefMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/api.js', () => ({
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
}));

import { StartDiscussionDialog } from '../../src/components/StartDiscussionDialog.js';

describe('StartDiscussionDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the title as a heading (picks up .dialog-header h2 styling)', () => {
    render(
      <StartDiscussionDialog
        onStartRequested={vi.fn()}
        existingSessions={[]}
        onClose={vi.fn()}
      />,
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('discussion.dialog_title');
  });

  it('marks only the current arbiter participant as primary; the rest are secondary', () => {
    const { container } = render(
      <StartDiscussionDialog
        onStartRequested={vi.fn()}
        existingSessions={[]}
        onClose={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll('.discussion-participant-row');
    expect(rows).toHaveLength(2);
    const verdictButtons = Array.from(rows, (row) => row.querySelector('button') as HTMLButtonElement);

    expect(verdictButtons[0].className).toContain('btn-primary');
    expect(verdictButtons[0].className).not.toContain('btn-secondary');
    expect(verdictButtons[0].textContent).toBe('discussion.arbiter_active');

    expect(verdictButtons[1].className).toContain('btn-secondary');
    expect(verdictButtons[1].className).not.toContain('btn-primary');
    expect(verdictButtons[1].textContent).toBe('discussion.arbiter');
  });

  it('reassigns the arbiter badge when a different participant is chosen', () => {
    const { container } = render(
      <StartDiscussionDialog
        onStartRequested={vi.fn()}
        existingSessions={[]}
        onClose={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll('.discussion-participant-row');
    const secondVerdictButton = rows[1].querySelector('button') as HTMLButtonElement;
    fireEvent.click(secondVerdictButton);

    const rowsAfter = container.querySelectorAll('.discussion-participant-row');
    const verdictButtons = Array.from(rowsAfter, (row) => row.querySelector('button') as HTMLButtonElement);
    expect(verdictButtons[0].className).toContain('btn-secondary');
    expect(verdictButtons[1].className).toContain('btn-primary');
  });

  it('disables Start until a topic is entered, then submits with the expected payload', () => {
    const onStartRequested = vi.fn();
    const onClose = vi.fn();
    render(
      <StartDiscussionDialog
        onStartRequested={onStartRequested}
        existingSessions={[]}
        defaultCwd="/tmp/project"
        onClose={onClose}
      />,
    );

    const startButton = screen.getByText('discussion.start_button') as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);

    const topicInput = screen.getByPlaceholderText('discussion.topic_placeholder');
    fireEvent.input(topicInput, { target: { value: 'Review the release plan' } });
    expect(startButton.disabled).toBe(false);

    fireEvent.click(startButton);

    expect(onStartRequested).toHaveBeenCalledOnce();
    const payload = onStartRequested.mock.calls[0][0];
    expect(payload.topic).toBe('Review the release plan');
    expect(payload.cwd).toBe('/tmp/project');
    expect(payload.maxRounds).toBe(3);
    expect(payload.verdictIdx).toBe(0);
    expect(payload.participants).toHaveLength(2);
    expect(payload.participants[0]).toMatchObject({ roleId: 'critic', agentType: 'claude-code', model: 'opus[1M]' });
    expect(payload.participants[1]).toMatchObject({ roleId: 'pragmatist', agentType: 'claude-code', model: 'sonnet' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('adds a third participant and hides the add button at the 3-participant cap', () => {
    const { container } = render(
      <StartDiscussionDialog
        onStartRequested={vi.fn()}
        existingSessions={[]}
        onClose={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('.discussion-participant-row')).toHaveLength(2);
    fireEvent.click(screen.getByText('discussion.add_participant'));

    expect(container.querySelectorAll('.discussion-participant-row')).toHaveLength(3);
    expect(screen.queryByText('discussion.add_participant')).toBeNull();
  });

  it('closes without starting when Cancel is clicked', () => {
    const onStartRequested = vi.fn();
    const onClose = vi.fn();
    render(
      <StartDiscussionDialog
        onStartRequested={onStartRequested}
        existingSessions={[]}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('common.cancel'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onStartRequested).not.toHaveBeenCalled();
  });
});
