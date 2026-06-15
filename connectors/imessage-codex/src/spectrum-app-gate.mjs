export class SpectrumAppOperationGate {
  #chain = Promise.resolve();
  #lastStartedAt = null;
  #minIntervalMs;
  #now;
  #sleep;

  constructor({
    minIntervalMs = 0,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    this.#minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.#now = now;
    this.#sleep = sleep;
  }

  run(operation) {
    const next = this.#chain.then(
      () => this.#runOperation(operation),
      () => this.#runOperation(operation)
    );
    this.#chain = next.catch(() => {});
    return next;
  }

  async #runOperation(operation) {
    await this.#waitForInterval();
    this.#lastStartedAt = this.#nowMs();
    return operation();
  }

  async #waitForInterval() {
    if (!this.#minIntervalMs || this.#lastStartedAt == null) {
      return;
    }
    const waitMs = this.#lastStartedAt + this.#minIntervalMs - this.#nowMs();
    if (waitMs > 0) {
      await this.#sleep(waitMs);
    }
  }

  #nowMs() {
    const value = this.#now();
    if (value instanceof Date) {
      return value.getTime();
    }
    return Number(value);
  }
}

export function isSpectrumChannelShutdownError(error) {
  return /channel has been shut down|connection dropped|connection closed|socket closed|socket hang up|closed before response/i
    .test(String(error?.message || error || ""));
}
