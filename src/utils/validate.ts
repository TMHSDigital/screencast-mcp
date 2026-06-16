/**
 * Validators for string parameters that flow into ffmpeg filtergraphs.
 *
 * Args are passed as discrete spawn array elements (no shell), so this is not a
 * security boundary. The point is a clean, actionable error: a stray colon or a
 * typo'd transition name would otherwise corrupt the filtergraph and surface as
 * a cryptic ffmpeg parse failure. ffmpeg still validates the actual color/value;
 * these only reject input that cannot be a valid token.
 */
import { ScreencastError } from "./errors.js";

/** xfade transition names are lowercase letters only. This is version
 * independent (it does not couple to a specific ffmpeg's transition list) while
 * still catching typos with separators/spaces and filtergraph metacharacters. */
export function validateTransition(name: string): string {
  if (!/^[a-z]+$/.test(name)) {
    throw new ScreencastError(
      `Invalid transition "${name}". Use a lowercase xfade name such as ` +
        `fade, dissolve, wipeleft, wiperight, slideup, or circleopen.`,
    );
  }
  return name;
}

// Characters that would break out of a filtergraph option value.
const COLOR_META = /[:,;=[\]'"\\\s]/;

/** Reject a color containing filtergraph metacharacters or whitespace. Accepts
 * a color name, a hex value (#RRGGBB / #RRGGBBAA), or name@alpha; ffmpeg
 * validates the actual color. */
export function validateColor(value: string, label = "color"): string {
  if (value.length === 0 || COLOR_META.test(value)) {
    throw new ScreencastError(
      `Invalid ${label} "${value}". Use a color name (black, white, red), a hex ` +
        `value (#RRGGBB or #RRGGBBAA), or name@alpha (e.g. white@0.5).`,
    );
  }
  return value;
}
