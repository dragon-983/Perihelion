// ESLint flat config for the TypeScript workspaces (sdk, solver, relayer, mempool).
//
// NOTE: `eslint`, `typescript-eslint`, and `eslint-config-prettier` are not yet
// declared as devDependencies in the root `package.json` — adding them there
// (and regenerating `package-lock.json`) is left as a follow-up so this change
// stays additive and does not conflict with in-flight dependency work. Once
// installed, wire `"lint": "eslint ."` (keeping the existing `tsc --noEmit`
// check as a separate `"typecheck"` script) into each workspace's
// `package.json`.
//
// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.config.*",
      "contracts/**",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
