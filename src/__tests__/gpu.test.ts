import { describe, it, expect, beforeEach } from "vitest";
import {
  buildDdaInputArgs,
  buildDdaProbeArgs,
  buildEncoderProbeArgs,
  clearGpuProbeCache,
  encoderArgs,
  encoderFits,
  parseDxgiOutputs,
  planDdaSource,
  probeHwEncoders,
  resolveEncoder,
  startWithEncoderFallback,
  type DxgiOutput,
  type EncoderPick,
} from "../utils/gpu.js";
import { buildCaptureArgs, resolveQuality } from "../utils/targets.js";

describe("encoderArgs (#199)", () => {
  it("is libx264's preset for x264", () => {
    expect(encoderArgs("x264", "standard")).toEqual(resolveQuality("standard"));
  });

  it("maps the presets to NVENC constant quality, NV12 from system memory", () => {
    expect(encoderArgs("nvenc", "draft")).toEqual(["-c:v", "h264_nvenc", "-preset", "p1", "-rc", "vbr", "-cq", "30", "-b:v", "0", "-pix_fmt", "nv12"]);
    expect(encoderArgs("nvenc", "high")).toContain("p6");
  });

  it("leaves the pixel format alone for D3D11 frames", () => {
    expect(encoderArgs("nvenc", "standard", { gpuFrames: true })).not.toContain("-pix_fmt");
  });

  it("uses each encoder's own quality options", () => {
    expect(encoderArgs("qsv", "standard")).toEqual(["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "25", "-pix_fmt", "nv12"]);
    expect(encoderArgs("amf", "high")).toEqual(["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "20", "-qp_p", "20", "-pix_fmt", "nv12"]);
  });

  it("builds trial encodes on synthetic frames and on ddagrab", () => {
    const enc = buildEncoderProbeArgs("qsv");
    expect(enc).toContain("color=c=black:s=256x256:r=30");
    expect(enc).toContain("h264_qsv");
    expect(enc.slice(-3)).toEqual(["-f", "null", "-"]);
    expect(buildDdaProbeArgs("nvenc").join(" ")).toMatch(/ddagrab=framerate=10 .*h264_nvenc/);
    expect(buildDdaProbeArgs().join(" ")).toContain("hwdownload,format=bgra");
  });
});

describe("resolveEncoder (#199)", () => {
  beforeEach(() => clearGpuProbeCache());
  const runner = (works: string[]) => async (args: string[]) => works.some((w) => args.join(" ").includes(w));

  it("auto picks the first encoder that passes, and probes once per process", async () => {
    let calls = 0;
    const run = async (args: string[]) => {
      calls++;
      return args.includes("h264_qsv");
    };
    expect(await resolveEncoder("auto", "gdigrab", "ff", run)).toEqual({ encoder: "qsv", gpuFrames: false });
    const first = calls;
    await probeHwEncoders("ff", run);
    expect(calls).toBe(first);
  });

  it("auto falls back to x264 when nothing passes", async () => {
    const pick = await resolveEncoder("auto", "ddagrab", "ff", runner([]));
    expect(pick.encoder).toBe("x264");
    expect(pick.note).toMatch(/libx264/);
  });

  it("x264 never probes", async () => {
    const pick = await resolveEncoder("x264", "ddagrab", "ff", async () => {
      throw new Error("probed");
    });
    expect(pick).toEqual({ encoder: "x264", gpuFrames: false });
  });

  it("an explicit encoder that fails its trial is an error", async () => {
    await expect(resolveEncoder("amf", "gdigrab", "ff", runner(["h264_nvenc"]))).rejects.toThrow(/amf encoder/);
  });

  it("with ddagrab, a second trial decides zero copy", async () => {
    expect(await resolveEncoder("nvenc", "ddagrab", "ff", runner(["h264_nvenc"]))).toEqual({ encoder: "nvenc", gpuFrames: true });
    clearGpuProbeCache();
    const noZeroCopy = async (args: string[]) => args.includes("h264_nvenc") && !args.join(" ").includes("ddagrab");
    expect(await resolveEncoder("nvenc", "ddagrab", "ff", noZeroCopy)).toEqual({ encoder: "nvenc", gpuFrames: false });
  });
});

describe("hardware encoder frame limits (#253)", () => {
  beforeEach(() => clearGpuProbeCache());
  const runner = (works: string[]) => async (args: string[]) => works.some((w) => args.join(" ").includes(w));
  const allWork = runner(["h264_nvenc", "h264_qsv", "h264_amf"]);

  it("knows each encoder's largest frame", () => {
    expect(encoderFits("nvenc", { width: 4096, height: 4096 })).toBe(true);
    expect(encoderFits("nvenc", { width: 5120, height: 1440 })).toBe(false);
    expect(encoderFits("qsv", { width: 3840, height: 2160 })).toBe(true);
    expect(encoderFits("qsv", { width: 4096, height: 2560 })).toBe(false);
    expect(encoderFits("amf", { width: 4097, height: 1080 })).toBe(false);
  });

  it("auto picks libx264 for an oversize frame, and says why", async () => {
    const pick = await resolveEncoder("auto", "ddagrab", "ff", allWork, { width: 5120, height: 1440 });
    expect(pick.encoder).toBe("x264");
    expect(pick.gpuFrames).toBe(false);
    expect(pick.note).toMatch(/5120x1440/);
    expect(pick.note).toMatch(/nvenc: 4096x4096/);
  });

  it("auto skips only the encoders the frame is too big for", async () => {
    const pick = await resolveEncoder("auto", "gdigrab", "ff", runner(["h264_qsv", "h264_nvenc"]), { width: 4096, height: 3000 });
    expect(pick.encoder).toBe("nvenc");
    clearGpuProbeCache();
    const qsvOnly = await resolveEncoder("auto", "gdigrab", "ff", runner(["h264_qsv"]), { width: 4096, height: 3000 });
    expect(qsvOnly.encoder).toBe("x264");
  });

  it("auto keeps a hardware encoder for a frame it takes", async () => {
    expect((await resolveEncoder("auto", "gdigrab", "ff", allWork, { width: 3840, height: 2160 })).encoder).toBe("nvenc");
  });

  it("an explicit encoder that cannot take the frame is an error, before any probe", async () => {
    const run = async () => {
      throw new Error("probed");
    };
    await expect(resolveEncoder("nvenc", "ddagrab", "ff", run, { width: 6016, height: 3384 })).rejects.toThrow(
      /cannot encode a 6016x3384 frame/,
    );
  });
});

describe("startWithEncoderFallback (#253)", () => {
  type Run = { settled: "running" | "exited"; stderr: string };
  const nvenc: EncoderPick = { encoder: "nvenc", gpuFrames: true };

  it("retries once with libx264 when a hardware encoder exits at start, and reports it", async () => {
    const tried: string[] = [];
    let cleared = 0;
    const res = await startWithEncoderFallback<Run>(
      nvenc,
      async (p) => {
        tried.push(p.encoder);
        return p.encoder === "nvenc"
          ? { settled: "exited", stderr: "[h264_nvenc] Frame width 5120 exceeds 4096\nError while opening encoder" }
          : { settled: "running", stderr: "" };
      },
      { why: (r) => r.stderr, beforeRetry: () => cleared++ },
    );
    expect(tried).toEqual(["nvenc", "x264"]);
    expect(cleared).toBe(1);
    expect(res.run.settled).toBe("running");
    expect(res.pick).toMatchObject({ encoder: "x264", gpuFrames: false });
    expect(res.pick.note).toMatch(/nvenc \(h264_nvenc\) encoder exited at start; recording with libx264/);
    expect(res.pick.note).toMatch(/Error while opening encoder/);
    expect(res.failure).toMatch(/exceeds 4096/);
  });

  it("does not retry a capture that started, or one that was already libx264", async () => {
    let calls = 0;
    const running = await startWithEncoderFallback<Run>(nvenc, async () => (calls++, { settled: "running", stderr: "" }), { why: () => "" });
    expect(calls).toBe(1);
    expect(running.pick).toBe(nvenc);
    const x = await startWithEncoderFallback<Run>({ encoder: "x264", gpuFrames: false }, async () => (calls++, { settled: "exited", stderr: "" }), {
      why: () => "",
    });
    expect(calls).toBe(2);
    expect(x.run.settled).toBe("exited");
    expect(x.failure).toBeUndefined();
  });

  it("does not retry when libx264 cannot take the capture either", async () => {
    let calls = 0;
    const res = await startWithEncoderFallback<Run>(nvenc, async () => (calls++, { settled: "exited", stderr: "x" }), {
      why: (r) => r.stderr,
      canFallback: async () => false,
    });
    expect(calls).toBe(1);
    expect(res.pick).toBe(nvenc);
  });

  it("reports both failures when the retry exits too", async () => {
    const res = await startWithEncoderFallback<Run>(nvenc, async () => ({ settled: "exited", stderr: "boom" }), { why: (r) => r.stderr });
    expect(res.run.settled).toBe("exited");
    expect(res.pick.encoder).toBe("x264");
    expect(res.failure).toMatch(/nvenc .*exited at start/);
  });
});

describe("DXGI outputs and ddagrab sources (#199)", () => {
  // Two displays where the DXGI order differs from Screen.AllScreens.
  const outputs: DxgiOutput[] = parseDxgiOutputs(
    "0,0,0,0,1920,1080,\\\\.\\DISPLAY12\r\n0,1,1920,0,1920,1080,\\\\.\\DISPLAY11\r\n1,0,-1280,0,1280,1024,\\\\.\\DISPLAY3\r\ngarbage\n",
  );

  it("parses adapter, output, rectangle, and name", () => {
    expect(outputs).toHaveLength(3);
    expect(outputs[1]).toMatchObject({ adapter: 0, output: 1, x: 1920, y: 0, w: 1920, h: 1080 });
  });

  it("matches a display by geometry, not by monitor order", () => {
    expect(planDdaSource({ x: 1920, y: 0, w: 1920, h: 1080 }, outputs)).toEqual({ output: 1 });
  });

  it("crops a region inside one display, rounded to even", () => {
    expect(planDdaSource({ x: 2000, y: 100, w: 641, h: 481 }, outputs)).toEqual({
      output: 1,
      crop: { x: 80, y: 100, w: 640, h: 480 },
    });
  });

  it("rejects a region spanning displays, and a display on another GPU", () => {
    expect(() => planDdaSource({ x: 1800, y: 0, w: 400, h: 300 }, outputs)).toThrow(/single one/);
    expect(() => planDdaSource({ x: -1280, y: 0, w: 1280, h: 1024 }, outputs)).toThrow(/second GPU/);
  });

  it("builds a lavfi ddagrab input, downloading only when asked", () => {
    expect(buildDdaInputArgs({ output: 1 }, 60, { download: false })).toEqual([
      "-f", "lavfi", "-i", "ddagrab=output_idx=1:framerate=60:draw_mouse=1",
    ]);
    const crop = buildDdaInputArgs({ output: 0, crop: { x: 10, y: 20, w: 640, h: 480 } }, 30, { download: true })[3];
    expect(crop).toBe("ddagrab=output_idx=0:framerate=30:draw_mouse=1:offset_x=10:offset_y=20:video_size=640x480,hwdownload,format=bgra");
  });

  it("honours drawMouse: false (cursor: events, #170)", () => {
    expect(buildDdaInputArgs({ output: 0 }, 30, { download: false, drawMouse: false })[3]).toContain("draw_mouse=0");
  });

  it("slots into buildCaptureArgs in place of gdigrab, with a hardware codec", () => {
    const args = buildCaptureArgs(
      { kind: "full" },
      {
        output: "o.mp4",
        videoInput: buildDdaInputArgs({ output: 0 }, 30, { download: false }),
        videoCodec: encoderArgs("nvenc", "standard", { gpuFrames: true }),
      },
    );
    expect(args).not.toContain("gdigrab");
    expect(args).not.toContain("-vf");
    expect(args).toContain("h264_nvenc");
    expect(args).not.toContain("libx264");
    expect(args.at(-1)).toBe("o.mp4");
  });
});
