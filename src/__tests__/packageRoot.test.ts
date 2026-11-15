import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetPath, findPackageRoot, packageRoot, packageVersion, PACKAGE_NAME } from "../utils/packageRoot.js";

const dir = mkdtempSync(join(tmpdir(), "screencast-pkgroot-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("package root (#265)", () => {
  it("finds this package from src/ and reads its version and assets", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { name: string; version: string };
    expect(pkg.name).toBe(PACKAGE_NAME);
    expect(packageVersion()).toBe(pkg.version);
    expect(existsSync(assetPath("fonts", "Inter-Bold.ttf"))).toBe(true);
  });

  it("walks up past other packages' package.json to this one", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "9.9.9" }));
    const nested = join(dir, "node_modules", "other");
    mkdirSync(join(nested, "dist"), { recursive: true });
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "other" }));
    expect(findPackageRoot(join(nested, "dist"))).toBe(dir);
  });

  it("returns null when no package.json names this package", () => {
    const lone = mkdtempSync(join(tmpdir(), "screencast-pkgroot-none-"));
    try {
      expect(findPackageRoot(lone)).toBeNull();
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  });
});
