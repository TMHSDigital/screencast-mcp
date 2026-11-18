/**
 * Modules split out for #360 stay split. The video clock and the sidecar
 * finalizers live outside events.ts, so perf and log sidecars and the
 * pause/stop paths do not load the input-hook module (its PowerShell helper
 * source and spawn wiring).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UTILS = join(__dirname, "..", "utils");
const imports = (file: string, mod: string) => readFileSync(join(UTILS, file), "utf8").includes(`from "./${mod}.js"`);

describe("module boundaries (#360)", () => {
  it.each(["clock.ts", "finalizers.ts", "perf.ts", "logTail.ts", "pause.ts", "lifecycle.ts"])("%s does not import events.ts", (file) => {
    expect(imports(file, "events")).toBe(false);
  });

  // The registry lock and pid helpers are generic: they must not reach back
  // into the session registry they were split out of.
  it.each(["processes.ts", "fileLock.ts"])("%s does not import sessions.ts", (file) => {
    expect(imports(file, "sessions")).toBe(false);
  });
});
