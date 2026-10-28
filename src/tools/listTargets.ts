import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { getMonitors } from "../utils/monitors.js";
import { getRawWindows } from "../utils/windows.js";
import { wgcAvailable } from "../utils/ffmpeg.js";
import { buildTargetList } from "../utils/targetList.js";

const inputSchema = {
  exe: z
    .string()
    .min(1)
    .optional()
    .describe("Only list windows of this executable, e.g. 'Code.exe' or 'code'."),
  titleContains: z
    .string()
    .min(1)
    .optional()
    .describe("Only list windows whose title contains this text (case-insensitive)."),
  capturableOnly: z
    .boolean()
    .optional()
    .describe("Leave out windows neither backend can capture (minimized, off screen). Default false."),
};

const bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const outputSchema = looseOutput({
  full: z.looseObject({ target: z.literal("full"), bounds }),
  monitors: z.array(
    z.looseObject({
      target: z.string(),
      index: z.number(),
      primary: z.boolean(),
      bounds,
      dpi: z.number().nullable(),
      scale: z.number().nullable(),
    }),
  ),
  windows: z.array(
    z.looseObject({
      target: z.string(),
      title: z.string(),
      exe: z.string().nullable(),
      pid: z.number().nullable(),
      hwnd: z.number().nullable(),
      bounds,
      minimized: z.boolean(),
      cloaked: z.boolean(),
      capturable: z.boolean(),
      wgcCapturable: z.boolean(),
    }),
  ),
  wgcAvailable: z.boolean(),
  note: z.string(),
});

export function register(server: McpServer): void {
  server.registerTool(
    "list_targets",
    {
      title: "List Capture Targets",
      description:
        "List what can be captured: the whole desktop, each monitor (bounds, DPI scale, primary), and each " +
        "visible top-level window (title, exe, pid, hwnd, bounds, minimized, cloaked, and whether the default " +
        "and the wgc backend can capture it), topmost window first. Every entry has a `target` string to pass " +
        "as-is to screenshot, start_recording, find_text, or wait_for_change; windows use window:hwnd=<handle>, " +
        "so the right window is captured even when titles repeat. Call this instead of guessing a window title.",
      inputSchema,
      outputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const [monitors, windows] = await Promise.all([getMonitors(), getRawWindows()]);
        const list = buildTargetList(monitors, windows, {
          wgcAvailable: wgcAvailable(),
          filter: { exe: args.exe, titleContains: args.titleContains, capturableOnly: args.capturableOnly },
        });
        return okResponse({
          ...list,
          note:
            "Pass a target string unchanged. A window handle lasts until the app closes the window; " +
            "list again after an app restarts, or target it by window:exe=<app.exe>. " +
            'A window with capturable false but wgcCapturable true needs backend: "wgc".',
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
