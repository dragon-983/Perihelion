# Maintainer notes — Valreb001

## Issue #749 — `parseIntent` accepting a negative/fractional `sourceChainId`

Already fixed on `main`. `sdk/src/validate.ts`'s `parseIntent` validates
`sourceChainId` with `asPositiveInteger(v.sourceChainId, "intent.sourceChainId")`,
the same constraint `validateIntent` in `sdk/src/intent.ts` applies
(`Number.isInteger(...) && > 0`). A negative, zero, or fractional
`sourceChainId` from the mempool is now rejected with a `MempoolResponseError`
naming the field, matching the outbound rule. No change needed.

## Issue #750 — `buildIntent` re-validating fields already checked by `validateIntent`

Already fixed on `main`. `sdk/src/intent.ts`'s `validateIntent` now performs
the checksum-verifying `isStellarAddress`/`isStellarAsset` checks itself
(previously the regex-only `STRKEY_RE`/`DEST_ASSET_RE` shape checks), and
throws `IntentValidationError` with `field: "destination"` /
`field: "destAsset"` for a checksum failure. `buildIntent` no longer
duplicates these checks — the duplicate block has already been removed,
with a comment at its former location referencing issue #526. No bare
`Error` is thrown from either function. No change needed.
