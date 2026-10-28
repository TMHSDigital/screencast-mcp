import { describe, it, expect } from "vitest";
import { argAfter } from "./testUtils.js";
import { arrowGeometry, buildArrowImageArgs, buildCalloutArgs } from "../utils/callout.js";

const assets = { fontFile: "C:\\f\\Inter.ttf", textFiles: [] as Array<string | null>, arrowFiles: [] as Array<string | null> };

describe("callout (#121)", () => {
  it("computes an arrow's length, angle (clockwise, screen coords), and centre", () => {
    const g = arrowGeometry({ type: "arrow", x1: 0, y1: 0, x2: 30, y2: 40 });
    expect(g.length).toBe(50);
    expect(g.angle).toBeCloseTo(Math.atan2(40, 30), 6);
    expect([g.cx, g.cy]).toEqual([15, 20]);
    expect(() => arrowGeometry({ type: "arrow", x1: 0, y1: 0, x2: 10, y2: 0, thickness: 8 })).toThrow(/three times/);
  });

  it("renders an arrow as a rotated, transparent shaft-plus-head image", () => {
    const a = buildArrowImageArgs({ type: "arrow", x1: 0, y1: 0, x2: 100, y2: 0, thickness: 6, color: "#00E5FF" }, "a.png");
    expect(a[a.indexOf("-i") + 1]).toBe("color=c=#00E5FF:s=100x18");
    const vf = a[a.indexOf("-vf") + 1];
    expect(vf).toContain("format=rgba,geq=");
    expect(vf).toContain("rotate=a=0.000000:ow=rotw(0.000000):oh=roth(0.000000):c=none");
  });

  it("chains boxes and text with enable windows, and overlays arrows from extra inputs", () => {
    const args = buildCalloutArgs(
      "in.mp4",
      "out.mp4",
      [
        { type: "box", x: 1, y: 2, width: 30, height: 40, from: 1, to: 2, color: "yellow" },
        { type: "text", x: 5, y: 6, text: "hi", from: 3 },
        { type: "arrow", x1: 0, y1: 0, x2: 100, y2: 0, to: 4 },
      ],
      { ...assets, textFiles: [null, "C:\\t\\a.txt", null], arrowFiles: [null, null, "C:\\t\\arrow.png"] },
    );
    expect(args.slice(0, 7)).toEqual(["-y", "-i", "in.mp4", "-loop", "1", "-i", "C:\\t\\arrow.png"]);
    const fc = argAfter(args, "-filter_complex").split(";");
    expect(fc[0]).toBe("[0:v]drawbox=x=1:y=2:w=30:h=40:color=yellow:t=4:enable='between(t,1,2)'[c0]");
    expect(fc[1]).toContain("[c0]drawtext=fontfile=C\\\\:/f/Inter.ttf:textfile=C\\\\:/t/a.txt:expansion=none:");
    expect(fc[1]).toContain(":box=1:boxcolor=black@0.6");
    expect(fc[1]).toMatch(/enable='gte\(t,3\)'\[c1\]$/);
    expect(fc[2]).toBe("[c1][1:v]overlay=x=50.0-w/2:y=0.0-h/2:shortest=1:enable='lte(t,4)'[c2]");
    expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4)).toEqual(["-map", "[c2]", "-map", "0:a?"]);
  });

  it("fills a box on request and validates input", () => {
    const fill = buildCalloutArgs("in.mp4", "o.mp4", [{ type: "box", x: 0, y: 0, width: 5, height: 5, fill: true }], assets);
    expect(fill[fill.indexOf("-filter_complex") + 1]).toContain(":t=fill");
    expect(() => buildCalloutArgs("in.mp4", "o.mp4", [], assets)).toThrow(/at least one/);
    expect(() => buildCalloutArgs("in.mp4", "o.mp4", [{ type: "box", x: -1, y: 0, width: 5, height: 5 }], assets)).toThrow(/non-negative/);
    expect(() => buildCalloutArgs("in.mp4", "o.mp4", [{ type: "box", x: 0, y: 0, width: 5, height: 5, from: 3, to: 2 }], assets)).toThrow(/greater/);
  });

  it("draws each text item with its own fallback font when one is given (#231)", () => {
    const args = buildCalloutArgs(
      "in.mp4",
      "out.mp4",
      [
        { type: "text", x: 0, y: 0, text: "hi" },
        { type: "text", x: 0, y: 50, text: "日本語" },
      ],
      { ...assets, textFiles: ["C:\\t\\a.txt", "C:\\t\\b.txt"], fontFiles: [null, "C:\\Windows\\Fonts\\YuGothB.ttc"] },
    );
    const fc = argAfter(args, "-filter_complex").split(";");
    expect(fc[0]).toContain("drawtext=fontfile=C\\\\:/f/Inter.ttf:");
    expect(fc[1]).toContain("drawtext=fontfile=C\\\\:/Windows/Fonts/YuGothB.ttc:");
  });
});
