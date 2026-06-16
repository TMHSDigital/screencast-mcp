import { describe, it, expect } from "vitest";
import { validateTransition, validateColor } from "../utils/validate.js";

describe("validateTransition", () => {
  it("accepts lowercase xfade names", () => {
    expect(validateTransition("fade")).toBe("fade");
    expect(validateTransition("wipeleft")).toBe("wipeleft");
    expect(validateTransition("circleopen")).toBe("circleopen");
  });
  it("rejects separators, spaces, and filtergraph metacharacters", () => {
    expect(() => validateTransition("wipe-left")).toThrow();
    expect(() => validateTransition("fade ")).toThrow();
    expect(() => validateTransition("fade:drawbox=red")).toThrow();
    expect(() => validateTransition("Fade")).toThrow();
    expect(() => validateTransition("")).toThrow();
  });
});

describe("validateColor", () => {
  it("accepts color names, hex, and name@alpha", () => {
    expect(validateColor("black")).toBe("black");
    expect(validateColor("#1a2b3c")).toBe("#1a2b3c");
    expect(validateColor("#1a2b3cff")).toBe("#1a2b3cff");
    expect(validateColor("white@0.5")).toBe("white@0.5");
  });
  it("rejects values with filtergraph metacharacters", () => {
    expect(() => validateColor("red,drawbox")).toThrow();
    expect(() => validateColor("red:t=fill")).toThrow();
    expect(() => validateColor("black[x]")).toThrow();
    expect(() => validateColor("")).toThrow();
  });
  it("labels the field in the error message", () => {
    expect(() => validateColor("a:b", "fontColor")).toThrow(/fontColor/);
  });
});
