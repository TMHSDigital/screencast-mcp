import { describe, it, expect } from "vitest";
import { defined } from "./testUtils.js";
import { sumExpr, SUM_GROUP } from "../utils/expr.js";
import { scriptLongFilters, MAX_INLINE_FILTER } from "../utils/ffmpeg.js";
import { existsSync, readFileSync } from "node:fs";

describe("sumExpr (#225)", () => {
  it("joins short sums flat and groups long ones", () => {
    expect(sumExpr([])).toBe("0");
    expect(sumExpr(["a", "b"])).toBe("a+b");
    const terms = Array.from({ length: 120 }, (_, i) => `x${i}`);
    const e = sumExpr(terms);
    expect(e.startsWith("(x0+")).toBe(true);
    expect(e.split("+(").length).toBe(3);
    // No level has more than SUM_GROUP terms.
    const flat = Array.from({ length: SUM_GROUP * SUM_GROUP + 1 }, () => "1");
    const deep = sumExpr(flat);
    expect(new Function(`return ${deep};`)()).toBe(flat.length);
  });
});

describe("scriptLongFilters (#225)", () => {
  it("moves only long filter values to files and cleans them up", () => {
    const long = "null," .repeat(MAX_INLINE_FILTER / 4) + "null";
    const { args, cleanup } = scriptLongFilters(["-i", "in.mp4", "-vf", "scale=2:2", "-filter_complex", long, "o.mp4"]);
    expect(args.slice(0, 4)).toEqual(["-i", "in.mp4", "-vf", "scale=2:2"]);
    expect(args[4]).toBe("-/filter_complex");
    const script = defined(args[5]);
    expect(readFileSync(script, "utf8")).toBe(long);
    expect(args[6]).toBe("o.mp4");
    cleanup();
    expect(existsSync(script)).toBe(false);
  });

  it("leaves short args untouched", () => {
    const a = ["-y", "-i", "x", "-vf", "null", "o"];
    expect(scriptLongFilters(a).args).toEqual(a);
  });
});
