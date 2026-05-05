import type { JsonEvent } from "./types.ts";

export class JsonEventWriter {
  #enabled: boolean;
  #seq = 0;

  constructor(enabled: boolean) {
    this.#enabled = enabled;
  }

  emit(kind: JsonEvent["kind"], type: string, data: Record<string, unknown>) {
    this.#seq += 1;
    if (!this.#enabled) return this.#seq;
    const payload: JsonEvent = {
      seq: this.#seq,
      kind,
      type,
      data,
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return this.#seq;
  }

  count() {
    return this.#seq;
  }
}
