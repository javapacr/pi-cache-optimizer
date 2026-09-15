# Upstream sync protocol

This repo (`javapacr/pi-cache-optimizer`) is a fork of upstream
[`jiangge/pi-cache-optimizer`](https://github.com/jiangge/pi-cache-optimizer),
forked at v2.8.10 (`89ed5b7`, master) with commit `3a288ab` (Trellis
extension drop) already on the branch. Work happens on feature branches only;
`master` is pushed by the orchestrator after review.

## Purpose

Future upstream updates are handled port-style (check-and-port), modeled on
the `sandbox-runtime` / `pi-claude-sandbox` house pattern:

```sh
git fetch upstream
git log <last-synced-upstream-sha>..upstream/master --oneline   # review what's coming
```

Summarize merge-worthiness first, then port onto a fresh branch
`sync/upstream-<ver>`: start from upstream `master`, re-apply the divergence
layers below, run the full gate, and hand the diff to the orchestrator for
review/merge. Prefer porting over merging when conflicts touch the divergence
areas — the divergence layer is thin and localized by design. A conflict
anywhere outside the divergence inventory is a red flag: either upstream
refactored an area we diverge into, or the port went sideways. Resolve by
re-applying the divergence deliberately, never by silently dropping upstream
changes or adding new ones.

## Divergence inventory

### D0 — Trellis project extension dropped (`3a288ab`)

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
- **Toggle resolvers + gates**: `resolveConfigToggle` plus the
  `is*Enabled` resolvers; gate sites — prompt rewrite
  (`before_agent_start`, cache-hints service), skill compression
  (`compressSkillsInSystemPrompt`), prompt-cache-key fallback
  (`shouldInjectOpenAIPromptCacheKey`), compat warnings (the reactive
  `ctx.ui.notify` warning sites — evidence recording stays on), footer stats
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
  during D1 work. Equivalent on Node ≥ 22; keep whichever side on conflict.
- Dead-code removals forced by lint guards: `PersistedCacheStatsV2/V3/V4/V5`
  type aliases, two unused `hitRatio` locals, comments added to two
  `} catch {}` blocks. If upstream restores them, harmless either way.

## Gate

`npm install && npm run check` (typecheck + `node --test` +
`git diff --check` + `npm pack --dry-run`) — all green before any report of
done. Never push `master` from a work session; the orchestrator reviews,
merges, and pushes.
