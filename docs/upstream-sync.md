# Upstream sync protocol

This repo (`javapacr/pi-cache-optimizer`) is a fork of upstream
[`jiangge/pi-cache-optimizer`](https://github.com/jiangge/pi-cache-optimizer),
originally forked at v2.8.10 (`89ed5b7`). Work happens on feature branches
only; `master` is never pushed from a work session: a sync lands as one PR on
the fork (never on upstream `jiangge`), merged by the owner under the
[Landing rule](#landing-rule).

## Sync history

| Sync | Upstream base | Ported divergence | Dropped |
| --- | --- | --- | --- |
| Fork | v2.8.10 @ `89ed5b7` | D0 `3a288ab`; D1 `b462d51 50e9b14 6e6b1e6 9faa633 80a996c 140328b` | — |
| 2026-09-26 | v2.8.11 @ `cb05358` | D0 `1336209`; D1 `6cb7dc5 4bc4f08 a6275e8 65f61e6 21e203c a914b72` (same order) | biome format layer `0eb1996` |
| 2026-11-07 | **v2.10.5 @ `2aedbf8`** | D0 `26df22c`; D1′ `a28bc0a 28b94cc` (retention only); docs commit `docs: cache retention modes and upstream sync record` | dropped: the old D1 toggles, flat schema and reject warning |

The last-synced upstream SHA is `2aedbf8`.

The 2026-09-26 chain (`1336209..a914b72`) landed on `master` as the local squash
`2e34e3b`, so its commits stay reachable only through the annotated tag
`archive/sync-2026-09-26` (→ `a914b72`). The owner pushes the tag after merging
the 2026-11-07 PR: `git push origin archive/sync-2026-09-26`.

The 2026-09-26 port dropped `0eb1996` (`chore: biome format`, ±7196 lines in
`index.ts`). It was the only cause of the 7 conflicting `index.ts` hunks in a
straight merge. The repo has no biome config and the pi-lens format hook is
disabled, so the layer is not re-generated and nothing enforces it. Do not
re-format `index.ts` or the tests. At the 2026-09-26 port the divergence stayed
hunk-sized (≈673 changed lines in `index.ts`, the old D1); since 2026-11-07 D1′
touches only a few `index.ts` lines, which keeps future ports conflict-free.

## Purpose

Future upstream updates are handled port-style (check-and-port), modeled on
the `sandbox-runtime` / `pi-claude-sandbox` house pattern:

```sh
git fetch upstream
git log <last-synced-upstream-sha>..upstream/master --oneline   # review what's coming
```

Summarize merge-worthiness first, then port onto a sync branch:

1. Start from upstream `master` (`git reset --hard upstream/master` on a
   branch with no unique commits).
2. Cherry-pick the divergence layers below in inventory order (D0, then D1′),
   then the docs commit, adding a sync-history row with the new D-commit SHAs
   and updating the last-synced upstream SHA.
3. `git fetch origin` and confirm `origin/master` is the SHA the PR will
   fast-forward; if it moved, stop. Tie the history to the fork's `master` so it
   fast-forwards without a force-push: `git merge -s ours origin/master`. The
   `ours` strategy keeps the port's tree unchanged. Verify with
   `git merge-base --is-ancestor origin/master HEAD` and
   `git merge-base --is-ancestor upstream/master HEAD`. Both must exit 0.
4. Check that `git diff upstream/master HEAD --stat` lists only the
   divergence files.
5. Run the full gate and hand the diff to the orchestrator for
   review; the owner merges the PR under the [Landing rule](#landing-rule). Prefer porting over merging when conflicts touch the divergence
areas — the divergence layer is thin and localized by design. A conflict
anywhere outside the divergence inventory is a red flag: either upstream
refactored an area we diverge into, or the port went sideways. Resolve by
re-applying the divergence deliberately, never by silently dropping upstream
changes or adding new ones.

Rebuild rule: `merge -s ours origin/master` is always the last commit. A fix to D0
or D1′ found after the docs commit is folded into its D-commit, not appended:
reset to before the docs commit, amend the D-commit, redo the docs commit with
recomputed SHAs, `git fetch origin`, and redo the merge. The rebuilt feature
branch may be force-pushed with `--force-with-lease`; `master` never.

## Landing rule

Never squash. Land a sync PR with GitHub's "Create a merge commit" or a
fast-forward push by the owner. Never use "Squash and merge", never
"Rebase and merge", and never a local squash: each rewrites the D-commits, breaks
`git merge-base --is-ancestor origin/master HEAD` for the next port, and orphans
the chain. The 2026-09-26 sync was squashed locally into `2e34e3b`; that is why
`archive/sync-2026-09-26` exists. Tie each port with
`merge -s ours origin/master` as its last commit.

## Divergence inventory

### D0 — Trellis project extension dropped (`26df22c`)

`.pi/extensions/trellis` conflicts with pi-subagents (tool-name collision).
If upstream still carries it after a sync, re-drop it. Do not commit
`.trellis/` workspace churn; keep any `AGENTS.md` edits outside the
`TRELLIS:START/END` managed block.
`.pi/settings.json` stays upstream-identical even though it still lists the
deleted extension.

### D1′ — Cache retention mode (`a28bc0a`, `28b94cc`)

One fork setting, `retention` (`long|short|none|startup`), a top-level v3 key next
to upstream's `features`. Precedence: config key > `PI_CACHE_OPTIMIZER_RETENTION`
> default `long`. Absent config and env = byte-identical upstream behavior
(verified by upstream's suite plus `tests/retention-mode.test.ts`).

Touchpoints to re-apply after an upstream port:

- `src/retention.ts`: `RETENTION_ENV`, `CACHE_RETENTION_MODES`,
  `CacheRetentionMode`, `CacheRetentionSource`, `parseCacheRetentionMode`,
  `resolveCacheRetentionMode`, `applyCacheRetentionMode` (pure, no parameter
  defaults); upstream's top-level `requestLongCacheRetention()` call deleted and
  header item 2 reworded.
- `src/config.ts`: V3 `retention?`; `"retention"` in the v3 allow-list; parse drops
  an invalid value alone (Q4); normalize emits `version: features || retention ? 3 : 2`;
  `updatePersistedConfig` (generalizes upstream's `updatePersistedFeatures`);
  `writePersistedRetention`; `applyConfiguredCacheRetention` serving all three
  write sites, and `applyPersistedCacheRetention` (the accessor that `index.ts`
  and `src/command.ts` call, D35); the module-load call right after the persisted
  globals with explicit arguments (TDZ rule: never default-param it to
  `persistedCacheOptimizerConfig`); the `setRuntimeOptimizerEnabled(true)` site;
  `formatCacheRetentionSetting` and its runtime-mode status line.
- `src/prompt-cache-key-config.ts`: the rollback guard also keeps a v3 file that
  has `retention` but no `features`.
- `index.ts`: the `session_start` write site calls `applyPersistedCacheRetention`
  under `isRuntimeOptimizerEnabled()` (D35: never read an imported `export let`
  across modules; pi's jiti loader freezes it).
- `src/command.ts`: the `config retention` branch (live apply through
  `applyPersistedCacheRetention`, only while enabled), the listing line, usage and
  help lines, the menu `Retention` entry after Footer mode, the `doctor` line.
- `src/command-completion.ts`: `retention` after `footer-mode`; mode completion
  from `CACHE_RETENTION_MODES`.
- Tests: `tests/retention-mode.test.ts`; the `config retention` completion
  assertions in `tests/review-findings.test.ts`.
- Docs: README `## Cache retention modes`; this file.
- Not carried since 2026-11-07: the old D1 toggles (`compatWarnings`,
  `footerStats`, `anthropicTtlDowngrade`, `sessionAffinity`, aliases
  `promptCacheKeyFallback`/`deterministicToolOrdering`), the flat v3 schema, a
  legacy flat-key read, and the schema-rejected-config warning. Upstream's
  `features` map covers the overlapping toggles.

## Gate

`npm_config_cache="${TMPDIR:-/tmp}/npm-cache" npm ci && npm run check` (typecheck +
tests + `check:diff` + `check:modules` + `check:pack`), run with a throwaway
`PI_CODING_AGENT_DIR` and without `PI_CACHE_OPTIMIZER_RETENTION`. `check:pack`
needs npm ≤11 on PATH: npm 12 returns `npm pack --json` as an object and
upstream's `scripts/check-pack.mjs` throws (upstream bug, no fork patch).
`check:diff` sees only the working tree, so also run
`git diff --check upstream/master HEAD`. Never push `master` from a work session.
