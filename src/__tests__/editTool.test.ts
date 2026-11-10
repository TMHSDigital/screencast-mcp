/**
 * The shared edit-tool scaffold (#308): requireInput and editOutput, plus a
 * guard that tools use them instead of re-pasting the checks.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "sc-edittool-"));
process.env.SCREENCAST_HOME = home;
const { requireInput, editOutput } = await import("../utils/editTool.js");

describe("requireInput", () => {
  let file: string;
  beforeAll(() => {
    file = join(home, "in.mp4");
    writeFileSync(file, "");
  });

  it("passes an existing file and names a missing one", () => {
    expect(() => requireInput(file)).not.toThrow();
    expect(() => requireInput(join(home, "nope.mp4"))).toThrow(/^Input file not found: .*nope\.mp4$/);
    expect(() => requireInput(join(home, "bg.png"), "Background image")).toThrow(/^Background image not found:/);
  });
});

describe("editOutput", () => {
  it("names a default output under the chosen folder", () => {
    expect(editOutput(undefined, "trim", ".mp4")).toMatch(/[\\/]edits[\\/]trim-.+\.mp4$/);
    expect(editOutput(undefined, "shot", ".png", { dir: "screenshots" })).toMatch(/[\\/]screenshots[\\/]shot-.+\.png$/);
  });

  it("refuses an H.264-incapable container unless told any container will do", () => {
    const webm = join(home, "out.webm");
    expect(() => editOutput(webm, "crop", ".mp4")).toThrow(/cannot hold/);
    expect(editOutput(webm, "concat", ".webm", { anyContainer: true })).toBe(webm);
  });
});

describe("tools use the shared scaffold (#308)", () => {
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "tools");
  const files = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));

  it("no tool hand-rolls the input-exists check", () => {
    const offenders = files.filter((f) => /throw new ScreencastError\(`Input file not found/.test(readFileSync(join(toolsDir, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no tool builds a default edit name by hand", () => {
    const offenders = files.filter((f) => /resolveOutput\(\s*[^,]+,\s*subdir\("edits"\)/.test(readFileSync(join(toolsDir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
