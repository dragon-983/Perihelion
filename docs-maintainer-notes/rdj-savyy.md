# Maintainer notes — rdj-savyy

## #767 — soroban-cli version in differential-fuzz.yml

Already fixed on `main`. `.github/workflows/differential-fuzz.yml` pins
`SOROBAN_CLI_VERSION: "22.0.0"` (matching the `soroban-sdk = "22"` requirement
in `contracts/soroban/Cargo.toml`), installs it via `taiki-e/install-action`
(a prebuilt binary rather than a `cargo install` compile-from-source step),
and includes a step that compares `SDK_MAJOR` against `CLI_MAJOR` and fails
the job on a mismatch. No further change was needed for this issue.
