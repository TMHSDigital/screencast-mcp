/** #125: pipeline planning - fused graph, tracked frame, step rules. */
import { describe, it, expect } from "vitest";
import { planPipeline, type PipelineStep } from "../utils/pipeline.js";

const SRC = { width: 1280, height: 720, fps: 30, durationSec: 20, hasAudio: true };
const plan = (steps: PipelineStep[], src = SRC) => planPipeline("in.mp4", "out.mp4", steps, src);
const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];
const audioCodec = (args: string[]) => args[args.indexOf("-c:a") + 1];

describe("planPipeline", () => {
  it("turns a leading trim into an input seek and chains the rest in one graph", () => {
    const p = plan([
      { op: "trim", start: 2, end: 8 },
      { op: "crop", x: 0, y: 0, width: 640, height: 360 },
      { op: "scale", width: 320 },
    ]);
    expect(p.args.slice(0, 7)).toEqual(["-y", "-ss", "2", "-t", "6", "-i", "in.mp4"]);
    expect(graphOf(p.args)).toBe("[0:v]crop=640:360:0:0[p1];[p1]scale=320:-2[p2]");
    expect(p.args).toContain("[p2]");
    expect([p.width, p.height, p.durationSec]).toEqual([320, 180, 6]);
    expect(audioCodec(p.args)).toBe("aac");
  });

  it("trims later in the chain with trim/atrim, on the timeline as it is at that step", () => {
    const p = plan([{ op: "speed", factor: 2 }, { op: "trim", start: 1, duration: 3 }]);
    const g = graphOf(p.args);
    expect(g).toContain("[0:v]setpts=PTS/2[p0];[p0]trim=start=1:end=4,setpts=PTS-STARTPTS[p1]");
    expect(g).toContain("[0:a]atempo=2,atrim=start=1:end=4,asetpts=PTS-STARTPTS[aout]");
    expect(p.durationSec).toBe(3);
  });

  it("validates each step against the frame it receives", () => {
    expect(() => plan([{ op: "scale", width: 640 }, { op: "crop", x: 400, y: 0, width: 400, height: 300 }])).toThrow(/outside the 640x360 frame/);
    expect(() =>
      plan([{ op: "crop", x: 0, y: 0, width: 400, height: 300 }, { op: "redact", regions: [{ x: 350, y: 0, width: 100, height: 10 }] }]),
    ).toThrow(/outside the 400x300/);
    expect(() => plan([{ op: "trim", start: 30, end: 40 }])).toThrow(/20s long/);
  });

  it("allows export steps only last and sets the encoder from the preset", () => {
    expect(() => plan([{ op: "export_preset", platform: "youtube" }, { op: "scale", width: 640 }])).toThrow(/must be the last step/);
    const p = plan([{ op: "export_preset", platform: "tiktok" }]);
    expect([p.width, p.height, p.fps]).toEqual([1080, 1920, 30]);
    expect(p.args).toContain("-b:v");
    expect(p.args).not.toContain("-crf");
  });

  it("namespaces each step's labels so repeated ops do not collide", () => {
    const p = plan([
      { op: "redact", regions: [{ x: 0, y: 0, width: 10, height: 10 }], style: "blur" },
      { op: "redact", regions: [{ x: 20, y: 20, width: 10, height: 10 }], style: "pixelate" },
    ]);
    const g = graphOf(p.args);
    expect(g).toContain("[p0base]");
    expect(g).toContain("[p1base]");
    expect(p.args[p.args.indexOf("-map") + 1]).toBe("[p1out]");
  });

  it("copies audio untouched when no step changes timing, and handles silent sources", () => {
    const p = plan([{ op: "crop", x: 0, y: 0, width: 640, height: 360 }]);
    expect(p.args).toContain("0:a");
    expect(audioCodec(p.args)).toBe("copy");
    const silent = plan([{ op: "speed", factor: 2 }], { ...SRC, hasAudio: false });
    expect(silent.args).not.toContain("-c:a");
    expect(graphOf(silent.args)).not.toContain("[0:a]");
  });

  it("carries a preset's audio filter and namespaced layout into the graph", () => {
    const steam = plan([{ op: "trim", start: 0, end: 4 }, { op: "export_preset", platform: "steam_trailer" }]);
    expect(graphOf(steam.args)).toContain("[0:a]loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[aout]");
    expect(steam.args).toContain("-x264-params");
    const reel = plan([{ op: "scale", width: 640 }, { op: "export_preset", platform: "vertical_reel" }]);
    const g = graphOf(reel.args);
    expect(g).toContain("[p0]split=2[p1bg][p1fg];");
    expect(g).toContain("[p1b][p1f]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[p1]");
    expect([reel.width, reel.height]).toEqual([1080, 1920]);
  });

  it("an export_gif tail plans a high-quality first stage", () => {
    const p = plan([{ op: "scale", width: 640 }, { op: "export_gif", format: "webp", maxBytes: 3_000_000 }]);
    expect(p.gif).toEqual({ format: "webp", maxBytes: 3_000_000 });
    expect(p.args).toContain("18"); // the "high" CRF
  });
});
