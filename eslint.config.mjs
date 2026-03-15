// @ts-check
import tsEsLint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tsEsLint.config(
  // ── Ignored paths ─────────────────────────────────────────────────────────
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "apps/api/drizzle/**",
    ],
  },

  // ── TypeScript base: recommended rules for all .ts/.tsx files ─────────────
  tsEsLint.configs.recommended,

  // ── React base: recommended rules ─────────────────────────────────────────
  {
    settings: {
      react: { version: "19.0" },
    },
  },

  // ── API — Node.js environment ──────────────────────────────────────────────
  {
    files: ["apps/api/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // ── Web — browser + React Hooks ───────────────────────────────────────────
  pluginReact.configs.flat.recommended,
  {
    ...pluginReactHooks.configs['recommended-latest'],
    files: ["apps/web/**/*.{ts,tsx}"],
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // React 17+ automatic JSX transform — no import needed
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/display-name": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // ── Shared packages ────────────────────────────────────────────────────────
  {
    files: ["packages/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ── Scripts ───────────────────────────────────────────────────────────────
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
