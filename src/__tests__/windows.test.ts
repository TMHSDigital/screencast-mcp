import { describe, it, expect } from "vitest";
import { selectWindow, windowMatchReport, MAX_CANDIDATES, type WindowQuery } from "../utils/windows.js";

// A 3840x1080 dual-monitor virtual desktop (two 1920x1080; second at x=1920).
const VIRTUAL = { x: 0, y: 0, w: 3840, h: 1080 };

function q(windows: WindowQuery["windows"]): WindowQuery {
  return { virtual: VIRTUAL, windows };
}

describe("selectWindow", () => {
  it("prefers an exact (case-insensitive) title match over a substring", () => {
    const r = selectWindow(
      q([
        { title: "Notepad - readme.txt", left: 0, top: 0, right: 800, bottom: 600, minimized: false },
        { title: "Notepad", left: 100, top: 100, right: 500, bottom: 400, minimized: false },
      ]),
      "notepad",
    );
    expect(r.matchedTitle).toBe("Notepad");
    expect(r.x).toBe(100);
    expect(r.width).toBe(400);
    expect(r.height).toBe(300);
  });

  it("falls back to a substring match when there is no exact match", () => {
    const r = selectWindow(
      q([
        { title: "Demo - Google Chrome", left: 10, top: 20, right: 1010, bottom: 620, minimized: false },
      ]),
      "Chrome",
    );
    expect(r.matchedTitle).toBe("Demo - Google Chrome");
    expect(r.x).toBe(10);
    expect(r.width).toBe(1000);
  });

  it("chooses the topmost (first in Z-order) when several match", () => {
    const r = selectWindow(
      q([
        { title: "Editor A", left: 0, top: 0, right: 200, bottom: 200, minimized: false },
        { title: "Editor B", left: 300, top: 0, right: 600, bottom: 200, minimized: false },
      ]),
      "Editor",
    );
    expect(r.matchedTitle).toBe("Editor A");
    expect(r.matchCount).toBe(2);
  });

  it("resolves a window on the second monitor with its large x offset", () => {
    const r = selectWindow(
      q([
        { title: "Game", left: 1920, top: 0, right: 3840, bottom: 1080, minimized: false },
      ]),
      "Game",
    );
    expect(r.x).toBe(1920);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(1080);
  });

  it("clamps a window that overhangs the virtual desktop edge", () => {
    const r = selectWindow(
      q([
        { title: "Wide", left: -8, top: -8, right: 3848, bottom: 1088, minimized: false },
      ]),
      "Wide",
    );
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBe(3840);
    expect(r.height).toBe(1080);
  });

  it("rounds dimensions down to even values for yuv420p", () => {
    const r = selectWindow(
      q([
        { title: "Odd", left: 0, top: 0, right: 401, bottom: 301, minimized: false },
      ]),
      "Odd",
    );
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
    expect(r.width).toBe(400);
    expect(r.height).toBe(300);
  });

  it("throws when nothing matches the requested title", () => {
    expect(() =>
      selectWindow(
        q([{ title: "Something Else", left: 0, top: 0, right: 100, bottom: 100, minimized: false }]),
        "Nonexistent",
      ),
    ).toThrow(/No visible window/);
  });

  it("throws a clear error when the only match is minimized", () => {
    expect(() =>
      selectWindow(
        q([{ title: "Notepad", left: -32000, top: -32000, right: -31840, bottom: -31972, minimized: true }]),
        "Notepad",
      ),
    ).toThrow(/minimized/i);
  });
});

describe("window match reporting (#89)", () => {
  const W = (title: string, left = 0) => ({ title, left, top: 0, right: left + 200, bottom: 200, minimized: false });

  it("reports an exact single match without a warning", () => {
    const r = selectWindow(q([W("Code"), W("Visual Studio Code", 300)]), "code");
    expect(r.matchKind).toBe("exact");
    const report = windowMatchReport(r);
    expect(report.matchedWindow).toBe("Code");
    expect(report.region).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(report.windowWarning).toBeUndefined();
  });

  it("warns on a substring match and lists the candidates", () => {
    const r = selectWindow(q([W("1Password - Vault"), W("Pass the salt", 300)]), "pass");
    expect(r.matchKind).toBe("substring");
    expect(r.candidates).toEqual(["1Password - Vault", "Pass the salt"]);
    const warning = String(windowMatchReport(r).windowWarning);
    expect(warning).toMatch(/substring/);
    expect(warning).toMatch(/2 windows matched/);
    expect(warning).toContain('"1Password - Vault"');
  });

  it("exactOnly refuses the substring fallback and names the near misses", () => {
    expect(() => selectWindow(q([W("Demo - Google Chrome")]), "Chrome", { exactOnly: true })).toThrow(
      /titled exactly "Chrome".*"Demo - Google Chrome"/,
    );
    const r = selectWindow(q([W("Chrome"), W("Demo - Google Chrome", 300)]), "chrome", { exactOnly: true });
    expect(r.matchedTitle).toBe("Chrome");
  });

  it("caps the candidate list", () => {
    const many = Array.from({ length: 9 }, (_, i) => W(`Editor ${i}`, i * 210));
    const r = selectWindow({ virtual: { x: 0, y: 0, w: 4000, h: 1080 }, windows: many }, "Editor");
    expect(r.matchCount).toBe(9);
    expect(r.candidates).toHaveLength(MAX_CANDIDATES);
  });
});
