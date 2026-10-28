/**
 * #128: the MCP Apps review player - the resource, the tool links, the frames
 * it is fed, and the page's protocol. Through a real MCP client over an
 * in-memory transport; player_frames needs ffmpeg. The page's own script runs
 * in jsdom against a fake host (#243).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { defined } from "./testUtils.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JSDOM } from "jsdom";

const home = mkdtempSync(join(tmpdir(), "screencast-player-"));
process.env.SCREENCAST_HOME = home;
const { register: registerReview, playerHtml } = await import("../tools/reviewRecording.js");
const { register: registerStop } = await import("../tools/stopRecording.js");
const {
  buildPlayerFramesArgs, parsePlayerFrameLog, pickPlayerFrames, playerFramePlan, splitJpegs, clientSupportsApps,
  PLAYER_URI, MCP_APP_MIME, MCP_APPS_EXTENSION,
} = await import("../utils/player.js");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const hasFfmpeg = spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
interface FramesMeta { durationSec: number; width: number; frameTimes: number[]; intervalSec: number; sceneFrames: number[] }

describe("player helpers", () => {
  it("plans an even grid of up to 4 frames a second, capped, with a scene-frame gap", () => {
    expect(playerFramePlan(6)).toEqual({ count: 24, intervalSec: 0.25, sceneGapSec: 0.25 });
    expect(playerFramePlan(600)).toEqual({ count: 120, intervalSec: 5, sceneGapSec: 1.25 });
    expect(playerFramePlan(600, 300).count).toBe(300);
    expect(playerFramePlan(0.1).count).toBe(1);
    expect(() => playerFramePlan(0)).toThrow(/no duration/);
  });
  it("reads each frame's real time and kind from the metadata log, keeping the strongest scene frames (#232)", () => {
    const log = [
      "frame:0    pts:0       pts_time:0", "kind=grid",
      "frame:1    pts:1000    pts_time:1.033", "lavfi.scene_score=0.020000", "kind=scene",
      "frame:2    pts:5000    pts_time:5", "kind=grid",
      "frame:3    pts:6000    pts_time:6.5", "lavfi.scene_score=0.400000", "kind=scene",
    ].join("\r\n");
    const frames = parsePlayerFrameLog(log);
    expect(frames).toEqual([
      { timeSec: 0, scene: false, score: 0 },
      { timeSec: 1.033, scene: true, score: 0.02 },
      { timeSec: 5, scene: false, score: 0 },
      { timeSec: 6.5, scene: true, score: 0.4 },
    ]);
    expect(pickPlayerFrames(frames, 5)).toEqual([0, 1, 2, 3]);
    expect(pickPlayerFrames(frames, 1)).toEqual([0, 2, 3]);
    expect(pickPlayerFrames(frames, 0)).toEqual([0, 2]);
  });
  it("builds a grid branch and a scene branch, logging to an escaped path", () => {
    const a = buildPlayerFramesArgs("in.mp4", playerFramePlan(600), 640, "C:/Temp/f.txt");
    const vf = a[a.indexOf("-vf") + 1];
    expect(vf).toContain("floor((t-start_t)/5)");
    expect(vf).toMatch(/gt\(scene.,0\.01\)/);
    expect(vf).toContain("t-prev_selected_t");
    expect(vf).toMatch(/interleave,metadata=print:file=C.+:\/Temp\/f\.txt$/);
  });
  it("detects MCP Apps support from the client's capabilities (#242)", () => {
    expect(clientSupportsApps(undefined)).toBe(false);
    expect(clientSupportsApps({})).toBe(false);
    expect(clientSupportsApps({ extensions: { [MCP_APPS_EXTENSION]: {} } })).toBe(true);
    expect(clientSupportsApps({ extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } })).toBe(true);
    expect(clientSupportsApps({ extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: ["text/x-other"] } } })).toBe(false);
    expect(clientSupportsApps({ experimental: { [MCP_APPS_EXTENSION]: {} } })).toBe(true);
  });
  it("splits concatenated JPEGs at their markers", () => {
    const a = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0x00, 3, 0xff, 0xd9]);
    const b = Buffer.from([0xff, 0xd8, 9, 0xff, 0xd9]);
    const parts = splitJpegs(Buffer.concat([a, b, Buffer.from([0xff, 0xd8, 7])]));
    expect(parts.map((p) => [...p])).toEqual([[...a], [...b]]); // a torn last image is dropped
  });
});

describe("review player as an MCP App (#128)", () => {
  let client: Client;
  beforeAll(async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerReview(server);
    registerStop(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: "c", version: "0" },
      { capabilities: { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } } },
    );
    await Promise.all([server.connect(a), client.connect(b)]);
    await vi.waitFor(async () => {
      expect((await client.listTools()).tools.some((t) => t.name === "player_frames")).toBe(true);
    });
  });
  afterAll(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  const frames = async (input: string, width?: number) => {
    const r = await client.callTool({ name: "player_frames", arguments: { input, width } });
    expect(r.isError).toBeFalsy();
    const content = r.content as Content;
    return { meta: JSON.parse(defined(content[0]?.text)) as FramesMeta, images: content.filter((c) => c.type === "image") };
  };

  it("serves the player as a ui:// resource with the MCP App MIME type", async () => {
    const r = await client.readResource({ uri: PLAYER_URI });
    expect(r.contents[0]).toMatchObject({ uri: PLAYER_URI, mimeType: MCP_APP_MIME });
    expect((r.contents[0] as { text: string }).text).toBe(playerHtml());
    const listed = (await client.listResources()).resources.find((x) => x.uri === PLAYER_URI);
    expect(listed?.mimeType).toBe(MCP_APP_MIME);
  });

  it("links review_recording to it (not stop_recording, #242), and keeps player_frames app-only", async () => {
    const tools = (await client.listTools()).tools;
    const meta = tools.find((t) => t.name === "review_recording")?._meta as Record<string, unknown>;
    expect(meta.ui).toEqual({ resourceUri: PLAYER_URI });
    expect(meta["ui/resourceUri"]).toBe(PLAYER_URI);
    expect(tools.find((t) => t.name === "stop_recording")?._meta).toBeUndefined();
    expect(tools.find((t) => t.name === "player_frames")?._meta).toEqual({ ui: { visibility: ["app"] } });
  });

  it("the page is self-contained ASCII, with player.js inlined, and speaks the spec's methods", () => {
    const html = playerHtml();
    expect([...html].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    expect(html).not.toMatch(/(src|href)=["']https?:/); // hosts' CSP allows no outside origins
    expect(html).not.toContain('src="player.js"'); // #243: the script is inlined, not fetched
    expect(html.match(/<script>/g)).toHaveLength(1);
    for (const m of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-result", "tools/call", "ui/update-model-context", "ui/notifications/size-changed"]) {
      expect(html).toContain(`"${m}"`);
    }
    expect(html).toContain('"2026-01-26"');
    expect(html).toContain('callTool("pipeline"');
  });

  it.skipIf(!hasFfmpeg)("labels each frame with its real pts: the first frame of every grid interval (#232, #243)", async () => {
    const src = join(home, "clip.mp4");
    spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=3:r=30", "-pix_fmt", "yuv420p", src]);
    const { meta, images } = await frames(src, 160);
    expect(meta).toMatchObject({ durationSec: 3, width: 320, height: 180, hasAudio: false, intervalSec: 0.25 });
    expect(images).toHaveLength(meta.frameTimes.length);
    const jpeg = Buffer.from(defined(images[0]?.data), "base64");
    expect([jpeg[0], jpeg[1], jpeg.at(-2), jpeg.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    // Ground truth: every decoded frame's pts, from ffprobe.
    const probe = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", src], { encoding: "utf8" });
    const pts = probe.stdout.trim().split(/\r?\n/).map((l) => parseFloat(l)); // rows can end in a comma
    expect(pts).toHaveLength(90);
    const scene = new Set(meta.sceneFrames);
    const grid = meta.frameTimes.filter((_, i) => !scene.has(i));
    expect(grid).toHaveLength(12); // 3 s at 4 fps
    grid.forEach((t, k) => expect(t).toBeCloseTo(pts.find((p) => p >= k * 0.25 - 1e-6)!, 3));
    for (const t of meta.frameTimes) expect(pts.some((p) => Math.abs(p - t) < 0.0011)).toBe(true);
    expect(meta.frameTimes).toEqual([...meta.frameTimes].sort((a, b) => a - b));
    expect(meta.sceneFrames.length).toBeLessThanOrEqual(12);
    const rv = await client.callTool({ name: "review_recording", arguments: { input: src } });
    expect(JSON.parse(defined((rv.content as Array<{ text: string }>)[0]).text)).toMatchObject({ input: src, durationSec: 3, width: 320 });
  });

  it.skipIf(!hasFfmpeg)("shows a 3 s on-screen change in a 10-minute recording that the 5 s grid misses (#232)", async () => {
    const src = join(home, "long.mp4");
    // Gray for ten minutes at 2 fps, with a white "dialog" from 301 s to 304 s.
    spawnSync(FFMPEG, [
      "-v", "error", "-y", "-f", "lavfi",
      "-i", "color=c=gray:s=160x90:r=2:d=600,drawbox=x=40:y=20:w=80:h=50:c=white:t=fill:enable='between(t,301,304)'",
      "-pix_fmt", "yuv420p", src,
    ]);
    const { meta, images } = await frames(src);
    expect(meta.intervalSec).toBe(5);
    expect(meta.frameTimes.filter((t) => t % 5 === 0)).toHaveLength(120);
    const centre = (i: number) => {
      const f = join(home, `f${i}.jpg`);
      writeFileSync(f, Buffer.from(defined(images[i]?.data), "base64"));
      return spawnSync(FFMPEG, ["-v", "error", "-i", f, "-vf", "format=gray,crop=1:1:80:45", "-f", "rawvideo", "-pix_fmt", "gray", "-"]).stdout[0];
    };
    const shown = meta.frameTimes.findIndex((t) => t >= 301 && t <= 304);
    expect(shown).toBeGreaterThan(0);
    expect(meta.sceneFrames).toContain(shown);
    expect(centre(shown)).toBeGreaterThan(200); // the dialog is in the frame
    expect(centre(meta.frameTimes.indexOf(300))).toBeLessThan(200); // the grid frame before it is not
  });
});

describe("the player page's script in jsdom (#243)", () => {
  // A fake host: answers ui/initialize, sends one tool result, and serves
  // player_frames (11 frames, one at a scene change) and pipeline.
  const times = [0, 1, 2, 3, 4, 4.5, 5, 6, 7, 8, 9];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let dom: JSDOM;
  let $: (id: string) => HTMLElement;

  beforeAll(async () => {
    dom = new JSDOM(playerHtml(), {
      runScripts: "dangerously",
      beforeParse(w) {
        // jsdom's DOMWindow is the page's window at runtime but not lib.dom's Window type.
        const source = w as unknown as Window;
        const reply = (msg: object) =>
          setTimeout(() => w.dispatchEvent(new w.MessageEvent("message", { data: { jsonrpc: "2.0", ...msg }, source })), 0);
        const text = (o: object) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
        w.postMessage = ((m: { id?: number; method: string; params: { name: string; arguments: Record<string, unknown> } }) => {
          if (m.method === "ui/initialize") reply({ id: m.id, result: {} });
          else if (m.method === "ui/notifications/initialized") {
            reply({ method: "ui/notifications/tool-result", params: text({ input: "C:/rec/clip.mp4" }) });
          } else if (m.method === "tools/call") {
            calls.push(m.params);
            if (m.params.name === "player_frames") {
              const r = text({ durationSec: 10, width: 320, height: 180, frameTimes: times, intervalSec: 1, sceneFrames: [5] });
              r.content.push(...times.map(() => ({ type: "image", mimeType: "image/jpeg", data: "AA==" }) as never));
              reply({ id: m.id, result: r });
            } else reply({ id: m.id, result: text({ outputPath: "C:/out/clip-reviewed.mp4" }) });
          } else if (m.id !== undefined) reply({ id: m.id, result: {} });
        }) as typeof w.postMessage;
        (w as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
        w.Element.prototype.setPointerCapture = () => {};
      },
    });
    $ = (id) => dom.window.document.getElementById(id)!;
    await vi.waitFor(() => expect($("seek").hasAttribute("aria-disabled")).toBe(false));
  });
  afterAll(() => dom.window.close());

  const key = (id: string, k: string) =>
    $(id).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const value = (id: string) => $(id).getAttribute("aria-valuetext");

  it("loads the frames at their times and shows the sampling interval", () => {
    expect(calls[0]).toEqual({ name: "player_frames", arguments: { input: "C:/rec/clip.mp4" } });
    expect($("sampling").textContent).toBe("1 frame / 1.0s, +1 at scene changes");
    expect($("ticks").children).toHaveLength(1);
    expect(($("ticks").children[0] as HTMLElement).style.left).toBe("45%");
    expect($("seek").getAttribute("role")).toBe("slider");
    expect(value("seek")).toBe("00:00.0 of 00:10.0");
  });

  it("seeks the playhead with arrows, Page Up/Down, Home and End", () => {
    key("seek", "End");
    expect(value("seek")).toBe("00:09.0 of 00:10.0");
    expect($("seek").getAttribute("aria-valuenow")).toBe("9");
    key("seek", "Home");
    key("seek", "ArrowRight");
    expect(value("seek")).toBe("00:01.0 of 00:10.0");
    key("seek", "PageUp");
    expect(value("seek")).toBe("00:02.0 of 00:10.0");
    key("seek", "ArrowRight");
    key("seek", "ArrowRight");
    key("seek", "ArrowRight");
    expect(value("seek")).toBe("00:04.5 of 00:10.0"); // the scene-change frame
    expect($("tc").textContent).toBe("00:04.5 / 00:10.0");
  });

  it("moves the trim handles from the keyboard and keeps in <= out", () => {
    key("hIn", "ArrowRight");
    key("hIn", "ArrowRight");
    expect($("inT").textContent).toBe("2.0s");
    expect(value("hIn")).toBe("Trim start 00:02.0");
    key("hOut", "Home"); // cannot cross the start: frame 2 ends at 3 s
    expect($("outT").textContent).toBe("3.0s");
    key("hOut", "End");
    key("hOut", "ArrowLeft");
    expect($("outT").textContent).toBe("9.0s");
    expect($("lenT").textContent).toBe("7.0s kept");
    expect(($("apply") as HTMLButtonElement).disabled).toBe(false);
  });

  it("adds redaction boxes from the numeric form, clamped to the video", () => {
    const fill = (x: string, y: string, w: string, h: string) => {
      for (const [id, v] of [["bx", x], ["by", y], ["bw", w], ["bh", h]] as const) ($(id) as HTMLInputElement).value = v;
      ($("boxForm") as HTMLFormElement).requestSubmit();
    };
    expect(($("boxFields") as HTMLFieldSetElement).disabled).toBe(false);
    fill("10", "20", "50", "30");
    fill("300", "170", "100", "100");
    fill("0", "0", "2", "50");
    expect($("status").className).toBe("err");
    fill("400", "0", "10", "10");
    expect($("status").className).toBe("err");
    const items = [...$("boxList").children].map((li) => li.firstChild!.textContent);
    expect(items).toEqual([`#1 50${String.fromCharCode(0xd7)}30 at 10,20`, `#2 20${String.fromCharCode(0xd7)}10 at 300,170`]);
    defined($("boxList").querySelectorAll("button")[1]).click();
    expect($("boxList").children).toHaveLength(1);
    expect(dom.window.document.activeElement).toBe($("boxList").querySelector("button"));
  });

  it("drops a half-drawn box when the pointer is cancelled", () => {
    const stage = $("stage");
    $("draw").click();
    stage.dispatchEvent(new dom.window.MouseEvent("pointerdown", { clientX: 5, clientY: 5, bubbles: true }));
    expect(stage.querySelector(".box.draft")).not.toBeNull();
    stage.dispatchEvent(new dom.window.Event("pointercancel"));
    expect(stage.querySelector(".box.draft")).toBeNull();
    expect($("boxList").children).toHaveLength(1);
  });

  it("exports the boxes and the trim as one pipeline call", async () => {
    $("apply").click();
    await vi.waitFor(() => expect($("status").textContent).toBe("Saved C:/out/clip-reviewed.mp4"));
    expect(calls.at(-1)).toEqual({
      name: "pipeline",
      arguments: {
        input: "C:/rec/clip.mp4",
        steps: [
          { op: "redact", regions: [{ x: 10, y: 20, width: 50, height: 30 }] },
          { op: "trim", start: 2, end: 9 },
        ],
      },
    });
  });
});
