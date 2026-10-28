import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { READ_ONLY, looseOutput } from "../utils/toolSpec.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import {
  listDshowAudioDevices,
  pickLoopbackDevice,
  NO_LOOPBACK_HINT,
} from "../utils/audioDevices.js";

export function register(server: McpServer): void {
  server.registerTool(
    "list_audio_devices",
    {
      title: "List Audio Devices",
      description:
        "List DirectShow audio devices and flag a likely loopback (Stereo Mix or a virtual-audio " +
        "driver), for start_recording's audio.device.",
      inputSchema: {},
      outputSchema: looseOutput({
        devices: z.array(z.unknown()),
        loopbackDevice: z.string().nullable(),
        note: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        requireFfmpeg();
        // Always re-probe: this is the explicit "show me what's available" call,
        // so a device enabled since the last recording must show up.
        const devices = await listDshowAudioDevices(true);
        const loopback = pickLoopbackDevice(devices);
        return okResponse({
          devices,
          loopbackDevice: loopback,
          note: loopback
            ? `Pass "${loopback}" as the audio device to capture system audio.`
            : `No loopback device detected. ${NO_LOOPBACK_HINT}`,
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
