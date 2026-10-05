// Stryker mutation testing configuration for the Perihelion TypeScript packages.
//
// Stryker is a root devDependency, so `npm ci` is all the setup required.
//
// Run locally (same configs the nightly CI job uses):
//   make mutation-ts                            # both scopes below
//   npx stryker run stryker.sdk.config.mjs      # SDK only
//   npx stryker run stryker.services.config.mjs # relayer + solver only
//   npx stryker run                             # everything in `mutate` below
//
// The per-scope configs import this file and override only `mutate`, the
// test command and the report paths, so thresholds and runner settings live
// in exactly one place.
//
// See: https://stryker-mutator.io/docs/stryker-js/configuration/

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // ─── Runner ─────────────────────────────────────────────────────────────────
  // Invoke each mutant via node:test (same runner as `npm test`).
  testRunner: "command",
  commandRunner: {
    // `--import tsx` resolves tsx's public loader entry rather than a path
    // into its dist/ tree, which moves between tsx releases.
    command: "node --test --import tsx sdk/test/*.test.ts relayer/test/*.test.ts solver/test/*.test.ts",
  },

  // ─── TypeScript checking ────────────────────────────────────────────────────
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.base.json",

  // ─── Mutation scope: highest-risk modules only ───────────────────────────────
  // Focus on codec/hash/verify paths in sdk/src and the relay logic in relayer/src.
  // Exclude type declarations, config glue, and generated dist/ output.
  mutate: [
    // SDK: intent construction, signing, verification, amount validation
    "sdk/src/intent.ts",
    "sdk/src/validate.ts",
    "sdk/src/units.ts",
    "sdk/src/stellar.ts",
    "sdk/src/client.ts",
    // Relayer: cross-chain message delivery logic
    "relayer/src/relayer.ts",
    "relayer/src/soroban-delivery.ts",
    "relayer/src/dead-letter.ts",
    // Solver: quote and executor logic (critical profit/fill paths)
    "solver/src/quote.ts",
    "solver/src/executor.ts",
    // Exclusions: type declarations, index barrels, config glue
    "!sdk/src/types.ts",
    "!sdk/src/errors.ts",
    "!sdk/src/index.ts",
    "!relayer/src/types.ts",
    "!relayer/src/config.ts",
    "!relayer/src/index.ts",
    "!solver/src/config.ts",
    "!solver/src/index.ts",
  ],

  // ─── Thresholds ─────────────────────────────────────────────────────────────
  // `stryker run` exits non-zero when the score drops below `break`, and the
  // nightly workflow fails on that exit code (after uploading its reports).
  // `break` is the recorded baseline: ratchet it up to the latest nightly
  // score as the suite is hardened, never down (docs/mutation-testing.md).
  thresholds: {
    high: 75,   // target score — aim to exceed this
    low:  60,   // warn below this
    break: 50,  // hard-fail CI below this
  },

  // ─── Reporting ──────────────────────────────────────────────────────────────
  reporters: ["html", "json", "clear-text"],
  htmlReporter: {
    fileName: "reports/mutation/index.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },

  // ─── Performance ────────────────────────────────────────────────────────────
  concurrency: 4,
  timeoutMS: 30_000,
  timeoutFactor: 1.5,

  // ─── Incremental mode ───────────────────────────────────────────────────────
  // Cache results across runs so only changed files are re-mutated locally.
  incremental: true,
  incrementalFile: ".stryker-tmp/incremental.json",
};
