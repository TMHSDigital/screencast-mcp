/** #287: the five edit tools that encode H.264/AAC must refuse a .webm or .gif
 * output with the #187 message, not a raw ffmpeg muxer error. */
import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register as registerXfade } from "../tools/xfadeTransition.js";
import { register as registerAssemble } from "../tools/assembleHighlights.js";
import { register as registerTitleCard } from "../tools/titleCard.js";
import { register as registerExportPreset } from "../tools/exportPreset.js";
import { register as registerPipeline } from "../tools/pipeline.js";

// The guard runs before any media is read; only the availability probe has to go.
vi.mock("../utils/ffmpeg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/ffmpeg.js")>();
  return {
    ...actual,
    requireFfmpeg: () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }) as never,
    // pipeline probes before it knows the final container.
    probeMedia: async () => ({ width: 640, height: 480, fps: 30, durationSec: 1, audioCodec: null }),
  };
});

type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>;

function handlersOf(register: (server: McpServer) => void): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const fake = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  };
  register(fake as unknown as McpServer);
  return handlers;
}

// An input that exists, so the file check passes and the container guard runs.
const INPUT = "package.json";

interface Case {
  tool: string;
  register: (server: McpServer) => void;
  args: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    tool: "xfade_transition",
    register: registerXfade,
    args: { inputA: INPUT, inputB: INPUT, output: "out.webm" },
  },
  {
    tool: "assemble_highlights",
    register: registerAssemble,
    args: { clips: [INPUT], output: "out.webm" },
  },
  {
    tool: "title_card",
    register: registerTitleCard,
    args: { text: "hi", output: "out.webm" },
  },
  {
    tool: "export_preset",
    register: registerExportPreset,
    args: { input: INPUT, platform: "youtube", output: "out.gif" },
  },
  {
    tool: "pipeline",
    register: registerPipeline,
    args: { input: INPUT, steps: [{ op: "trim", start: 0, end: 1 }], output: "out.webm" },
  },
];

describe("edit tools refuse a container that cannot hold H.264/AAC (#287)", () => {
  for (const c of CASES) {
    it(`${c.tool} rejects .webm/.gif with the #187 message`, async () => {
      const handler = handlersOf(c.register)[c.tool];
      if (!handler) throw new Error(`${c.tool} is not registered`);
      const result = (await handler(c.args)) as { isError?: boolean; content?: { text?: string }[] };
      const text = result.content?.map((part) => part.text ?? "").join("\n") ?? "";
      expect(result.isError, text).toBe(true);
      expect(text).toContain("cannot hold");
    });
  }
});
