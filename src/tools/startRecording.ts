import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { getMonitors } from "../utils/monitors.js";
import {
  buildCaptureArgs,
  parseTarget,
  DEFAULT_FPS,
  DEFAULT_QUALITY,
  type Quality,
} from "../utils/targets.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";
import { getStore } from "../context.js";
import type { SessionRecord } from "../utils/sessions.js";

const inputSchema = {
  target: z
    .string()
    .describe(
      "Capture target: 'full' | 'monitor:<index>' (0 = primary) | " +
        "'window:<exact title>' | 'region:<x>,<y>,<w>,<h>' (absolute pixels).",
    ),
  fps: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .describe(`Frames per second (default ${DEFAULT_FPS}).`),
  quality: z
    .enum(["draft", "standard", "high"])
    .optional()
    .describe(`Encoder preset (default ${DEFAULT_QUALITY}).`),
  output: z
    .string()
    .optional()
    .describe(
      "Optional output .mp4 path. Defaults to a file under SCREENCAST_HOME/recordings.",
    ),
};

export function register(server: McpServer): void {
  server.tool(
    "start_recording",
    "Start a screen recording (Windows gdigrab) as a background ffmpeg process. " +
      "Returns a session id and output path. Recording is explicit and never " +
      "auto-starts. Use stop_recording with the id to finalize the file. " +
      "Audio is not captured in Phase 1 (video only).",
    inputSchema,
    async (args) => {
      try {
        const { ffmpeg } = requireFfmpeg();
        const target = parseTarget(args.target);
        const monitors = target.kind === "monitor" ? getMonitors() : [];
        const fps = args.fps ?? DEFAULT_FPS;
        const quality: Quality = (args.quality as Quality) ?? DEFAULT_QUALITY;
        const output = resolveOutput(
          args.output,
          subdir("recordings"),
          `rec-${stamp()}-${rand()}.mp4`,
        );

        const ffArgs = buildCaptureArgs(target, { fps, quality, output, monitors });
        const child = spawn(ffmpeg, ffArgs, {
          stdio: ["pipe", "ignore", "pipe"],
          windowsHide: true,
        });

        // Detect an immediate failure (bad window title, busy device, etc.).
        let stderrTail = "";
        child.stderr?.on("data", (d) => {
          stderrTail = (stderrTail + d.toString()).slice(-2000);
        });
        const settled = await new Promise<"running" | "exited">((resolve) => {
          const timer = setTimeout(() => resolve("running"), 1200);
          child.on("error", (err) => {
            clearTimeout(timer);
            stderrTail += `\n${err.message}`;
            resolve("exited");
          });
          child.on("exit", () => {
            clearTimeout(timer);
            resolve("exited");
          });
        });

        const id = `rec-${stamp()}-${rand(6)}`;
        if (settled === "exited") {
          const tail = stderrTail.trim().split("\n").slice(-6).join("\n");
          throw new ScreencastError(
            `Recording failed to start (ffmpeg exited immediately):\n${tail}`,
          );
        }

        const record: SessionRecord = {
          id,
          target: args.target,
          outputPath: output,
          fps,
          quality,
          pid: child.pid ?? null,
          status: "recording",
          startedAt: new Date().toISOString(),
        };
        const store = getStore();
        store.create(record);
        store.attachChild(id, child);
        // Keep the on-disk record consistent if the child dies on its own.
        child.on("exit", () => {
          const cur = store.get(id);
          if (cur && cur.status === "recording") {
            store.update(id, { status: "stopped", stoppedAt: new Date().toISOString() });
          }
          store.detachChild(id);
        });

        return okResponse({
          sessionId: id,
          status: "recording",
          outputPath: output,
          pid: record.pid,
          fps,
          quality,
          note: "Call stop_recording with this sessionId to finalize the file.",
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
