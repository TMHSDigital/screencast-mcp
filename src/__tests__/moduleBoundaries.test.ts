/**
 * The video clock and the sidecar finalizers live outside events.ts (#360), so
 * perf and log sidecars and the pause/stop paths do not load the input-hook
 * module (its PowerShell helper source and spawn wiring).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UTILS = join(__dirname, "..", "utils");
const importsEvents = (file: string) => /from "\.\/events\.js"/.test(readFileSync(join(UTILS, file), "utf8"));

describe("module boundaries (#360)", () => {
  it.each(["clock.ts", "finalizers.ts", "perf.ts", "logTail.ts", "pause.ts", "lifecycle.ts"])("%s does not import events.ts", (file) => {
    expect(importsEvents(file)).toBe(false);
  });
});
