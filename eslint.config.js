// Flat ESLint config (ESM). A pragmatic ruleset matching the existing style:
// typescript-eslint recommended (non-type-checked, so it is fast and needs no
// project service), with unused-vars allowing an underscore-prefix opt-out.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // assets/ holds fonts and the player page; its one script is linted below.
    ignores: ["dist/**", "node_modules/**", "assets/**/*", "!assets/ui/", "!assets/ui/player.js", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Plain-JS build scripts run under Node.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
  {
    // The docs site's script runs in the browser.
    files: ["docs/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        window: "readonly", document: "readonly", navigator: "readonly", location: "readonly",
        history: "readonly", performance: "readonly", requestAnimationFrame: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        IntersectionObserver: "readonly", scrollY: "readonly", innerHeight: "readonly", addEventListener: "readonly",
      },
    },
  },
  {
    // The review player's script runs in the host's sandboxed iframe (#243).
    files: ["assets/ui/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        window: "readonly", document: "readonly", ResizeObserver: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly",
      },
    },
  },
);
