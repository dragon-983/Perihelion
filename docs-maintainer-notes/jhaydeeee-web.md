# Maintainer notes (jhaydeeee-web)

## #752 — sdk: `PerihelionEscrowClient.getLock` swallows every error

Already fixed on `main`. `sdk/src/escrow-client.ts`'s `getLock` no longer wraps
the `readContract` call in a `try`/`catch`; RPC and decode failures now
propagate. Absence of a lock is now determined by checking
`lock.user === zeroAddress` (using viem's `zeroAddress`) rather than by
catching an exception, matching the on-chain `NotLocked()` guard semantics
the issue asked for. The method's doc-comment documents the distinction.
No further changes needed for this issue.

## #754 — sdk: `listPending` discards `nextCursor`

Already fixed on `main`. `sdk/src/client.ts` now exposes `listPendingPage`
(single page with `limit`/`cursor`, returns `nextCursor`), `listPendingPages`
(an async generator that walks pages), and `listPending` (accumulates all
pages via the cursor, bounded by a `maxPages` guard, default 100, to avoid
looping forever against a misbehaving server). Every page request passes an
explicit `limit` rather than relying on the server default. No further
changes needed for this issue.
