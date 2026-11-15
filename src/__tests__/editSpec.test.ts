/** Edit specs (#340): naming, parsing, and source change detection. */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editSpecPath, parseEditSpec, readEditSpec, sourceChange, sourceStamp, writeEditSpec, EDIT_SPEC_VERSION } from "../utils/editSpec.js";

const dir = mkdtempSync(join(tmpdir(), "sc-editspec-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("edit specs (#340)", () => {
  it("round-trips next to the output", () => {
    const src = join(dir, "src.mp4");
    writeFileSync(src, "video");
    const out = join(dir, "out.mp4");
    const path = writeEditSpec(out, { serverVersion: "1.0.0", source: sourceStamp(src), steps: [{ op: "trim", start: 1, end: 2 }], quality: "draft" });
    expect(path).toBe(editSpecPath(out));
    const spec = readEditSpec(path);
    expect(spec).toMatchObject({ version: EDIT_SPEC_VERSION, tool: "pipeline", output: out, quality: "draft" });
    expect(sourceChange(spec)).toBeNull();
    writeFileSync(src, "edited video");
    expect(sourceChange(spec)).toMatch(/changed since/);
    rmSync(src);
    expect(sourceChange(spec)).toMatch(/is gone/);
  });

  it("rejects what is not a spec, or one from a newer version", () => {
    expect(() => parseEditSpec("{")).toThrow(/not valid JSON/);
    expect(() => parseEditSpec(JSON.stringify({ tool: "other" }))).toThrow(/not a pipeline edit spec/);
    const newer = { version: EDIT_SPEC_VERSION + 1, tool: "pipeline", steps: [], source: { path: "a", size: 1, mtimeMs: 1 } };
    expect(() => parseEditSpec(JSON.stringify(newer))).toThrow(/newer version/);
    expect(() => readEditSpec(join(dir, "missing.edit.json"))).toThrow(/not found/);
  });
});
