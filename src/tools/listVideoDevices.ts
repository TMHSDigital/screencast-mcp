import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import { listDshowVideoDevices } from "../utils/audioDevices.js";

export function register(server: McpServer): void {
  server.registerTool(
    "list_video_devices",
    {
      title: "List Video Devices",
      description: "List DirectShow cameras for start_recording's webcam.device.",
      inputSchema: {},
      outputSchema: looseOutput({ devices: z.array(z.string()) }),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        requireFfmpeg();
        // Re-probe: a camera plugged in since the last call must show up.
        const devices = await listDshowVideoDevices(true);
        return okResponse({
          devices,
          note: devices.length ? `start_recording { webcam: { device: "${devices[0]}" } } records it.` : "No camera found.",
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
