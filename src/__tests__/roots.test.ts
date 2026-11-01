/**
 * Output confinement (#221): relative outputs land under SCREENCAST_HOME, and
 * once the allowed set is known (client roots or SCREENCAST_ALLOWED_DIRS) an
 * output outside it is refused - in the helpers and through a real client
 * that advertises roots.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  allowedOutputDirs,
  envAllowedDirs,
  getClientRoots,
  isNetworkPath,
  isWithin,
  resolveOutput,
  resolveOutputDir,
  setClientRoots,
} from "../utils/paths.js";
import { rootDirs } from "../utils/roots.js";
import { assertArgPaths } from "../utils/argPaths.js";

vi.mock("../utils/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/ffmpeg.js")>()),
  requireFfmpeg: () => ({ ffmpeg: "ffmpeg-not-called", ffprobe: "ffprobe-not-called" }),
}));

const base = mkdtempSync(join(tmpdir(), "sc-roots-"));
const home = join(base, "home");
const project = join(base, "project");
const elsewhere = join(base, "elsewhere");
for (const d of [home, project, elsewhere]) mkdirSync(d, { recursive: true });
const savedHome = process.env.SCREENCAST_HOME;
const savedAllowed = process.env.SCREENCAST_ALLOWED_DIRS;

beforeAll(() => {
  process.env.SCREENCAST_HOME = home;
  delete process.env.SCREENCAST_ALLOWED_DIRS;
});
afterEach(() => {
  setClientRoots(null);
  delete process.env.SCREENCAST_ALLOWED_DIRS;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.SCREENCAST_HOME;
  else process.env.SCREENCAST_HOME = savedHome;
  if (savedAllowed !== undefined) process.env.SCREENCAST_ALLOWED_DIRS = savedAllowed;
  rmSync(base, { recursive: true, force: true });
});

describe("relative outputs", () => {
  it("resolve under the tool's default dir, not the cwd", () => {
    const edits = join(home, "edits");
    expect(resolveOutput("clip.mp4", edits, "d.mp4")).toBe(join(edits, "clip.mp4"));
    expect(resolveOutput(join("sub", "clip.mp4"), edits, "d.mp4")).toBe(join(edits, "sub", "clip.mp4"));
    expect(resolveOutputDir("run1", join(home, "frames"))).toBe(join(home, "frames", "run1"));
    expect(resolveOutputDir(undefined, join(home, "frames"))).toBeUndefined();
  });
});

describe("isWithin", () => {
  it("accepts the dir itself and descendants, rejects siblings and parents", () => {
    expect(isWithin(project, project)).toBe(true);
    expect(isWithin(join(project, "a", "b.mp4"), project)).toBe(true);
    expect(isWithin(join(project, "..", "elsewhere", "x.mp4"), project)).toBe(false);
    expect(isWithin(`${project}-evil${"/"}x.mp4`, project)).toBe(false);
    expect(isWithin(base, project)).toBe(false);
  });
  it.runIf(process.platform === "win32")("ignores case on Windows", () => {
    expect(isWithin(join(project.toUpperCase(), "x.mp4"), project)).toBe(true);
  });
});

describe("allowed output dirs", () => {
  it("are unconfined with no client roots and no SCREENCAST_ALLOWED_DIRS", () => {
    expect(allowedOutputDirs()).toBeNull();
    expect(resolveOutput(join(elsewhere, "a.mp4"), home, "d.mp4")).toBe(join(elsewhere, "a.mp4"));
  });
  it("parse SCREENCAST_ALLOWED_DIRS on the path delimiter, skipping blanks", () => {
    expect(envAllowedDirs({ SCREENCAST_ALLOWED_DIRS: ` ${project}${delimiter}${delimiter}${elsewhere} ` })).toEqual([project, elsewhere]);
    expect(envAllowedDirs({})).toEqual([]);
  });
  it("confine to SCREENCAST_HOME plus SCREENCAST_ALLOWED_DIRS when set", () => {
    process.env.SCREENCAST_ALLOWED_DIRS = project;
    expect(allowedOutputDirs()).toEqual([home, project]);
    expect(resolveOutput(join(project, "a.mp4"), home, "d.mp4")).toBe(join(project, "a.mp4"));
    expect(resolveOutput("rel.mp4", join(home, "edits"), "d.mp4")).toBe(join(home, "edits", "rel.mp4"));
    expect(() => resolveOutput(join(elsewhere, "a.mp4"), home, "d.mp4")).toThrow(/outside the allowed directories/);
    expect(() => resolveOutput(join(home, "..", "elsewhere", "a.mp4"), home, "d.mp4")).toThrow(/outside/);
    expect(() => resolveOutputDir(elsewhere, home)).toThrow(/outside/);
  });
  it("confine to the client's roots once known, even an empty list", () => {
    setClientRoots([project]);
    expect(getClientRoots()).toEqual([project]);
    expect(resolveOutput(join(project, "a.mp4"), home, "d.mp4")).toBe(join(project, "a.mp4"));
    expect(() => resolveOutput(join(elsewhere, "a.mp4"), home, "d.mp4")).toThrow(/outside/);
    setClientRoots([]);
    expect(() => resolveOutput(join(project, "a.mp4"), home, "d.mp4")).toThrow(/outside/);
    expect(resolveOutput(join(home, "a.mp4"), home, "d.mp4")).toBe(join(home, "a.mp4"));
  });
  it("hold writes outside SCREENCAST_HOME while the first roots list is pending", () => {
    setClientRoots("pending");
    expect(getClientRoots()).toBeNull();
    expect(() => resolveOutput(join(project, "a.mp4"), home, "d.mp4")).toThrow(/not loaded yet/);
    expect(resolveOutput(join(home, "a.mp4"), home, "d.mp4")).toBe(join(home, "a.mp4"));
  });
});

describe("rootDirs", () => {
  it("keeps file roots as directories and skips other schemes", () => {
    expect(
      rootDirs([{ uri: pathToFileURL(project).href }, { uri: "https://example.com/repo" }, { uri: "file://[bad" }]),
    ).toEqual([project]);
  });
});

describe("client roots over MCP", () => {
  it("reads roots after initialize, refuses outputs outside them, and follows list_changed", async () => {
    const { createServer } = await import("../server.js");
    let roots = [{ uri: pathToFileURL(project).href, name: "project" }];
    const client = new Client({ name: "roots-test", version: "0.0.0" }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      await vi.waitFor(() => expect(getClientRoots()).toEqual([project]));
      const input = join(home, "in.mp4");
      writeFileSync(input, "x");
      const trim = (output: string) =>
        client.callTool({ name: "trim", arguments: { input, start: 0, duration: 1, output } });

      const refused = await trim(join(elsewhere, "out.mp4"));
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/outside the allowed directories/);

      roots = [{ uri: pathToFileURL(elsewhere).href, name: "elsewhere" }];
      await client.sendRootsListChanged();
      await vi.waitFor(() => expect(getClientRoots()).toEqual([elsewhere]));
      const moved = await trim(join(project, "out.mp4"));
      expect(JSON.stringify(moved.content)).toMatch(/outside the allowed directories/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("network and device paths", () => {
  it("are recognised: UNC, forward-slash UNC, WebDAV, \\?\\UNC and \\.\\ forms", () => {
    for (const p of [
      String.raw`\\host\share\a.mp4`,
      "//host/share/a.mp4",
      String.raw`\\host@SSL@443\x\a.mp4`,
      String.raw`\\?\UNC\host\share\a.mp4`,
      String.raw`\\.\pipe\x`,
      String.raw`\/host/x`,
    ]) {
      expect(isNetworkPath(p), p).toBe(true);
    }
    for (const p of [String.raw`C:\a\b.mp4`, String.raw`\\?\C:\long\b.mp4`, String.raw`rel\b.mp4`, "/tmp/b.mp4"]) {
      expect(isNetworkPath(p), p).toBe(false);
    }
  });

  it("are refused as outputs before anything touches them, even when unconfined", () => {
    expect(() => resolveOutput(String.raw`\\host\share\o.mp4`, home, "x.mp4")).toThrow(/network or device path/);
    expect(() => resolveOutputDir("//host/share", home)).toThrow(/network or device path/);
  });

  it("are refused in any path argument, including nested pipeline steps", () => {
    expect(() => assertArgPaths({ input: String.raw`\\host\s\a.mp4` })).toThrow(/network or device path/);
    expect(() => assertArgPaths({ inputs: [String.raw`C:\a.mp4`, "//host/s/b.mp4"] })).toThrow(/network/);
    expect(() => assertArgPaths({ steps: [{ op: "overlay", overlay: String.raw`\\h\s\o.png` }] })).toThrow(/network/);
    expect(() => assertArgPaths({ model: String.raw`\\h\s\ggml.bin` })).toThrow(/network/);
    expect(() => assertArgPaths({ text: "// a code comment" })).not.toThrow();
  });
});

describe("input confinement", () => {
  it("is off with no roots and no SCREENCAST_ALLOWED_DIRS", () => {
    expect(() => assertArgPaths({ input: join(elsewhere, "a.mp4") })).not.toThrow();
  });

  it("follows the allowed dirs once known; tool assets and keywords are exempt", () => {
    setClientRoots([project]);
    expect(() => assertArgPaths({ input: join(project, "a.mp4") })).not.toThrow();
    expect(() => assertArgPaths({ input: join(home, "recordings", "a.mp4") })).not.toThrow();
    expect(() => assertArgPaths({ subtitles: join(elsewhere, "a.srt") })).toThrow(/outside the allowed directories/);
    expect(() => assertArgPaths({ clips: [join(project, "a.mp4"), join(elsewhere, "b.mp4")] })).toThrow(/outside/);
    expect(() => assertArgPaths({ transcript: "whisper", fontFile: join(elsewhere, "f.ttf") })).not.toThrow();
  });
});

describe("overwrite when unconfined", () => {
  it("is refused outside SCREENCAST_HOME and allowed inside it or in an allowed dir", () => {
    const outside = join(elsewhere, "exists.mp4");
    const inside = join(home, "exists.mp4");
    writeFileSync(outside, "x");
    writeFileSync(inside, "x");
    expect(() => resolveOutput(outside, home, "x.mp4", true)).toThrow(/Refusing to replace/);
    expect(resolveOutput(inside, home, "x.mp4", true)).toBe(inside);
    process.env.SCREENCAST_ALLOWED_DIRS = elsewhere;
    expect(resolveOutput(outside, home, "x.mp4", true)).toBe(outside);
  });
});
