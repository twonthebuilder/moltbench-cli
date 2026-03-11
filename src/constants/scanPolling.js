export const DEFAULT_SCAN_POLL_RETRY_AFTER_MS = 500;
export const DEFAULT_SCAN_POLL_MAX_WAIT_MS = 60_000;
export const MAX_SCAN_POLL_RETRY_AFTER_MS = 5_000;

export const resolveScanPollingHints = ({
  retryAfterMs = DEFAULT_SCAN_POLL_RETRY_AFTER_MS,
  maxWaitMs = DEFAULT_SCAN_POLL_MAX_WAIT_MS,
  lastProgressAt = null
} = {}) => ({
  retryAfterMs: Math.max(100, Math.min(Number(retryAfterMs) || 0, MAX_SCAN_POLL_RETRY_AFTER_MS)),
  maxWaitMs: Math.max(1_000, Number(maxWaitMs) || DEFAULT_SCAN_POLL_MAX_WAIT_MS),
  lastProgressAt: typeof lastProgressAt === 'string' ? lastProgressAt : null
});
