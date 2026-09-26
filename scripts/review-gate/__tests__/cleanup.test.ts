import { describe, expect, it, vi } from 'vitest';

import {
  cleanupAfterBestEffortMarker,
  removeTreeWithRetries,
  retryCleanupOperation,
} from '../cleanup.mjs';

describe('bounded temporary-directory cleanup', () => {
  it('still removes a resource when its recovery marker cannot be updated', async () => {
    const cleanup = vi.fn(async () => {});

    await expect(cleanupAfterBestEffortMarker(
      async () => { throw new Error('marker unavailable'); },
      cleanup,
    )).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('reports both failures when the marker and cleanup operation fail', async () => {
    await expect(cleanupAfterBestEffortMarker(
      async () => { throw new Error('marker unavailable'); },
      async () => { throw new Error('remove unavailable'); },
    )).rejects.toThrow('marker unavailable. Cleanup also failed: remove unavailable');
  });

  it('retries transient Windows sharing violations', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const remove = vi.fn()
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockResolvedValue(undefined);

    await removeTreeWithRetries('temporary-review', {
      remove,
      retries: 2,
      retryDelayMs: 0,
    });

    expect(remove).toHaveBeenCalledTimes(3);
  });

  it('does not retry unexpected filesystem errors', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const remove = vi.fn().mockRejectedValue(denied);

    await expect(removeTreeWithRetries('temporary-review', {
      remove,
      retries: 20,
      retryDelayMs: 0,
    })).rejects.toBe(denied);

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('retries a bounded cleanup operation until a late process releases it', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('still registered'))
      .mockResolvedValue('removed');

    await expect(retryCleanupOperation(operation, {
      retries: 1,
      retryDelayMs: 0,
    })).resolves.toBe('removed');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
