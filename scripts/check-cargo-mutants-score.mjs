#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Mutation-score gate for cargo-mutants.
//
// cargo-mutants exits non-zero on *any* surviving mutant, which would make the
// nightly job permanently red until every survivor is killed. Instead this
// script reads mutants.out/outcomes.json and fails only when the score drops
// below the recorded baseline, so the gate ratchets rather than demanding a
// large test-writing effort up front (the same approach .codecov.yml takes).
//
// Usage:
//   node scripts/check-cargo-mutants-score.mjs [path/to/mutants.out] [--min N]
//
// Score = (caught + timeout) / (caught + timeout + missed). Unviable mutants
// (ones that do not compile) are excluded, matching Stryker's definition.

import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// Recorded baseline for contracts/soroban/settlement. Raise it to the latest
// nightly score as the suite is hardened; never lower it to get a run green.
const BASELINE_MIN_SCORE = 60;

const args = process.argv.slice(2);
let dir = "contracts/soroban/settlement/mutants.out";
let min = BASELINE_MIN_SCORE;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--min") min = Number(args[++i]);
  else dir = args[i];
}
if (!Number.isFinite(min)) {
  console.error("--min must be a number");
  process.exit(2);
}

let data;
try {
  data = JSON.parse(readFileSync(join(dir, "outcomes.json"), "utf8"));
} catch (err) {
  console.error(`cannot read ${join(dir, "outcomes.json")}: ${err.message}`);
  process.exit(1);
}

// cargo-mutants records per-run totals at the top level; fall back to
// counting per-outcome summaries if they are absent.
const count = (key, summary) =>
  typeof data[key] === "number"
    ? data[key]
    : (data.outcomes ?? []).filter((o) => o.summary === summary).length;

const caught = count("caught", "CaughtMutant");
const missed = count("missed", "MissedMutant");
const timeout = count("timeout", "Timeout");
const unviable = count("unviable", "Unviable");
const scored = caught + missed + timeout;

if (scored === 0) {
  console.error("no viable mutants were tested — treating as failure");
  process.exit(1);
}

const score = Math.round(((caught + timeout) / scored) * 1000) / 10;
const line =
  `cargo-mutants: caught ${caught}, missed ${missed}, timeout ${timeout}, ` +
  `unviable ${unviable} — score ${score}% (baseline ${min}%)`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (score < min) {
  console.error(`mutation score ${score}% is below the recorded baseline ${min}%`);
  process.exit(1);
}
