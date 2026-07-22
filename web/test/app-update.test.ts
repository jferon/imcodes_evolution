import { describe, expect, it, vi } from 'vitest';
import {
  fetchCurrentAppBuildInfo,
  getLoadedWebBuildId,
  isAppBuildMismatch,
  isChunkLoadFailure,
  normalizeBuildId,
} from '../src/app-update.js';

describe('app update detection', () => {
  it('normalizes and compares concrete build IDs', () => {
    expect(normalizeBuildId(' abc ')).toBe('abc');
    expect(normalizeBuildId('')).toBeNull();
    expect(isAppBuildMismatch('old', 'new')).toBe(true);
    expect(isAppBuildMismatch('same', 'same')).toBe(false);
    expect(isAppBuildMismatch('old', null)).toBe(false);
  });

  it('does not treat the development build sentinel as a stale deployed app', () => {
    expect(isAppBuildMismatch('dev', 'stale-dist-build')).toBe(false);
  });

  it('keeps development mode on the sentinel even when Vite defines a concrete build ID', () => {
    vi.stubGlobal('__WEB_BUILD_ID__', 'vite-startup-build');
    expect(getLoadedWebBuildId()).toBe('dev');
    vi.unstubAllGlobals();
  });

  it('detects stale chunk import failures', () => {
    expect(isChunkLoadFailure(new Error('Failed to fetch dynamically imported module'))).toBe(true);
    expect(isChunkLoadFailure({ name: 'ChunkLoadError', message: 'Loading chunk 42 failed' })).toBe(true);
    expect(isChunkLoadFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isChunkLoadFailure(new Error('ordinary render failure'))).toBe(false);
  });

  it('fetches current app build info without caching', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ buildId: 'current-build', builtAt: '2026-05-26T00:00:00.000Z', packageVersion: '0.1.2' }),
    });

    await expect(fetchCurrentAppBuildInfo(fetchMock as never)).resolves.toEqual({
      buildId: 'current-build',
      builtAt: '2026-05-26T00:00:00.000Z',
      packageVersion: '0.1.2',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/app-build', expect.objectContaining({
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }));
  });

  it('treats unavailable build endpoint as non-blocking', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    await expect(fetchCurrentAppBuildInfo(fetchMock as never)).resolves.toBeNull();
  });
});
