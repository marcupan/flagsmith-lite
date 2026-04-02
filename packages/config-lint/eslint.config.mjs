// @ts-check
import tsEsLint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Shared ESLint rules applied to all TypeScript files in the monorepo.
 *
 * Usage in root eslint.config.mjs:
 *   import { base, api, web, shared, scripts } from "@project/config-lint";
 *   export default tsEsLint.config(...base, ...api, ...web, ...shared, ...scripts);
 */

/** Common TypeScript rules reused across API and Web configs */
const tsRules = {
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/consistent-type-imports": [
    "error",
    { prefer: "type-imports", fixStyle: "inline-type-imports" },
  ],
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
};

// ── Base config (ignores + TS recommended) ──────────────────────────────────

export const base = [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "apps/api/drizzle/**"],
  },
  tsEsLint.configs.recommended,
  {
    settings: {
      react: { version: "19.0" },
    },
  },
];

// ── API — Node.js environment ───────────────────────────────────────────────

export const api = [
  {
    files: ["apps/api/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: tsRules,
  },
];

// ── Web — browser + React ───────────────────────────────────────────────────

export const web = [
  pluginReact.configs.flat.recommended,
  {
    ...pluginReactHooks.configs["recommended-latest"],
    files: ["apps/web/**/*.{ts,tsx}"],
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/display-name": "off",
      ...tsRules,
    },
  },
];

// ── Shared packages (packages/*) ────────────────────────────────────────────

export const shared = [
  {
    files: ["packages/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: tsRules,
  },
];

// ── Scripts ─────────────────────────────────────────────────────────────────

export const scripts = [
  {
    files: ["scripts/**/*.{mjs,ts}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
