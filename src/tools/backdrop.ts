import { z } from "zod";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse, ScreencastError } from "../utils/errors.js";
import { WRITES_FILE, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg, probeMedia } from "../utils/ffmpeg.js";
import { runEditJob } from "../utils/jobs.js";
import { buildBackdropArgs, BACKDROP_PRESET_NAMES, MAX_BACKDROP_COLORS, type BackdropOptions } from "../utils/backdrop.js";
import { editOutputExt, assertEditContainer } from "../utils/media.js";
import { resolveOutput, subdir, stamp, rand } from "../utils/paths.js";

const STILL = /\.(png|jpe?g|bmp|tiff?|webp)$/i;

/** Backdrop options, undescribed: the pipeline step reuses them as-is (its
 * description points at this tool), which keeps tools/list small (#214). */
export const backdropOptionsSchema = {
  preset: z.enum(BACKDROP_PRESET_NAMES).optional(),
  colors: z.array(z.string()).min(1).max(MAX_BACKDROP_COLORS).optional(),
  image: z.string().min(1).optional(),
  padding: z.number().int().nonnegative().max(2000).optional(),
  radius: z.number().int().nonnegative().max(1000).optional(),
  shadow: z.number().int().nonnegative().max(200).optional(),
  shadowOpacity: z.number().min(0).max(1).optional(),
  aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional(),
};
const o = backdropOptionsSchema;

const inputSchema = {
  input: z.string().min(1).describe("Path to the source video or image (png/jpg)."),
  preset: o.preset.describe("Gradient: desktop (default, dark slate), rec (red), amber, light."),
  colors: o.colors.describe("Instead: 1 color = solid, 2-4 = diagonal gradient."),
  image: o.image.describe("Instead: a wallpaper image, scaled to cover."),
  padding: o.padding.describe("px around the content (default 6% of the longer side)."),
  radius: o.radius.describe("Corner radius px (default ~1.2% of the longer side; 0 = square)."),
  shadow: o.shadow.describe("Shadow blur px (default ~2.5%; 0 = none)."),
  shadowOpacity: o.shadowOpacity.describe("Default 0.5."),
  aspect: o.aspect.describe("Output on this aspect's canvas (1920x1080, ...), content scaled to fit."),
  output: z.string().optional().describe("Optional output path. Defaults under SCREENCAST_HOME/edits (screenshots for an image)."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file at the output path (default false)."),
};

export function register(server: McpServer): void {
  server.registerTool(
    "backdrop",
    {
      title: "Add Backdrop",
      description:
        "Frame a video or screenshot on a gradient, color, or wallpaper with padding, rounded corners, " +
        "and a drop shadow, optionally on a 16:9/1:1/9:16/4:5 canvas.",
      inputSchema,
      outputSchema: looseOutput({ outputPath: z.string(), width: z.number().int(), height: z.number().int() }),
      annotations: WRITES_FILE,
    },
    async (args, extra) => {
      try {
        requireFfmpeg();
        if (!existsSync(args.input)) throw new ScreencastError(`Input file not found: ${args.input}`);
        if (args.image && !existsSync(args.image)) throw new ScreencastError(`Background image not found: ${args.image}`);
        const still = STILL.test(args.input);
        if (still && args.output && !STILL.test(args.output)) {
          throw new ScreencastError("An image input writes an image: give the output a .png or .jpg extension.");
        }
        if (!still) assertEditContainer(args.output);
        const info = await probeMedia(args.input);
        if (!info.width || !info.height) throw new ScreencastError(`Could not read the size of ${args.input}.`);
        const ext = still ? (/\.jpe?g$/i.test(args.input) ? extname(args.input).toLowerCase() : ".png") : editOutputExt(args.input);
        const output = resolveOutput(
          args.output,
          subdir(still ? "screenshots" : "edits"),
          `backdrop-${stamp()}-${rand()}${ext}`,
          args.overwrite,
        );
        const opts: BackdropOptions = {
          preset: args.preset,
          colors: args.colors,
          image: args.image,
          padding: args.padding,
          radius: args.radius,
          shadow: args.shadow,
          shadowOpacity: args.shadowOpacity,
          aspect: args.aspect,
        };
        const { args: ffArgs, layout } = buildBackdropArgs(args.input, output, opts, { width: info.width, height: info.height }, still);
        await runEditJob(ffArgs, { output, durationSec: still ? null : info.durationSec, extra });
        return okResponse({
          outputPath: output,
          width: layout.canvasW,
          height: layout.canvasH,
          content: { x: layout.x, y: layout.y, width: layout.contentW, height: layout.contentH },
          padding: layout.padding,
          radius: layout.radius,
          shadow: layout.shadow,
          background: args.image ? "image" : args.colors ? "colors" : (args.preset ?? "desktop"),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
