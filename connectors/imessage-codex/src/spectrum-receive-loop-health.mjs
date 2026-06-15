export class SpectrumOperationTimeoutError extends Error {
  constructor({ label, timeoutMs }) {
    super(`Photon/Spectrum operation timed out after ${timeoutMs}ms: ${label}`);
    this.name = "SpectrumOperationTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
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
