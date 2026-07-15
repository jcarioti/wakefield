export class SpectrumOperationTimeoutError extends Error {
  constructor({ label, timeoutMs }) {
    super(`Photon/Spectrum operation timed out after ${timeoutMs}ms: ${label}`);
    this.name = "SpectrumOperationTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export const DEFAULT_SPECTRUM_RATE_LIMIT_COOLDOWN_MS = 60_000;

export function isSpectrumRateLimitError(error) {
  return error?.status === 429
    || error?.code === "RATE_LIMITED"
    || /too many requests|rate.?limit|resource exhausted/i.test(String(error?.message || ""));
}

export function spectrumRateLimitRetryAfterMs(error, {
  minimumMs = DEFAULT_SPECTRUM_RATE_LIMIT_COOLDOWN_MS
} = {}) {
  const minimum = Math.max(0, Number(minimumMs) || 0);
  const explicit = Number(error?.retryAfterMs ?? error?.retryAfter ?? error?.retry_after_ms);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(minimum, Math.ceil(explicit));
  }

  const match = String(error?.message || "").match(/retry\s+after\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m)?/i);
  if (!match) {
    return minimum;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return minimum;
  }
  const unit = String(match[2] || "ms").toLowerCase();
  const multiplier = /^(minutes?|mins?|m)$/.test(unit)
    ? 60_000
    : /^(seconds?|secs?|s)$/.test(unit)
      ? 1_000
      : 1;
  return Math.max(minimum, Math.ceil(value * multiplier));
}

export class SpectrumRateLimitCooldown {
  constructor({
    minimumMs = DEFAULT_SPECTRUM_RATE_LIMIT_COOLDOWN_MS,
    jitterMs = 1_000,
    now = () => Date.now(),
    random = Math.random
  } = {}) {
    this.minimumMs = Math.max(0, Number(minimumMs) || 0);
    this.jitterMs = Math.max(0, Number(jitterMs) || 0);
    this.now = now;
    this.random = random;
    this.until = null;
  }

  activate(error) {
    const baseMs = spectrumRateLimitRetryAfterMs(error, { minimumMs: this.minimumMs });
    const jitterMs = this.jitterMs > 0
      ? Math.floor(Math.max(0, Math.min(1, Number(this.random()) || 0)) * this.jitterMs)
      : 0;
    const nextUntil = this.now() + baseMs + jitterMs;
    const changed = !this.until || nextUntil > this.until;
    if (changed) {
      this.until = nextUntil;
    }
    return this.snapshot();
  }

  remainingMs() {
    if (!this.until) {
      return 0;
    }
    return Math.max(0, this.until - this.now());
  }

  snapshot() {
    const remainingMs = this.remainingMs();
    return {
      active: remainingMs > 0,
      until: this.until ? new Date(this.until).toISOString() : null,
      remainingMs
    };
  }
}

export async function withSpectrumOperationTimeout(
  operation,
  {
    label = "operation",
    timeoutMs,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = {}
) {
  const normalizedTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    return operation();
  }

  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeoutFn(() => {
      reject(new SpectrumOperationTimeoutError({
        label,
        timeoutMs: Math.floor(normalizedTimeoutMs)
      }));
    }, normalizedTimeoutMs);
    timeoutId?.unref?.();
  });

  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      timeout
    ]);
  } finally {
    if (timeoutId != null) {
      clearTimeoutFn(timeoutId);
    }
  }
}

export function isSpectrumOperationTimeoutError(error) {
  return error instanceof SpectrumOperationTimeoutError
    || error?.name === "SpectrumOperationTimeoutError";
}

export function spectrumServiceStatusForReceiveLoop(state) {
  switch (state) {
    case "running":
      return "online";
    case "starting":
      return "starting";
    case "rotating":
      return "receive-loop-rotating";
    case "restarting":
      return "receive-loop-restarting";
    case "rate-limited":
      return "rate-limited";
    case "errored":
      return "receive-loop-errored";
    case "failed":
      return "receive-loop-failed";
    case "stopping":
      return "stopping";
    default:
      return state ? `receive-loop-${state}` : "unknown";
  }
}

export function shouldRotateReceiveLoopAfterHistoryReplay({ reason, stats } = {}) {
  const recovered = Number(stats?.queuedCount || 0);
  if (!Number.isFinite(recovered) || recovered <= 0) {
    return false;
  }
  return /periodic history poll/i.test(String(reason || ""));
}
