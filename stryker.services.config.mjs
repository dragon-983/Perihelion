// Stryker scope: relayer delivery and solver quote/execution paths.
// Shared runner settings and thresholds come from stryker.config.mjs.
//
//   npx stryker run stryker.services.config.mjs

import base from "./stryker.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "relayer/src/relayer.ts",
    "relayer/src/soroban-delivery.ts",
    "solver/src/quote.ts",
    "solver/src/executor.ts",
  ],
  commandRunner: {
    command: "node --test --import tsx relayer/test/*.test.ts solver/test/*.test.ts",
  },
  htmlReporter: { fileName: "reports/mutation/services/index.html" },
  jsonReporter: { fileName: "reports/mutation/services/mutation.json" },
  incrementalFile: ".stryker-tmp/incremental-services.json",
};
