/**
 * The WGC recorder process (#296), run for real from dist/ with its children
 * faked: a preload swaps child_process.spawn for small Node scripts playing
 * the gfxcapture grab, the encoder and the repaint nudge. Runs on any OS.
 *
 * The fake grab streams yuv420p frames whose bytes all equal the frame's
 * number; the fake encoder checks every frame it receives is uniform (so a
 * frame split at the wrong byte shows up) and reports what it got.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { wgcStopFile, WGC_WINDOW_CLOSED_EXIT } from "../../utils/wgc.js";

const RECORDER = fileURLToPath(new URL("../../../dist/wgcRecorder.js", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HOOK = `
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
const real = cp.spawn;
cp.spawn = (cmd, args = [], opts = {}) => {
  const role = cmd === "powershell" ? "nudge" : args.includes("pipe:0") ? "encoder" : "grab";
  const extra = role === "encoder" ? [args[args.length - 1], args[args.indexOf("-s") + 1]] : [];
  const child = real(process.execPath, [process.env.WGC_FAKE_SCRIPT, role, ...extra], opts);
  appendFileSync(process.env.WGC_FAKE_PIDS, role + " " + child.pid + "\\n");
  return child;
};
syncBuiltinESMExports();
`;

const FAKE = `
const fs = require("node:fs");
const [role, out, size] = process.argv.slice(2);
const sc = process.env.WGC_FAKE_SCENARIO || "normal";
const [W, H] = sc === "slowEncoder" ? [640, 360] : [64, 32];
const FB = (W * H * 3) / 2;
const sizeLine = "Output #0, rawvideo, to 'pipe:':\\n  Stream #0:0: Video: rawvideo (I420 / 0x30323449), yuv420p, " + W + "x" + H + ", q=2-31\\n";
if (role === "nudge") setInterval(() => {}, 1000);
if (role === "grab") {
  if (sc === "failEarly") {
    process.stderr.write("[gfxcapture @ 0] Error: invalid window handle\\n");
    process.exit(1);
  } else if (sc === "silent") {
    setInterval(() => {}, 1000);
  } else {
    let n = 1;
    const frame = () => Buffer.alloc(FB, n++ % 250);
    const stream = () => {
      const t = setInterval(() => {
        if (sc === "closeAfterFrames" && n > 3) { clearInterval(t); process.exit(0); }
        process.stdout.write(frame());
      }, 40);
    };
    if (sc === "sizeAfter") {
      // Part of the first frame, then the size line, then the rest of it.
      const first = frame();
      process.stdout.write(first.subarray(0, 10));
      setTimeout(() => { process.stderr.write(sizeLine); process.stdout.write(first.subarray(10)); stream(); }, 150);
    } else {
      process.stderr.write(sizeLine);
      stream();
    }
  }
}
if (role === "encoder") {
  const [w, h] = size.split("x").map(Number);
  const fb = (w * h * 3) / 2;
  let buf = Buffer.alloc(0), frames = 0, uniform = true;
  const read = (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= fb) {
      const f = buf.subarray(0, fb);
      if (f.some((b) => b !== f[0])) uniform = false;
      frames++;
      buf = buf.subarray(fb);
    }
  };
  if (sc === "slowEncoder") {
    process.stdin.pause();
    setTimeout(() => { process.stdin.on("data", read); process.stdin.resume(); }, 1500);
  } else process.stdin.on("data", read);
  process.stdin.on("end", () => {
    fs.writeFileSync(out, JSON.stringify({ frames, uniform, leftover: buf.length }));
    process.exit(0);
  });
}
`;

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-wgcrec-"));
  writeFileSync(join(dir, "hook.mjs"), HOOK);
  writeFileSync(join(dir, "fake.cjs"), FAKE);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run the recorder against a scenario. */
