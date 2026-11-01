import { defineConfig } from "vitest/config";

// Only coverage is configured here; test discovery keeps vitest's defaults.
// `npm run test:coverage` turns it on (CI runs it on the Windows Node 22 leg
// and writes the summary to the job page, #261).
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
      // Still write the summary when a test fails, so CI shows it either way.
      reportOnFailure: true,
      thresholds: {
        // A floor under the measured line coverage of the helpers (94% on a
        // Windows dev box with OCR and speech, Oct 2026), with room for a
        // runner that skips those engines; raise it as coverage grows (#261).
        "src/utils/**": { lines: 90 },
      },
    },
  },
});
