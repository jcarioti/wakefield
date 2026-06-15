export class SpectrumDeliveryLaneScheduler {
  #lanes = new Map();

  run(record, operation) {
    const key = deliveryLaneKey(record);
    const previous = this.#lanes.get(key) || Promise.resolve();
    const tracked = previous
      .catch(() => {})
      .then(operation)
      .finally(() => {
        if (this.#lanes.get(key) === tracked) {
          this.#lanes.delete(key);
        }
      });
    this.#lanes.set(key, tracked);
    tracked.catch(() => {});
    return tracked;
  }

  size() {
    return this.#lanes.size;
  }
}

export function deliveryLaneKey(record) {
  return [record?.targetId || "", record?.spaceId || ""].join("\u0000");
}
