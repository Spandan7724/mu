const MASK = "••••";
// Short values would redact ordinary words; real passwords and codes are longer.
const MIN_LENGTH = 4;

// Values typed into or read from password/one-time-code fields during this
// session. Held in memory only, and used to scrub everything the model or the
// transcript could see.
export class SecretRegistry {
  private readonly values = new Set<string>();

  add(value: string | undefined): void {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_LENGTH) this.values.add(trimmed);
    if (value.length >= MIN_LENGTH) this.values.add(value);
  }

  get size(): number {
    return this.values.size;
  }

  redact(text: string): string {
    if (this.values.size === 0 || !text) return text;
    let result = text;
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      if (result.includes(value)) result = result.split(value).join(MASK);
    }
    return result;
  }

  // Deep copy with every string scrubbed; non-plain values pass through.
  redactDeep<T>(value: T): T {
    if (this.values.size === 0) return value;
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as T;
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          this.redactDeep(item),
        ]),
      ) as T;
    }
    return value;
  }
}
