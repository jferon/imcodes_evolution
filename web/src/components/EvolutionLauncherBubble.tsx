/**
 * EvolutionLauncherBubble — small draggable circular "E" launcher for the
 * Evolution Factory console.
 *
 * Was previously a wide pill (up to 360px, ~72px tall) permanently anchored
 * at top:84/right:24, which sat on top of the top-right toolbar (settings,
 * server icons) with no way to move it. Now a compact free-floating bubble
 * the user can drag anywhere on screen; position persists across reloads.
 *
 * Drag vs. tap follows the same pointer-capture + movement-threshold idiom
 * used by SubSessionCard's resize handle and MobileDpad: a real drag sets a
 * `moved` flag and is suppressed from also firing a click, while a plain tap
 * (mouse or touch) or a keyboard activation (Enter/Space, which only ever
 * dispatches `click`) opens the console.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

interface Props {
  disabled?: boolean;
  isActive?: boolean;
  title: string;
  onOpen: () => void;
}

interface Pos { x: number; y: number; }

const STORAGE_KEY = 'imcodes_evolution_launcher_pos';
const SIZE = 52;
const EDGE_MARGIN = 8;
const DRAG_THRESHOLD = 4;

function clampPos(pos: Pos): Pos {
  const maxX = Math.max(EDGE_MARGIN, window.innerWidth - SIZE - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, window.innerHeight - SIZE - EDGE_MARGIN);
  return {
    x: Math.min(Math.max(pos.x, EDGE_MARGIN), maxX),
    y: Math.min(Math.max(pos.y, EDGE_MARGIN), maxY),
  };
}

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return clampPos(JSON.parse(raw));
  } catch { /* corrupt/blocked storage — fall through to default */ }
  return clampPos({ x: window.innerWidth - SIZE - 24, y: 84 });
}

function savePos(pos: Pos) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch { /* quota/blocked storage */ }
}

export function EvolutionLauncherBubble({ disabled, isActive, title, onOpen }: Props) {
  const [pos, setPos] = useState<Pos>(loadPos);
  const posRef = useRef(pos);
  posRef.current = pos;

  // Re-clamp on viewport resize/rotation so the bubble can't get stranded
  // off-screen (mirrors FloatingPanel's resize handling).
  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const dragRef = useRef<{ pointerId: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false);

  const handlePointerDown = useCallback((e: PointerEvent) => {
    if (disabled) return;
    dragRef.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: posRef.current.x, oy: posRef.current.y };
    movedRef.current = false;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch { /* setPointerCapture unsupported (old browsers/jsdom) — drag still tracked via move events */ }
  }, [disabled]);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!movedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    movedRef.current = true;
    setPos(clampPos({ x: drag.ox + dx, y: drag.oy + dy }));
    e.preventDefault();
  }, []);

  const endDrag = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (movedRef.current) savePos(posRef.current);
  }, []);

  const handleClick = useCallback((e: MouseEvent) => {
    // A native `disabled` button already blocks real user clicks and
    // `.click()`, but an event dispatched straight at the element (e.g.
    // `element.dispatchEvent(new MouseEvent('click'))`) bypasses that —
    // guard explicitly rather than relying solely on the HTML attribute.
    if (disabled) return;
    if (movedRef.current) {
      // This click is the tail end of a drag release — consume it once and
      // don't open the console.
      movedRef.current = false;
      e.preventDefault();
      return;
    }
    onOpen();
  }, [disabled, onOpen]);

  return (
    <span
      class={`evolution-global-launcher-shell${isActive ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
      style={{ left: pos.x, top: pos.y }}
    >
      <button
        type="button"
        class={`evolution-global-launcher${isActive ? ' is-active' : ''}`}
        disabled={disabled}
        title={title}
        aria-label={title}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={handleClick}
      >
        E
      </button>
    </span>
  );
}
