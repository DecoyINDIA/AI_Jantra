/**
 * Bounded-concurrency map. Runs `run` over `values` with at most `concurrency`
 * in flight at once, preserving result order. Shared by the research fan-out
 * and the skeptic verification pass so neither fires an unbounded burst of
 * provider calls (which would translate rate limits straight into failures).
 */
export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  run: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await run(value, index);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, () => worker()),
  );
  return results;
}
