import { describe, it, expect } from "vitest";
import { buildRedactArgs } from "../utils/media.js";

const dims = { width: 1920, height: 1080 };

describe("buildRedactArgs box (default)", () => {
  it("draws a solid, filled, irreversible box by default", () => {
    const s = buildRedactArgs("in.mp4", "o.mp4", [
      { x: 100, y: 50, width: 200, height: 40 },
    ]).join(" ");
    expect(s).toContain("drawbox=x=100:y=50:w=200:h=40:color=black:t=fill");
    // t=fill is a solid fill, not an outline; this is the irreversibility guarantee.
    expect(s).toContain("-vf");
    expect(s).toContain("libx264");
    expect(s).toContain("-c:a copy");
  });

  it("chains multiple regions and time-gates them", () => {
    const s = buildRedactArgs("in.mp4", "o.mp4", [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 20, y: 20, width: 10, height: 10, start: 1, end: 3 },
    ]).join(" ");
    expect(s).toContain("drawbox=x=0:y=0:w=10:h=10:color=black:t=fill,drawbox=");
    expect(s).toContain("enable='between(t,1,3)'");
  });

  it("honors a custom fill color", () => {
    const s = buildRedactArgs("in.mp4", "o.mp4", [{ x: 0, y: 0, width: 10, height: 10 }], {
      color: "red",
    }).join(" ");
    expect(s).toContain("color=red");
  });
});

describe("buildRedactArgs safety", () => {
  it("rejects a region that falls outside the frame", () => {
    expect(() =>
      buildRedactArgs("in.mp4", "o.mp4", [{ x: 1900, y: 0, width: 100, height: 40 }], {}, dims),
    ).toThrow(/outside/);
  });

  it("requires at least one region", () => {
    expect(() => buildRedactArgs("in.mp4", "o.mp4", [])).toThrow();
  });

  it("rejects a negative pad", () => {
    expect(() =>
      buildRedactArgs("in.mp4", "o.mp4", [{ x: 0, y: 0, width: 10, height: 10 }], { pad: -1 }),
    ).toThrow();
  });

  it("dilates with pad but clamps to the frame edges", () => {
    const s = buildRedactArgs(
      "in.mp4", "o.mp4",
      [{ x: 5, y: 5, width: 10, height: 10 }],
      { pad: 10 },
      dims,
    ).join(" ");
    // x: max(0, 5-10) = 0; right: 5+10+10 = 25; w = 25-0 = 25.
    expect(s).toContain("drawbox=x=0:y=0:w=25:h=25");
  });
});

describe("buildRedactArgs blur / pixelate", () => {
  it("blur uses a filter_complex with split, boxblur, and an output map", () => {
    const s = buildRedactArgs("in.mp4", "o.mp4", [{ x: 0, y: 0, width: 80, height: 80 }], {
      style: "blur",
    }).join(" ");
    expect(s).toContain("-filter_complex");
    expect(s).toContain("[0:v]split=2[base][s0]");
    expect(s).toContain("boxblur=");
    expect(s).toContain("-map [out]");
    expect(s).toContain("-map 0:a?");
  });

  it("pixelate scales down and back up with neighbor sampling", () => {
    const s = buildRedactArgs("in.mp4", "o.mp4", [{ x: 0, y: 0, width: 80, height: 80 }], {
      style: "pixelate",
    }).join(" ");
    expect(s).toContain("flags=neighbor");
  });
});
