import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResponse, okResponse } from "../utils/errors.js";
import { requireFfmpeg } from "../utils/ffmpeg.js";
import {
  listDshowAudioDevices,
  pickLoopbackDevice,
  NO_LOOPBACK_HINT,
} from "../utils/audioDevices.js";

export function register(server: McpServer): void {
  server.tool(
    "list_audio_devices",
    "List the DirectShow audio devices ffmpeg can see on this machine, and flag a " +
      "likely system-audio loopback device. Use the returned name as the `audio` " +
      "device for start_recording. System audio needs a loopback device (Stereo " +
      "Mix or a virtual-audio driver); microphone capture is not supported.",
    {},
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
