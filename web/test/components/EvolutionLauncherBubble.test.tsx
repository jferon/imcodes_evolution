/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { EvolutionLauncherBubble } from '../../src/components/EvolutionLauncherBubble.js';

const STORAGE_KEY = 'imcodes_evolution_launcher_pos';
const SIZE = 52;
const EDGE_MARGIN = 8;

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

// `window.PointerEvent` is undefined in this jsdom version, so Preact can't
// register real native 'pointerdown'/'pointermove'/'pointerup' listeners for
// onPointerDown/onPointerMove/onPointerUp — it falls back to registering
// them under the capitalized synthetic names 'PointerDown'/'PointerMove'/
// 'PointerUp' instead (verified by proxying addEventListener). Dispatching
// only the lowercase native name is inert here. This mirrors the existing
// SessionTabs.test.tsx drag-testing convention in this repo, which dispatches
// both casings so the same helper also keeps working if jsdom ever adds real
// PointerEvent support (native 'pointerdown' would then matter too).
function firePointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { pointerId: number; clientX: number; clientY: number },
) {
  const win = target.ownerDocument.defaultView ?? window;
  const capitalized = {
    pointerdown: 'PointerDown',
    pointermove: 'PointerMove',
    pointerup: 'PointerUp',
    pointercancel: 'PointerCancel',
  }[type];
  for (const eventName of [type, capitalized]) {
    const event = new win.MouseEvent(eventName, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: init.clientX,
      clientY: init.clientY,
    });
    Object.defineProperties(event, {
      pointerId: { value: init.pointerId, configurable: true },
      pointerType: { value: 'mouse', configurable: true },
    });
    act(() => {
      target.dispatchEvent(event);
    });
  }
}

