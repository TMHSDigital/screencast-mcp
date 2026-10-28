// Shared test helpers (not a test file: vitest only collects *.test.ts).

/** Narrow away `undefined` (an index read under noUncheckedIndexedAccess, a
 * find(), a regex group), failing the test with a clear message instead. */
export function defined<T>(value: T | undefined, what = "value"): T {
  if (value === undefined) throw new Error(`Expected ${what} to be defined.`);
  return value;
}

/** The argument after `flag` in an ffmpeg-style argument list. */
export function argAfter(args: readonly string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i === -1) throw new Error(`Expected ${flag} in the arguments.`);
  return defined(args[i + 1], `a value after ${flag}`);
}
