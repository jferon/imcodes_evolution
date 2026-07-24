/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'file_browser.title_dir': '选择目录',
      'file_browser.browse': '浏览',
    }[key] ?? key),
  }),
}));

vi.mock('../../src/components/file-browser-lazy.js', () => ({
  FileBrowser: (props: {
    initialPath?: string;
    highlightPath?: string;
    onConfirm: (paths: string[]) => void;
  }) => (
    <div
      data-testid="directory-browser"
      data-initial-path={props.initialPath}
      data-highlight-path={props.highlightPath}
    >
      <button onClick={() => props.onConfirm(['/workspace/requirements'])}>choose-test-directory</button>
    </div>
  ),
}));

import { EvolutionControlConsole } from '../../src/components/EvolutionControlConsole.js';

afterEach(() => cleanup());

describe('EvolutionControlConsole requirement directory picker', () => {
  it('opens the cross-platform directory browser and applies the selected watcher directory', () => {
    const onSetInboxDirectory = vi.fn(() => 'req-set-directory');
    render(
      <EvolutionControlConsole
        ws={{} as never}
        projection={null}
        watchers={[]}
        sessionName="deck_demo_brain"
        projectRoot="/workspace/project"
        projectLabel="demo"
        onOpenWarRoom={vi.fn()}
        onLaunchDemo={vi.fn()}
        onScanInbox={vi.fn()}
        onSetInboxDirectory={onSetInboxDirectory}
        onSendUserMessage={vi.fn()}
        onRefresh={vi.fn()}
        onNewSubSession={vi.fn()}
        onStartDiscussion={vi.fn()}
        onViewDiscussions={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '选择目录' }));
    const browser = screen.getByTestId('directory-browser');
    expect(browser.getAttribute('data-initial-path')).toBe('/workspace/project');
    expect(browser.getAttribute('data-highlight-path')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'choose-test-directory' }));
    expect(onSetInboxDirectory).toHaveBeenCalledWith('/workspace/requirements');
    expect(screen.queryByTestId('directory-browser')).toBeNull();
    expect(screen.getByRole('button', { name: '选择目录' }).textContent)
      .toContain('/workspace/requirements');
  });
});

describe('EvolutionControlConsole stage breathing light', () => {
  function renderWithProjection(stage: string) {
    render(
      <EvolutionControlConsole
        ws={{} as never}
        projection={{
          stage,
          roles: [],
          artifacts: [],
          blockingQuestions: [],
          evidence: [],
          discussion: [],
        } as never}
        watchers={[]}
        sessionName="deck_demo_brain"
        projectRoot="/workspace/project"
        projectLabel="demo"
        onOpenWarRoom={vi.fn()}
        onLaunchDemo={vi.fn()}
        onScanInbox={vi.fn()}
        onSetInboxDirectory={vi.fn()}
        onSendUserMessage={vi.fn()}
        onRefresh={vi.fn()}
        onNewSubSession={vi.fn()}
        onStartDiscussion={vi.fn()}
        onViewDiscussions={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  }

  it('breathes (sub-session pulse class) on the currently-executing stage card only', () => {
    renderWithProjection('design_lofi');
    const card = screen.getByText('低保真').closest('.evolution-control-stage');
    expect(card?.className).toContain('current');
    expect(card?.className).toContain('subcard-running-pulse');
    // Non-current cards never breathe.
    const other = screen.getByText('开发 Loop').closest('.evolution-control-stage');
    expect(other?.className).not.toContain('subcard-running-pulse');
  });

  it('does not breathe while the run waits for a human', () => {
    renderWithProjection('needs_human');
    expect(document.querySelector('.subcard-running-pulse')).toBeNull();
  });
});