describe('EvolutionLauncherBubble', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewport(1024, 768);
  });

  afterEach(() => {
    cleanup();
    setViewport(originalInnerWidth, originalInnerHeight);
  });

  it('renders the compact "E" mark with the given tooltip and no leftover pill copy', () => {
    render(<EvolutionLauncherBubble title="Open Evolution Factory" onOpen={() => {}} />);
    const button = screen.getByRole('button', { name: 'Open Evolution Factory' });
    expect(button.textContent).toBe('E');
    expect(button.getAttribute('title')).toBe('Open Evolution Factory');
    expect(button.querySelector('.evolution-global-launcher-mark')).toBeNull();
    expect(button.querySelector('.evolution-global-launcher-copy')).toBeNull();
  });

  it('applies the is-active class only when isActive is true', () => {
    const { rerender } = render(<EvolutionLauncherBubble title="x" onOpen={() => {}} />);
    expect(screen.getByRole('button').className).not.toContain('is-active');

    rerender(<EvolutionLauncherBubble title="x" isActive onOpen={() => {}} />);
    expect(screen.getByRole('button').className).toContain('is-active');
  });

  it('opens the console on a plain click with no pointer movement', () => {
    const onOpen = vi.fn();
    render(<EvolutionLauncherBubble title="x" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('opens the console via keyboard activation (native button Enter/Space semantics)', () => {
    const onOpen = vi.fn();
    render(<EvolutionLauncherBubble title="x" onOpen={onOpen} />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    button.focus();
    // No pointer events at all for keyboard activation — only the trailing
    // click the browser dispatches for Enter/Space on a focused <button>.
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('does not open while disabled', () => {
    const onOpen = vi.fn();
    render(<EvolutionLauncherBubble title="x" onOpen={onOpen} disabled />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('treats sub-threshold pointer jitter as a tap, not a drag', () => {
    const onOpen = vi.fn();
    render(<EvolutionLauncherBubble title="x" onOpen={onOpen} />);
    const button = screen.getByRole('button');

    firePointer(button, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    firePointer(button, 'pointermove', { pointerId: 1, clientX: 101, clientY: 101 }); // ~1.4px, under the 4px threshold
    firePointer(button, 'pointerup', { pointerId: 1, clientX: 101, clientY: 101 });
    fireEvent.click(button); // real browsers fire click after pointerup on a non-drag tap

    expect(onOpen).toHaveBeenCalledOnce();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('dragging past the threshold moves the bubble and suppresses the trailing click', () => {
    const onOpen = vi.fn();
    render(<EvolutionLauncherBubble title="x" onOpen={onOpen} />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    const startLeft = parseFloat(button.style.left);
    const startTop = parseFloat(button.style.top);

    // Default spawn position is near the right edge (viewport - SIZE - 24),
    // so drag left/down by a modest amount that stays well clear of the
    // viewport clamp boundary — this test is about the move+suppress
    // mechanics, not clamping (covered separately below).
    firePointer(button, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 200 });
    firePointer(button, 'pointermove', { pointerId: 2, clientX: 170, clientY: 220 }); // dx=-30, dy=20
    firePointer(button, 'pointerup', { pointerId: 2, clientX: 170, clientY: 220 });
    fireEvent.click(button); // must be swallowed — this was a drag, not a tap

    expect(parseFloat(button.style.left)).toBe(startLeft - 30);
    expect(parseFloat(button.style.top)).toBe(startTop + 20);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores pointermove events from an unrelated pointerId while dragging', () => {
    render(<EvolutionLauncherBubble title="x" onOpen={() => {}} />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    const startLeft = parseFloat(button.style.left);

    firePointer(button, 'pointerdown', { pointerId: 7, clientX: 200, clientY: 200 });
    firePointer(button, 'pointermove', { pointerId: 99, clientX: 500, clientY: 500 }); // different pointer — must not move it
    expect(parseFloat(button.style.left)).toBe(startLeft);

    firePointer(button, 'pointerup', { pointerId: 7, clientX: 200, clientY: 200 });
  });

  it('persists the dragged position to localStorage and restores it on the next mount', () => {
    const first = render(<EvolutionLauncherBubble title="x" onOpen={() => {}} />);
    const button = screen.getByRole('button') as HTMLButtonElement;

    firePointer(button, 'pointerdown', { pointerId: 3, clientX: 200, clientY: 200 });
    firePointer(button, 'pointermove', { pointerId: 3, clientX: 150, clientY: 260 }); // dx=-50, dy=60
    firePointer(button, 'pointerup', { pointerId: 3, clientX: 150, clientY: 260 });

    const left = button.style.left;
    const top = button.style.top;
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    expect(saved).toEqual({ x: parseFloat(left), y: parseFloat(top) });

    first.unmount();
    render(<EvolutionLauncherBubble title="x" onOpen={() => {}} />);
    const remounted = screen.getByRole('button') as HTMLButtonElement;
    expect(remounted.style.left).toBe(left);
    expect(remounted.style.top).toBe(top);
  });

  it('clamps the dragged position so the bubble always stays fully inside the viewport', () => {
    render(<EvolutionLauncherBubble title="x" onOpen={() => {}} />);
    const button = screen.getByRole('button') as HTMLButtonElement;

    firePointer(button, 'pointerdown', { pointerId: 4, clientX: 0, clientY: 0 });
    firePointer(button, 'pointermove', { pointerId: 4, clientX: -5000, clientY: -5000 });
    firePointer(button, 'pointerup', { pointerId: 4, clientX: -5000, clientY: -5000 });
    expect(parseFloat(button.style.left)).toBe(EDGE_MARGIN);
    expect(parseFloat(button.style.top)).toBe(EDGE_MARGIN);

    firePointer(button, 'pointerdown', { pointerId: 5, clientX: 0, clientY: 0 });
    firePointer(button, 'pointermove', { pointerId: 5, clientX: 5000, clientY: 5000 });
    firePointer(button, 'pointerup', { pointerId: 5, clientX: 5000, clientY: 5000 });
    expect(parseFloat(button.style.left)).toBe(1024 - SIZE - EDGE_MARGIN);
    expect(parseFloat(button.style.top)).toBe(768 - SIZE - EDGE_MARGIN);
  });

  it('defaults to the top-right corner area when nothing is saved yet', () => {
    render(<EvolutionLauncherBubble title="x" onOpen={() => {}} />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(parseFloat(button.style.left)).toBe(1024 - SIZE - 24);
    expect(parseFloat(button.style.top)).toBe(84);
  });

  it('ignores corrupted localStorage content and falls back to the default position', () => {
    localStorage.setItem(STORAGE_KEY, '{not-json');
    render(<EvolutionLauncherBubble title="x" onOpen={() => {}} />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(parseFloat(button.style.left)).toBe(1024 - SIZE - 24);
    expect(parseFloat(button.style.top)).toBe(84);
  });

  it('re-clamps on window resize so the bubble is never stranded off-screen', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 900, y: 700 }));
    render(<EvolutionLauncherBubble title="x" onOpen={() => {}} />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(parseFloat(button.style.left)).toBe(900);
    expect(parseFloat(button.style.top)).toBe(700);

    act(() => {
      setViewport(500, 400);
      window.dispatchEvent(new Event('resize'));
    });

    expect(parseFloat(button.style.left)).toBe(500 - SIZE - EDGE_MARGIN);
    expect(parseFloat(button.style.top)).toBe(400 - SIZE - EDGE_MARGIN);
  });

  it('does not attempt to drag when disabled', () => {
    render(<EvolutionLauncherBubble title="x" onOpen={() => {}} disabled />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    const startLeft = button.style.left;

    firePointer(button, 'pointerdown', { pointerId: 6, clientX: 200, clientY: 200 });
    firePointer(button, 'pointermove', { pointerId: 6, clientX: 260, clientY: 240 });
    firePointer(button, 'pointerup', { pointerId: 6, clientX: 260, clientY: 240 });

    expect(button.style.left).toBe(startLeft);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
