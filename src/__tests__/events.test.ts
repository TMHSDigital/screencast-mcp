/** #118: input event log - alignment, coordinate mapping, and selection. */
import { describe, it, expect } from "vitest";
import {
  buildHookScript,
  cleanPsError,
  convertEvents,
  eventPaths,
  formatEventsJsonl,
  parseCaptureStart,
  parseEventsJsonl,
  selectEvents,
  summarizeEvents,
} from "../utils/events.js";
import { captureFrame } from "../utils/targets.js";

const BANNER = `Input #0, gdigrab, from 'desktop':
  Duration: N/A, start: 1792936190.232363, bitrate: 1972 kb/s
  Stream #0:0: Video: bmp, bgra, 64x64, 15 fps, start 1792936190.232363
Input #1, dshow, from 'audio=Stereo Mix':
  Duration: N/A, start: 1792936191.000000, bitrate: 1411 kb/s`;

describe("parseCaptureStart", () => {
  it("reads the first input's wall-clock start in epoch ms", () => {
    expect(parseCaptureStart(BANNER)).toBe(1792936190232);
  });
  it("is null before the banner is printed", () => {
    expect(parseCaptureStart("ffmpeg version 8.0")).toBeNull();
    expect(parseCaptureStart("Input #0, gdigrab, from 'desktop':\n")).toBeNull();
  });
});

describe("convertEvents", () => {
  const frame = { x: 100, y: 50, w: 640, h: 360 };
  const raw = [
    "1000.0,move,90,60,", // before the first frame: dropped
    "1500.4,down,300,250,left",
    "1520.0,up,300,250,left",
    "1600.0,wheel,300,250,v:-2",
    "1700.0,wheel,300,250,h:1",
    "1800.0,key,800,500,",
    "1900.0,key,300,250,Ctrl+S",
    "1950.0,down,300,250,right",
    "9000.0,move,300,250,", // after endSec: dropped
    "1990.0,mo", // torn last line
    "abc,move,1,2,",
  ].join("\n");
  const events = convertEvents(raw, { startMs: 1250, frame, endSec: 5 });

  it("times events from the first frame and drops ones outside the video", () => {
    expect(events.map((e) => e.t)).toEqual([0.25, 0.27, 0.35, 0.45, 0.55, 0.65, 0.7]);
  });
  it("maps desktop pixels to video pixels and flags the off-frame ones", () => {
    expect(events[0]).toMatchObject({ type: "down", button: "left", x: 200, y: 200, inFrame: true });
    expect(events[4]).toMatchObject({ type: "key", x: 700, y: 450, inFrame: false });
    expect(events[4].keys).toBeUndefined();
  });
  it("keeps wheel direction and chords", () => {
    expect(events[2]).toMatchObject({ type: "wheel", axis: "vertical", delta: -2 });
    expect(events[3]).toMatchObject({ axis: "horizontal", delta: 1 });
    expect(events[5].keys).toBe("Ctrl+S");
    expect(events[6].button).toBe("right");
  });
  it("round-trips through JSONL and selects by time, type, and frame", () => {
    const back = parseEventsJsonl(formatEventsJsonl(events) + "{torn");
    expect(back).toEqual(events);
    expect(selectEvents(back, { types: ["down"] }).map((e) => e.t)).toEqual([0.25, 0.7]);
    expect(selectEvents(back, { from: 0.3, to: 0.6 })).toHaveLength(3);
    expect(selectEvents(back, { types: ["key"], inFrameOnly: true })).toHaveLength(1);
    expect(summarizeEvents(back)).toEqual({ clicks: 2, scrolls: 2, keys: 2 });
  });
});

describe("eventPaths", () => {
  it("sits next to the recording", () => {
    expect(eventPaths("C:/rec/rec-1.mp4")).toEqual({ raw: "C:/rec/rec-1.events.raw", jsonl: "C:/rec/rec-1.events.jsonl" });
    expect(eventPaths("C:/a.b/clip").jsonl).toBe("C:/a.b/clip.events.jsonl");
  });
});

describe("hook helper script", () => {
  it("passes the path as base64 and only a 0/1 mode, so nothing is spliced into code", () => {
    const s = buildHookScript("C:/x/it's \"odd\".events.raw", "shortcuts", 4242);
    expect(s).toContain(Buffer.from("C:/x/it's \"odd\".events.raw").toString("base64"));
    expect(s).toContain("[bool]1, 4242)");
    expect(buildHookScript("p", "masked", 1)).toContain("[bool]0, 1)");
    expect(s).not.toMatch(/__PATH__|__MODE__|__PARENT__/);
  });
  it("names keys only inside a Ctrl/Alt/Win chord, never plain typing or AltGr", () => {
    const s = buildHookScript("p", "shortcuts", 1);
    expect(s).toContain("if(sc&&!Down(0xA5))"); // right Alt = AltGr: stay masked
    expect(s).toContain("if((ctl||alt||win)&&nm!=null)");
  });
});

describe("cleanPsError", () => {
  it("pulls the error text out of PowerShell's CLIXML", () => {
    const clixml = '#< CLIXML\n<Objs><S S="Error">Add-Type : boom_x000D__x000A_</S><S S="Error">a &gt; b_x000D__x000A_</S></Objs>';
    expect(cleanPsError(clixml)).toBe("Add-Type : boom\na > b");
    expect(cleanPsError("  plain  ")).toBe("plain");
  });
});

describe("captureFrame", () => {
  const monitors = [
    { index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true },
    { index: 1, x: -1280, y: 0, width: 1280, height: 1025, primary: false },
  ];
  it("is the region, a monitor's bounds, or the virtual desktop, at the encoded size", () => {
    expect(captureFrame({ kind: "region", x: 10, y: 20, w: 301, h: 201 }, [])).toEqual({ x: 10, y: 20, w: 300, h: 200 });
    expect(captureFrame({ kind: "monitor", index: 1 }, monitors)).toEqual({ x: -1280, y: 0, w: 1280, h: 1024 });
    expect(captureFrame({ kind: "full" }, monitors)).toEqual({ x: -1280, y: 0, w: 3200, h: 1080 });
  });
  it("rounds an odd-sized virtual desktop down to the encoded size (#226)", () => {
    const odd = [{ index: 0, x: 0, y: 0, width: 1921, height: 1081, primary: true }];
    expect(captureFrame({ kind: "full" }, odd)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });
});
