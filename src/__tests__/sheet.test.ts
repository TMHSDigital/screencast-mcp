import { describe, it, expect } from "vitest";
import {
  evenTimes,
  formatTimecode,
  sheetGrid,
  buildTileArgs,
  buildSheetArgs,
  buildPosterArgs,
} from "../utils/sheet.js";

describe("contact sheet helpers (#115)", () => {
  it("spreads times evenly, each in the middle of its slice", () => {
    expect(evenTimes(30, 4)).toEqual([3.75, 11.25, 18.75, 26.25]);
    expect(evenTimes(1, 3)).toEqual([0.167, 0.5, 0.833]);
    expect(() => evenTimes(0, 3)).toThrow(/duration/);
  });

  it("formats timecodes as m:ss.s, and h:mm:ss from an hour", () => {
    expect(formatTimecode(0)).toBe("0:00.0");
    expect(formatTimecode(75.25)).toBe("1:15.3");
    expect(formatTimecode(3725)).toBe("1:02:05");
  });

  it("lays out one row for up to four tiles, then roughly square", () => {
    expect(sheetGrid(3)).toEqual({ columns: 3, rows: 1 });
    expect(sheetGrid(12)).toEqual({ columns: 4, rows: 3 });
    expect(sheetGrid(5)).toEqual({ columns: 3, rows: 2 });
    expect(sheetGrid(12, 6)).toEqual({ columns: 6, rows: 2 });
    expect(sheetGrid(2, 10)).toEqual({ columns: 2, rows: 1 });
  });

  it("grabs a tile with an accurate seek, a scale, and a label from a file", () => {
    const a = buildTileArgs("in.mp4", 2.5, "t.png", 320, "C:\\f\\Inter.ttf", "C:\\tmp\\l.txt");
    expect(a.slice(a.indexOf("-ss"), a.indexOf("-ss") + 4)).toEqual(["-ss", "2.5", "-i", "in.mp4"]);
    const vf = a[a.indexOf("-vf") + 1];
    expect(vf.startsWith("scale=320:-2,drawtext=")).toBe(true);
    expect(vf).toContain("textfile=C\\\\:/tmp/l.txt");
    expect(() => buildTileArgs("in.mp4", 0, "t.png", 10, "f", "l")).toThrow(/at least 64/);
  });

  it("tiles a numbered sequence into a single frame", () => {
    const a = buildSheetArgs("dir/tile_%03d.png", { columns: 4, rows: 3 }, "sheet.png");
    expect(a[a.indexOf("-vf") + 1]).toBe("tile=4x3:padding=4:margin=4:color=black");
    expect(a.slice(-3)).toEqual(["-frames:v", "1", "sheet.png"]);
  });

  it("samples 30 poster candidates across the whole video", () => {
    const a = buildPosterArgs("in.mp4", 60, "p.png", 1280);
    expect(a[a.indexOf("-vf") + 1]).toBe("fps=0.5000,thumbnail=30,scale='min(1280,iw)':-2");
  });
});
