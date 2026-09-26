import { rm } from 'node:fs/promises';

import { LIMITS } from './constants.mjs';

const RETRYABLE_REMOVE_ERRORS = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function cleanupAfterBestEffortMarker(markPending, cleanup) {
  let markerError;
  try {
    await markPending();
  } catch (error) {
    markerError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (!markerError) throw cleanupError;
    throw new Error(`Could not persist the cleanup-pending marker: ${markerError?.message || String(markerError)}. Cleanup also failed: ${cleanupError?.message || String(cleanupError)}`, {
      cause: cleanupError,
    });
  }
}

export async function retryCleanupOperation(
  operation,
  {
    retries = LIMITS.cleanupRetries,
    retryDelayMs = LIMITS.cleanupRetryMs,
    shouldRetry = () => true,
  } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!shouldRetry(error) || attempt >= retries) throw error;
      await wait(retryDelayMs);
    }
  }
}

export async function removeTreeWithRetries(
  target,
  {
    remove = rm,
    retries = LIMITS.cleanupRetries,
    retryDelayMs = LIMITS.cleanupRetryMs,
  } = {},
) {
  await retryCleanupOperation(
    () => remove(target, { recursive: true, force: true }),
    {
      retries,
      retryDelayMs,
      shouldRetry: (error) => RETRYABLE_REMOVE_ERRORS.has(error?.code),
    },
  );
}
