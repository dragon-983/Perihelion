// Stryker scope: SDK codec, validation and unit-conversion paths.
// Shared runner settings and thresholds come from stryker.config.mjs.
//
//   npx stryker run stryker.sdk.config.mjs

import base from "./stryker.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "sdk/src/intent.ts",
    "sdk/src/validate.ts",
    "sdk/src/units.ts",
    "sdk/src/stellar.ts",
  ],
  commandRunner: {
    command: "node --test --import tsx sdk/test/*.test.ts",
  },
  htmlReporter: { fileName: "reports/mutation/sdk/index.html" },
  jsonReporter: { fileName: "reports/mutation/sdk/mutation.json" },
  incrementalFile: ".stryker-tmp/incremental-sdk.json",
};
