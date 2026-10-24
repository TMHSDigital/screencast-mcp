import { describe, it, expect } from "vitest";
import {
  buildPreviewArgs,
  clampInlineCount,
  DEFAULT_MAX_INLINE_IMAGES,
  MAX_INLINE_IMAGES,
} from "../utils/images.js";
import { okResponse } from "../utils/errors.js";

describe("buildPreviewArgs", () => {
  it("downscales to a width cap and writes one JPEG frame", () => {
    const args = buildPreviewArgs("in.png", "out.jpg", 1280);
    expect(args).toContain("-frames:v");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale='min(1280,iw)':-2");
    expect(args.at(-1)).toBe("out.jpg");
  });
  it("rejects a non-integer or tiny width", () => {
    expect(() => buildPreviewArgs("in.png", "out.jpg", 8)).toThrow(/at least 16/);
    expect(() => buildPreviewArgs("in.png", "out.jpg", 100.5)).toThrow(/integer/);
  });
});

describe("clampInlineCount", () => {
  it("defaults, floors, and clamps to the hard ceiling", () => {
    expect(clampInlineCount(undefined)).toBe(DEFAULT_MAX_INLINE_IMAGES);
    expect(clampInlineCount(3.9)).toBe(3);
    expect(clampInlineCount(-1)).toBe(0);
    expect(clampInlineCount(500)).toBe(MAX_INLINE_IMAGES);
  });
});

describe("okResponse", () => {
  it("puts the JSON text block first and appends image blocks", () => {
    const img = { type: "image" as const, data: "AAAA", mimeType: "image/jpeg" };
    const res = okResponse({ a: 1 }, [img]);
    expect(res.content[0]).toEqual({ type: "text", text: JSON.stringify({ a: 1 }, null, 2) });
    expect(res.content[1]).toEqual(img);
  });
  it("returns a single text block when there are no images", () => {
    expect(okResponse("hi").content).toEqual([{ type: "text", text: "hi" }]);
  });
});
