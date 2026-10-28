---
name: verify-ui
description: Check a UI change on the real Windows screen instead of assuming it worked - screenshot before, trigger the change, wait for the screen to settle, diff before and after, and read the text with OCR. Use after changing UI code in a desktop app (Electron, WPF, WinUI, WinForms, a game) or when the user asks to verify, confirm, or look at what the app shows.
---

# Verify a UI change with screencast

Use the screencast MCP tools to look at the screen the way a person would. No guessed `sleep`, and no full-size image on every poll.

## The loop

1. **Find the window.** `list_targets { "titleContains": "<app>" }`; reuse its `target` string (e.g. `window:hwnd=0x1A2B`) for every call below.
2. **Before.** `screenshot { "target": "<target>" }`. It comes back inline; note the path.
3. **Trigger the change** (rebuild, click, run the command).
4. **Wait, don't sleep.**
   - `wait_for_change { "target": "<target>", "mode": "change", "timeoutSec": 10 }` returns as soon as anything changes, with where.
   - `wait_for_change { "target": "<target>", "mode": "settle", "settleSec": 0.75, "timeoutSec": 20 }` returns once the screen has been still, e.g. after an animation or a build finishes.
   - A timeout is a result (`outcome: "timeout"`), not an error: report it.
5. **After.** `screenshot { "target": "<target>" }`.
6. **Diff.** `screen_diff { "a": "<before.png>", "b": "<after.png>" }` gives SSIM, the share changed, and boxes around each changed area. Changes outside the area you touched are a regression signal; `identical: true` proves nothing changed.
7. **Read it.** `find_text { "input": "<after.png>", "query": "Saved" }` confirms the text, not just that pixels moved. Without `query` it returns all the text with boxes.

## Tips

- Covered or off-screen window: pass `backend: "wgc"` to `screenshot` and `find_text` (FFmpeg 8+) to capture the window itself.
- To keep evidence of the run, wrap it in `start_recording` / `stop_recording` and finish with `contact_sheet` on the recording.
- For CI (no agent in the loop), the package's CLI records a test run: `npx -y @tmhs/screencast-mcp record --target full -- npm test` writes a GIF and contact sheet when the command fails.
- If a capture fails, run `doctor`.
