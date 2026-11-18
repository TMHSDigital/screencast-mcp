/**
 * The pipeline tool's phases (#368), each on its own: no ffmpeg runs here.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChapters, checkSteps, resolveSecrets, writeSidecars, type PipelineRequest } from "../utils/pipelineRun.js";
import type { PipelinePlan } from "../utils/pipeline.js";
import type { PipelineStepInput } from "../utils/pipelineStep.js";

const dir = mkdtempSync(join(tmpdir(), "sc-pipeline-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const input = join(dir, "in.mp4");
writeFileSync(input, "");

function request(steps: PipelineStepInput[]): PipelineRequest {
  return {
    input,
    info: { durationSec: 20, width: 320, height: 240, fps: 30, audioCodec: null } as PipelineRequest["info"],
    src: { width: 320, height: 240, fps: 30, durationSec: 20, hasAudio: false },
    steps,
    quality: "standard",
    chapters: false,
    output: join(dir, "out.mp4"),
    srtPath: join(dir, "out.srt"),
    gif: false,
    timeoutMs: 1000,
    warnings: [],
  };
}

const box = { x: 1, y: 2, width: 30, height: 20 };

describe("resolveSecrets", () => {
  it("passes a redact with regions through, typed with its regions", async () => {
    const req = request([{ op: "trim", start: 1 }, { op: "redact", regions: [box] }]);
    const steps = await resolveSecrets(req, false);
    expect(steps).toEqual([{ op: "trim", start: 1 }, { op: "redact", regions: [box] }]);
    expect(req.warnings).toEqual([]);
  });

  it("refuses a redact with neither regions nor secrets", async () => {
    await expect(resolveSecrets(request([{ op: "redact" }]), false)).rejects.toThrow("step 1: redact needs regions");
  });

  it("refuses a secret scan after speed or cut_idle (it scans the source's clock)", async () => {
    const req = request([{ op: "speed", factor: 2 }, { op: "redact", secrets: true }]);
    await expect(resolveSecrets(req, true)).rejects.toThrow("step 2: put a redact with secrets before speed and cut_idle");
  });

  it("a dry run skips the scan, warns, and drops a redact that has no regions yet", async () => {
    const req = request([{ op: "redact", secrets: true }, { op: "scale", width: 160 }]);
    const steps = await resolveSecrets(req, true);
    expect(steps).toEqual([{ op: "scale", width: 160 }]);
    expect(req.warnings).toEqual(["Step 1: the secret scan runs when rendering, not in a dry run."]);
  });

  it("nothing is left to render when the only step was such a redact", async () => {
    await expect(resolveSecrets(request([{ op: "redact", secrets: true }]), true)).rejects.toThrow("Nothing to render");
  });

  it("keeps the request's steps as asked (for the edit spec)", async () => {
    const asked: PipelineStepInput[] = [{ op: "redact", secrets: true, regions: [box] }];
    const req = request(asked);
    await resolveSecrets(req, true);
    expect(req.steps).toBe(asked);
    expect(asked[0]).toEqual({ op: "redact", secrets: true, regions: [box] });
  });
});

describe("checkSteps", () => {
  it("refuses a backdrop image that does not exist", () => {
    expect(() => checkSteps([{ op: "backdrop", image: join(dir, "missing.png") }], input)).toThrow("step 1: background image not found");
  });

  it("zoom follow: clicks needs the input's event log", () => {
    expect(() => checkSteps([{ op: "trim", start: 0 }, { op: "zoom", follow: "clicks" }], input)).toThrow("step 2: no event log at");
  });

  it("returns no clicks when no step follows them", () => {
    expect(checkSteps([{ op: "scale", width: 100 }, { op: "zoom", keyframes: [{ t: 1, x: 0, y: 0, width: 100, height: 100 }] }], input)).toEqual({});
  });
});

const plan = (over: Partial<PipelinePlan>): PipelinePlan =>
  ({ args: [], summary: [], pending: [], timeOps: [], files: [], width: 320, height: 240, durationSec: 10, geometry: null, ...over }) as PipelinePlan;

describe("addChapters", () => {
  it("a GIF result keeps the plan and warns: it cannot hold chapters", async () => {
    const req = request([{ op: "export_gif" }]);
    const p = plan({ gif: {} as PipelinePlan["gif"] });
    const r = await addChapters(p, () => {
      throw new Error("must not re-plan");
    }, req, dir, true);
    expect(r).toEqual({ plan: p, chapters: [], markers: [] });
    expect(req.warnings).toEqual(["chapters: a GIF/WebP cannot hold chapters; none written."]);
  });
});

describe("writeSidecars", () => {
  it("writes nothing when there is no transcript, marker or input sidecar", () => {
    const req = request([{ op: "scale", width: 160 }]);
    expect(writeSidecars(req, plan({}), undefined, [])).toEqual({});
    expect(req.warnings).toEqual([]);
  });
});
