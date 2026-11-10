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
        // Per-file floors for the recording lifecycle, which the aggregate
        // above hides (#302). About 4 points under a local Windows run (Nov
        // 2026: recorder 61.8, lifecycle 81.1, sessions 91.7, events 70.0,
        // tools 81.0); raise them as the lifecycle tests land (#295-#299).
        // src/index.ts and src/wgcRecorder.ts run as child processes and get
        // floors once their tests collect child coverage (#295, #296).
        "src/utils/recorder.ts": { lines: 58 },
        "src/utils/lifecycle.ts": { lines: 77 },
        "src/utils/sessions.ts": { lines: 88 },
        "src/utils/events.ts": { lines: 66 },
        "src/tools/**": { lines: 77 },
      },
    },
  },
});
