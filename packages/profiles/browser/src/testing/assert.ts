// Assertions for the driver conformance suite. They throw plain errors so the
// suite stays independent of any test framework and can run under bun:test, a
// release qualification script, or the in-process runner in this directory.
export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolation";
  }
}

export function fail(message: string): never {
  throw new ContractViolation(message);
}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

export function equal<T>(actual: T, expected: T, what: string): void {
  if (!Object.is(actual, expected)) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function defined<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) fail(`${what} is missing`);
  return value;
}

export function oneOf<T>(value: T, allowed: readonly T[], what: string): void {
  if (!allowed.includes(value)) {
    fail(`${what}: expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`);
  }
}

export function contains(haystack: string, needle: string, what: string): void {
  if (!haystack.includes(needle)) {
    fail(`${what}: expected to contain ${JSON.stringify(needle)}`);
  }
}

export function includes<T>(allowed: readonly T[], value: T, what: string): void {
  if (!allowed.includes(value)) {
    fail(`${what}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
  }
}

export function excludes(haystack: string, needle: string, what: string): void {
  if (haystack.includes(needle)) {
    fail(`${what}: must not contain ${JSON.stringify(needle)}`);
  }
}

export async function rejects(operation: () => Promise<unknown>, what: string): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return fail(`${what}: expected the operation to reject`);
}
