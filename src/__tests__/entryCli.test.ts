/** The built entry point in CLI mode never builds the stdio server (#289). */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

describe.skipIf(!existsSync(ENTRY))("entry point in CLI mode (#289)", () => {
  it("does not construct the stdio server (no toolset warning) and keeps the CLI exit code", () => {
    const res = spawnSync(process.execPath, [ENTRY, "--help"], {
      encoding: "utf8",
      env: { ...process.env, SCREENCAST_TOOLSETS: "no-such-toolset" },
      timeout: 30_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Usage:");
    expect(res.stderr).not.toContain("SCREENCAST_TOOLSETS");
  });
});