function run(scenario: string, over: { maxDurationSec?: number; firstFrameTimeoutMs?: number } = {}) {
  const id = ++n;
  const output = join(dir, `out-${id}.mp4`);
  const pids = join(dir, `pids-${id}.txt`);
  writeFileSync(pids, "");
  const cfg = { ffmpeg: "ffmpeg", hwnd: 1, fps: 10, encode: [], output, maxDurationSec: over.maxDurationSec ?? 0, firstFrameTimeoutMs: over.firstFrameTimeoutMs ?? 5_000 };
  const child = spawn(process.execPath, ["--import", pathToFileURL(join(dir, "hook.mjs")).href, RECORDER, JSON.stringify(cfg)], {
    env: { ...process.env, WGC_FAKE_SCRIPT: join(dir, "fake.cjs"), WGC_FAKE_PIDS: pids, WGC_FAKE_SCENARIO: scenario },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const started = async () => {
    for (const t0 = Date.now(); !stderr.includes("start:") && Date.now() - t0 < 10_000; ) await sleep(25);
    expect(stderr, "no start banner").toContain("start:");
  };
  const result = async () => {
    const code = await Promise.race([exited, sleep(20_000).then(() => "hung" as const)]);
    if (code === "hung") child.kill();
    const children = readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map((l) => Number(l.split(" ")[1]));
    // Every child is gone once the recorder exits (#208).
    for (const t0 = Date.now(); children.some(alive) && Date.now() - t0 < 3_000; ) await sleep(50);
    const enc = existsSync(output) ? (JSON.parse(readFileSync(output, "utf8")) as { frames: number; uniform: boolean; leftover: number }) : null;
    return { code, stderr, enc, leftChildren: children.filter(alive), roles: readFileSync(pids, "utf8") };
  };
  return { child, output, started, result };
}

describe.skipIf(!existsSync(RECORDER))("wgc recorder process (#296)", { timeout: 60_000 }, () => {
  it("'q' on stdin finalizes: exit 0, a start banner, about fps x seconds frames", async () => {
    const r = run("normal");
    await r.started();
    await sleep(1000);
    r.child.stdin.write("q");
    const res = await r.result();
    expect(res.code, res.stderr).toBe(0);
    expect(res.enc!.uniform).toBe(true);
    expect(res.enc!.leftover).toBe(0);
    expect(res.enc!.frames).toBeGreaterThanOrEqual(8);
    expect(res.enc!.frames).toBeLessThanOrEqual(16);
    expect(res.roles).toMatch(/grab[\s\S]*nudge|nudge[\s\S]*grab/);
    expect(res.leftChildren).toEqual([]);
  });

  it("closing stdin finalizes the same way", async () => {
    const r = run("normal");
    await r.started();
    await sleep(300);
    r.child.stdin.end();
    const res = await r.result();
    expect(res.code, res.stderr).toBe(0);
    expect(res.enc!.frames).toBeGreaterThan(0);
    expect(res.leftChildren).toEqual([]);
  });

  it("the stop file finalizes, and is removed", async () => {
    const r = run("normal");
    await r.started();
    writeFileSync(wgcStopFile(r.output), "");
    const res = await r.result();
    expect(res.code, res.stderr).toBe(0);
    expect(existsSync(wgcStopFile(r.output))).toBe(false);
    expect(res.leftChildren).toEqual([]);
  });

  it("the window closing after frames ends with WGC_WINDOW_CLOSED_EXIT (#240)", async () => {
    const res = await run("closeAfterFrames").result();
    expect(res.code, res.stderr).toBe(WGC_WINDOW_CLOSED_EXIT);
    expect(res.stderr).toContain("the window closed");
    expect(res.enc!.frames).toBeGreaterThan(0);
    expect(res.leftChildren).toEqual([]);
  });

  it("a grab that fails before any frame exits 1 with the capture error", async () => {
    const res = await run("failEarly").result();
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/capture failed: .*invalid window handle/);
    expect(res.leftChildren).toEqual([]);
  });

  it("no frame within the timeout exits 1", async () => {
    const res = await run("silent", { firstFrameTimeoutMs: 500 }).result();
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("produced no frame in 0.5s");
    expect(res.leftChildren).toEqual([]);
  });

  it("frame bytes that arrive before the size line still split into whole frames", async () => {
    const r = run("sizeAfter");
    await r.started();
    await sleep(500);
    r.child.stdin.write("q");
    const res = await r.result();
    expect(res.code, res.stderr).toBe(0);
    expect(res.enc!.uniform).toBe(true);
    expect(res.enc!.leftover).toBe(0);
  });

  it("drops frames instead of queueing them when the encoder falls behind", async () => {
    const r = run("slowEncoder");
    await r.started();
    await sleep(1200);
    r.child.stdin.write("q");
    const res = await r.result();
    expect(res.code, res.stderr).toBe(0);
    // ~12 frames were due while the encoder read nothing; at most a few
    // queued frames (plus what the pipe holds) reach it.
    expect(res.enc!.frames).toBeLessThan(10);
    expect(res.enc!.uniform).toBe(true);
  });

  it("maxDurationSec ends the recording on its own", async () => {
    const res = await run("normal", { maxDurationSec: 1 }).result();
    expect(res.code, res.stderr).toBe(0);
    expect(res.enc!.frames).toBeGreaterThanOrEqual(8);
    expect(res.leftChildren).toEqual([]);
  });
});
