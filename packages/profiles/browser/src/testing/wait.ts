// Test-only polling helper; product code waits on events instead.
export async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${label} not met within ${timeoutMs} ms`);
    await Bun.sleep(20);
  }
}
