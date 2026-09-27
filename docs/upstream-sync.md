# Upstream sync protocol

This repo (`javapacr/pi-cache-optimizer`) is a fork of upstream
[`jiangge/pi-cache-optimizer`](https://github.com/jiangge/pi-cache-optimizer),
originally forked at v2.8.10 (`89ed5b7`). Work happens on feature branches
only; `master` is pushed by the orchestrator after review.

## Sync history

| Sync | Upstream base | Ported divergence | Dropped |
| --- | --- | --- | --- |
| Fork | v2.8.10 @ `89ed5b7` | D0 `3a288ab`; D1 `b462d51 50e9b14 6e6b1e6 9faa633 80a996c 140328b` | — |
| 2026-09-26 | **v2.8.11 @ `cb05358`** | D0 `1336209`; D1 `6cb7dc5 4bc4f08 a6275e8 65f61e6 21e203c a914b72` (same order) | biome format layer `0eb1996` |

The last-synced upstream SHA is `cb05358`.

The 2026-09-26 port dropped `0eb1996` (`chore: biome format`, ±7196 lines in
`index.ts`). It was the only cause of the 7 conflicting `index.ts` hunks in a
straight merge. The repo has no biome config and the pi-lens format hook is
disabled, so the layer is not re-generated and nothing enforces it. Do not
re-format `index.ts` or the tests. The divergence against upstream stays
hunk-sized (≈673 changed lines in `index.ts`), which keeps future ports
conflict-free.

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
2. Cherry-pick the divergence layers below in inventory order (D0, then D1).
3. Tie the history to the fork's `master` so it fast-forwards without a
   force-push: `git merge -s ours origin/master`. The `ours` strategy keeps
   the port's tree unchanged. Verify with
   `git merge-base --is-ancestor origin/master HEAD` and
   `git merge-base --is-ancestor upstream/master HEAD`. Both must exit 0.
4. Check that `git diff upstream/master HEAD --stat` lists only the
   divergence files.
5. Run the full gate and hand the diff to the orchestrator for
   review/merge. Prefer porting over merging when conflicts touch the divergence
areas — the divergence layer is thin and localized by design. A conflict
anywhere outside the divergence inventory is a red flag: either upstream
refactored an area we diverge into, or the port went sideways. Resolve by
re-applying the divergence deliberately, never by silently dropping upstream
changes or adding new ones.

## Divergence inventory

### D0 — Trellis project extension dropped (`1336209`)

`.pi/extensions/trellis` conflicts with pi-subagents (tool-name collision).
If upstream still carries it after a sync, re-drop it. Do not commit
`.trellis/` workspace churn; keep any `AGENTS.md` edits outside the
`TRELLIS:START/END` managed block.

### D1 — Configurable optimizations (`feat/configurable-optimizations`)

Every optimization is individually toggleable via the extension config file
(schema v3) and env vars; precedence config key > env var > default.
Absent config + absent env = byte-identical upstream behavior (verified by
the full upstream test suite plus `tests/config-toggles.test.ts`).

Touchpoints to re-apply after an upstream port:

- **Retention machinery** (top of `index.ts`): `CacheRetentionMode` type,
  `parseCacheRetentionMode`, `applyCacheRetentionMode`,
  `resolveCacheRetentionMode` (pure — no module-state reads),
  `resolveEffectiveCacheRetentionMode` (layers the persisted config). The
  module-load call (~line 189, after the env-const block) replaces upstream's
  top-level `requestLongCacheRetention()` and passes an explicit file-read
  retention value — **never** make that a default-param fallback to
  `persistedCacheOptimizerConfig`; the module global is in TDZ at that point
  and an explicit `undefined` argument would evaluate the default and crash.
- **Config schema v3**: `PersistedCacheOptimizerConfigV3`,
  `RuntimeCacheOptimizerConfig`, `CACHE_OPTIMIZER_CONFIG_TOGGLE_KEYS`
  (declared before the startup call for the same TDZ reason),
  v3 branch in `parsePersistedCacheOptimizerConfig`, version-preserving
  `normalizePersistedCacheOptimizerConfig`, `asV3CacheOptimizerConfig`,
  `cacheOptimizerConfigHasV3Keys`, `persistedConfigWriteShape` (oldest-schema
  write), `writePersistedRetention`, v3-aware `writePersistedFooterMode`,
  and v3-key preservation in the prompt-cache-key fix/rollback paths.
  Since v2.8.11, the `/cache-optimizer rollback` handler chooses between
  this config receipt and upstream's models.json receipt, and the models
  receipt can carry `placement: "provider"` (T1, issue #17). Keep upstream's
  provider-placement rollback next to our v3-preserving prompt-cache-key
  rollback. Neither replaces the other.
- **Toggle resolvers + gates**: `resolveConfigToggle` plus the
  `is*Enabled` resolvers; gate sites — prompt rewrite
  (`before_agent_start`, cache-hints service), skill compression
  (`compressSkillsInSystemPrompt`), prompt-cache-key fallback
  (`shouldInjectOpenAIPromptCacheKey`), compat warnings (the reactive
  `ctx.ui.notify` warning sites — evidence recording stays on;
  in `notifyCacheCompatIfNeeded` the `if (!isCompatWarningsEnabled()) return;`
  gate must stay **before** upstream's v2.8.11 `affinityOnly` per-provider
  dedupe key, so `compatWarnings: false` still silences the affinity-only
  warning), footer stats
  (`publishStatus` display gate), tool ordering (`isToolOrderEnabled`),
  Anthropic TTL downgrade (`before_provider_request` repair), session
  affinity (`addEffectiveSessionAffinityHeaders`). The retention write sites
  are: module load, `setRuntimeOptimizerEnabled(true)`, `session_start`.
- **Command surface**: `config retention` subcommand, completion tables
  (`CACHE_OPTIMIZER_RETENTION_MODES`), interactive menu `Retention` entry,
  runtime-mode status lines, `doctor` retention line, help text.
- **Tests**: `tests/config-toggles.test.ts`; one completion assertion in
  `tests/review-findings.test.ts` updated for the `retention` argument.
- **Docs**: README "Configurable optimizations" section; this file.

### Mechanical / lint-driven deltas (accept either side on conflict)

- Biome's `Object.hasOwn` normalization (19 sites) was applied file-wide
  during D1 work and ships inside D1 (`6cb7dc5`), not the dropped format
  layer. Equivalent on Node ≥ 22; keep whichever side on conflict.
- Dead-code removals forced by lint guards: `PersistedCacheStatsV2/V3/V4/V5`
  type aliases, two unused `hitRatio` locals, comments added to two
  `} catch {}` blocks. If upstream restores them, harmless either way.

## Gate

`npm install && npm run check` (typecheck + `node --test` +
`git diff --check` + `npm pack --dry-run`) — all green before any report of
done. Never push `master` from a work session; the orchestrator reviews,
merges, and pushes.
