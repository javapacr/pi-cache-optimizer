import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __internals_for_tests as internals } from "#extension";

const {
  parsePersistedCacheOptimizerConfig,
  readPersistedCacheOptimizerConfig,
  writePersistedRetention,
  writePersistedFooterMode,
  persistedConfigWriteShape,
  asV3CacheOptimizerConfig,
  resolveCacheRetentionMode,
  resolveEffectiveCacheRetentionMode,
  applyCacheRetentionMode,
  requestLongCacheRetention,
  resolveConfigToggle,
  setPersistedCacheOptimizerConfig,
  setRuntimeOptimizerEnabled,
  applyPromptCacheKeyConfigFix,
  rollbackPromptCacheKeyConfig,
  readPromptCacheKeyConfigReceiptSnapshot,
  isToolOrderEnabled,
  isPromptRewriteEnabled,
  isSkillCompressionEnabled,
  isPromptCacheKeyFallbackEnabled,
  isCompatWarningsEnabled,
  isFooterStatsEnabled,
  isAnthropicTtlDowngradeEnabled,
  isSessionAffinityToggleEnabled,
  getOrCaptureCacheRetentionBaseline,
  RETENTION_ENV,
  NO_PROMPT_REWRITE_ENV,
  NO_SKILL_COMPRESSION_ENV,
  NO_OPENAI_CACHE_KEY_ENV,
  NO_COMPAT_WARNINGS_ENV,
  NO_FOOTER_STATS_ENV,
  NO_ANTHROPIC_TTL_DOWNGRADE_ENV,
  NO_SESSION_AFFINITY_ENV,
  TOOL_ORDER_ENV,
  PI_CACHE_RETENTION_ENV,
} = internals;

type MutableTestEnv = Record<string, string | undefined>;

test("parses v3 config with retention and optimization toggles", () => {
  const full = {
    version: 3,
    footerMode: "total",
    promptCacheKey: { omit: ["z/model", "a/model", "a/model"] },
    retention: "short",
    promptRewrite: false,
    skillCompression: true,
    promptCacheKeyFallback: false,
    compatWarnings: true,
    footerStats: false,
    deterministicToolOrdering: true,
    anthropicTtlDowngrade: false,
    sessionAffinity: true,
  };
  assert.deepEqual(parsePersistedCacheOptimizerConfig(full), {
    version: 3,
    footerMode: "total",
    promptCacheKey: { omit: ["a/model", "z/model"] },
    retention: "short",
    promptRewrite: false,
    skillCompression: true,
    promptCacheKeyFallback: false,
    compatWarnings: true,
    footerStats: false,
    deterministicToolOrdering: true,
    anthropicTtlDowngrade: false,
    sessionAffinity: true,
  });

  // Sparse v3: only some keys.
  assert.deepEqual(
    parsePersistedCacheOptimizerConfig({ version: 3, retention: "none" }),
    { version: 3, retention: "none" },
  );
  assert.deepEqual(parsePersistedCacheOptimizerConfig({ version: 3 }), { version: 3 });

  // Invalid retention value rejects the file (existing strict-parse pattern).
  assert.equal(parsePersistedCacheOptimizerConfig({ version: 3, retention: "forever" }), undefined);
  // Non-boolean toggle rejects the file.
  assert.equal(parsePersistedCacheOptimizerConfig({ version: 3, promptRewrite: "yes" }), undefined);
  // Unknown top-level key rejects the file (never fatal at read: defaults apply).
  assert.equal(parsePersistedCacheOptimizerConfig({ version: 3, retention: "short", extra: 1 }), undefined);
  assert.equal(parsePersistedCacheOptimizerConfig({ version: 4 }), undefined);
});

test("v1 and v2 configs still parse unchanged (graceful degradation)", () => {
  assert.deepEqual(
    parsePersistedCacheOptimizerConfig({ version: 1, footerMode: "total" }),
    { version: 1, footerMode: "total" },
  );
  assert.deepEqual(
    parsePersistedCacheOptimizerConfig({ version: 2, footerMode: "session", promptCacheKey: { omit: ["z/model", "a/model"] } }),
    { version: 2, footerMode: "session", promptCacheKey: { omit: ["a/model", "z/model"] } },
  );
});

test("readPersistedCacheOptimizerConfig preserves the file's schema version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-config-read-"));
  try {
    const path = join(dir, "pi-cache-optimizer-config.json");
    await writeFile(path, JSON.stringify({ version: 2, footerMode: "total" }) + "\n");
    assert.deepEqual(readPersistedCacheOptimizerConfig(path), { version: 2, footerMode: "total" });

    await writeFile(path, JSON.stringify({ version: 3, retention: "short", footerStats: false }) + "\n");
    assert.deepEqual(readPersistedCacheOptimizerConfig(path), { version: 3, retention: "short", footerStats: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveCacheRetentionMode precedence: config > env > default", () => {
  assert.deepEqual(resolveCacheRetentionMode({}), { mode: "long", source: "default" });
  assert.deepEqual(resolveCacheRetentionMode({ [RETENTION_ENV]: "short" }), { mode: "short", source: "env" });
  assert.deepEqual(resolveCacheRetentionMode({ [RETENTION_ENV]: "startup" }), { mode: "startup", source: "env" });
  // Invalid env value is ignored.
  assert.deepEqual(resolveCacheRetentionMode({ [RETENTION_ENV]: "forever" }), { mode: "long", source: "default" });
  // Config beats env.
  assert.deepEqual(
    resolveCacheRetentionMode({ [RETENTION_ENV]: "short" }, "none"),
    { mode: "none", source: "config" },
  );
  // Explicit undefined is treated as absent (startup module-init path).
  assert.deepEqual(
    resolveCacheRetentionMode({ [RETENTION_ENV]: "short" }, undefined),
    { mode: "short", source: "env" },
  );
});

test("resolveEffectiveCacheRetentionMode layers the persisted config", () => {
  try {
    setPersistedCacheOptimizerConfig({ version: 3, retention: "short" });
    assert.deepEqual(resolveEffectiveCacheRetentionMode({ [RETENTION_ENV]: "long" }), { mode: "short", source: "config" });
    setPersistedCacheOptimizerConfig({ version: 2 });
    assert.deepEqual(resolveEffectiveCacheRetentionMode({ [RETENTION_ENV]: "none" }), { mode: "none", source: "env" });
    assert.deepEqual(resolveEffectiveCacheRetentionMode({}), { mode: "long", source: "default" });
  } finally {
    setPersistedCacheOptimizerConfig({ version: 2 });
  }
});

test("applyCacheRetentionMode semantics for all four modes", () => {
  const env: MutableTestEnv = {};
  applyCacheRetentionMode("long", env);
  assert.equal(env[PI_CACHE_RETENTION_ENV], "long");

  // "long" stomps a pre-set non-long value — byte-identical to upstream.
  const stomped: MutableTestEnv = { [PI_CACHE_RETENTION_ENV]: "medium" };
  applyCacheRetentionMode("long", stomped);
  assert.equal(stomped[PI_CACHE_RETENTION_ENV], "long");
  const upstreamRef: MutableTestEnv = { [PI_CACHE_RETENTION_ENV]: "medium" };
  requestLongCacheRetention(upstreamRef);
  assert.deepEqual(stomped, upstreamRef);

  applyCacheRetentionMode("short", env);
  assert.equal(env[PI_CACHE_RETENTION_ENV], "short");
  applyCacheRetentionMode("long", env);
  assert.equal(env[PI_CACHE_RETENTION_ENV], "long");

  // "none" deletes even an inherited value (no steering at all).
  const inherited: MutableTestEnv = { [PI_CACHE_RETENTION_ENV]: "long" };
  applyCacheRetentionMode("none", inherited);
  assert.equal(Object.hasOwn(inherited, PI_CACHE_RETENTION_ENV), false);

  // "startup" leaves the pre-session env completely untouched.
  const preset: MutableTestEnv = { [PI_CACHE_RETENTION_ENV]: "short" };
  applyCacheRetentionMode("startup", preset);
  assert.equal(preset[PI_CACHE_RETENTION_ENV], "short");
  const unset: MutableTestEnv = {};
  applyCacheRetentionMode("startup", unset);
  assert.equal(Object.hasOwn(unset, PI_CACHE_RETENTION_ENV), false);
});

test("resolveConfigToggle precedence: config > env-folded default", () => {
  assert.equal(resolveConfigToggle(undefined, true), true);
  assert.equal(resolveConfigToggle(undefined, false), false);
  assert.equal(resolveConfigToggle(true, false), true);
  assert.equal(resolveConfigToggle(false, true), false);
});

test("setRuntimeOptimizerEnabled gates the enable-time stomp site", () => {
  const baseline = getOrCaptureCacheRetentionBaseline();
  try {
    // Config retention short: enable must apply short, not long.
    setPersistedCacheOptimizerConfig({ version: 3, retention: "short" });
    const envShort: MutableTestEnv = { [PI_CACHE_RETENTION_ENV]: "long" };
    setRuntimeOptimizerEnabled(true, envShort);
    assert.equal(envShort[PI_CACHE_RETENTION_ENV], "short");

    // Startup passthrough: enable must not touch the env at all.
    setPersistedCacheOptimizerConfig({ version: 3, retention: "startup" });
    const envPassthrough: MutableTestEnv = { [PI_CACHE_RETENTION_ENV]: "medium" };
    setRuntimeOptimizerEnabled(true, envPassthrough);
    assert.equal(envPassthrough[PI_CACHE_RETENTION_ENV], "medium");

    // No config: upstream stomp semantics preserved (force long over any value).
    setPersistedCacheOptimizerConfig({ version: 2 });
    const envUpstream: MutableTestEnv = { [PI_CACHE_RETENTION_ENV]: "medium" };
    setRuntimeOptimizerEnabled(true, envUpstream);
    assert.equal(envUpstream[PI_CACHE_RETENTION_ENV], "long");

    // Disable restores the startup baseline snapshot.
    if (baseline.wasSet) {
      assert.equal(envUpstream[PI_CACHE_RETENTION_ENV], baseline.value);
    } else {
      assert.equal(Object.hasOwn(envUpstream, PI_CACHE_RETENTION_ENV), false);
    }
  } finally {
    setPersistedCacheOptimizerConfig({ version: 2 });
    setRuntimeOptimizerEnabled(true);
  }
});

test("optimization toggles: config key overrides env var, absent config keeps env semantics", () => {
  try {
    setRuntimeOptimizerEnabled(true);

    // Back-compat: no config, no env → upstream defaults.
    setPersistedCacheOptimizerConfig({ version: 2 });
    assert.equal(isPromptRewriteEnabled({}), true);
    assert.equal(isSkillCompressionEnabled({}), true);
    assert.equal(isPromptCacheKeyFallbackEnabled({}), true);
    assert.equal(isCompatWarningsEnabled({}), true);
    assert.equal(isFooterStatsEnabled({}), true);
    assert.equal(isAnthropicTtlDowngradeEnabled({}), true);
    assert.equal(isSessionAffinityToggleEnabled({}), true);
    assert.equal(isToolOrderEnabled({}), false);

    // Env opt-outs still work with no config.
    assert.equal(isPromptRewriteEnabled({ [NO_PROMPT_REWRITE_ENV]: "1" }), false);
    assert.equal(isSkillCompressionEnabled({ [NO_SKILL_COMPRESSION_ENV]: "1" }), false);
    assert.equal(isPromptCacheKeyFallbackEnabled({ [NO_OPENAI_CACHE_KEY_ENV]: "1" }), false);
    assert.equal(isCompatWarningsEnabled({ [NO_COMPAT_WARNINGS_ENV]: "1" }), false);
    assert.equal(isFooterStatsEnabled({ [NO_FOOTER_STATS_ENV]: "1" }), false);
    assert.equal(isAnthropicTtlDowngradeEnabled({ [NO_ANTHROPIC_TTL_DOWNGRADE_ENV]: "1" }), false);
    assert.equal(isSessionAffinityToggleEnabled({ [NO_SESSION_AFFINITY_ENV]: "1" }), false);
    assert.equal(isToolOrderEnabled({ [TOOL_ORDER_ENV]: "1" }), true);

    // Config false beats absent/absent env.
    setPersistedCacheOptimizerConfig({ version: 3, promptRewrite: false, skillCompression: false, promptCacheKeyFallback: false, compatWarnings: false, footerStats: false, anthropicTtlDowngrade: false, sessionAffinity: false });
    assert.equal(isPromptRewriteEnabled({}), false);
    assert.equal(isSkillCompressionEnabled({}), false);
    assert.equal(isPromptCacheKeyFallbackEnabled({}), false);
    assert.equal(isCompatWarningsEnabled({}), false);
    assert.equal(isFooterStatsEnabled({}), false);
    assert.equal(isAnthropicTtlDowngradeEnabled({}), false);
    assert.equal(isSessionAffinityToggleEnabled({}), false);

    // Config true beats env opt-out.
    setPersistedCacheOptimizerConfig({ version: 3, promptRewrite: true, promptCacheKeyFallback: true });
    assert.equal(isPromptRewriteEnabled({ [NO_PROMPT_REWRITE_ENV]: "1" }), true);
    assert.equal(isPromptCacheKeyFallbackEnabled({ [NO_OPENAI_CACHE_KEY_ENV]: "1" }), true);

    // Config true forces the opt-in tool ordering on without env.
    setPersistedCacheOptimizerConfig({ version: 3, deterministicToolOrdering: true });
    assert.equal(isToolOrderEnabled({}), true);
    // Config false beats env opt-in.
    setPersistedCacheOptimizerConfig({ version: 3, deterministicToolOrdering: false });
    assert.equal(isToolOrderEnabled({ [TOOL_ORDER_ENV]: "1" }), false);

    // skillCompression is layered under the prompt-rewrite master switch
    // (config absent: the master env opt-out still disables compression).
    setPersistedCacheOptimizerConfig({ version: 3 });
    assert.equal(isSkillCompressionEnabled({ [NO_PROMPT_REWRITE_ENV]: "1" }), false);
    assert.equal(isSkillCompressionEnabled({ [NO_SKILL_COMPRESSION_ENV]: "1" }), false);
    assert.equal(isSkillCompressionEnabled({}), true);

    // Runtime disable turns off runtime-gated features (upstream semantics).
    setPersistedCacheOptimizerConfig({ version: 3, promptRewrite: true, deterministicToolOrdering: true });
    setRuntimeOptimizerEnabled(false);
    assert.equal(isPromptRewriteEnabled({}), false);
    assert.equal(isToolOrderEnabled({ [TOOL_ORDER_ENV]: "1" }), false);
    assert.equal(isPromptCacheKeyFallbackEnabled({}), false);
    // Always-on safety repairs stay on when the runtime optimizer is disabled.
    assert.equal(isAnthropicTtlDowngradeEnabled({}), true);
  } finally {
    setPersistedCacheOptimizerConfig({ version: 2 });
    setRuntimeOptimizerEnabled(true);
  }
});

test("persistedConfigWriteShape keeps the oldest schema that fits", () => {
  assert.deepEqual(
    persistedConfigWriteShape({ version: 3, footerMode: "total" }),
    { version: 2, footerMode: "total" },
  );
  assert.deepEqual(
    persistedConfigWriteShape({ version: 3, promptCacheKey: { omit: ["p/m"] } }),
    { version: 2, promptCacheKey: { omit: ["p/m"] } },
  );
  const v3 = { version: 3 as const, retention: "short" as const };
  assert.deepEqual(persistedConfigWriteShape(v3), v3);
  assert.deepEqual(
    persistedConfigWriteShape({ version: 3, promptRewrite: false }),
    { version: 3, promptRewrite: false },
  );
});

test("writePersistedRetention round-trips and preserves sibling keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-retention-write-"));
  try {
    const path = join(dir, "pi-cache-optimizer-config.json");

    // v2 file: retention write upgrades to v3, keeps footerMode + promptCacheKey.
    await writeFile(path, JSON.stringify({ version: 2, footerMode: "total", promptCacheKey: { omit: ["p/m"] } }) + "\n");
    await writePersistedRetention("short", path);
    const upgraded = JSON.parse(await readFile(path, "utf8"));
    assert.equal(upgraded.version, 3);
    assert.equal(upgraded.retention, "short");
    assert.equal(upgraded.footerMode, "total");
    assert.deepEqual(upgraded.promptCacheKey, { omit: ["p/m"] });
    assert.equal(asV3CacheOptimizerConfig(readPersistedCacheOptimizerConfig(path)).retention, "short");

    // v1 file: footerMode carried into v3.
    await writeFile(path, JSON.stringify({ version: 1, footerMode: "session" }) + "\n");
    await writePersistedRetention("startup", path);
    const fromV1 = JSON.parse(await readFile(path, "utf8"));
    assert.equal(fromV1.version, 3);
    assert.equal(fromV1.retention, "startup");
    assert.equal(fromV1.footerMode, "session");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema-rejected readable config warns instead of silently using defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-reject-warn-"));
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const path = join(dir, "pi-cache-optimizer-config.json");
    await writeFile(path, JSON.stringify({ version: 3, retention: "forever" }) + "\n");
    assert.deepEqual(readPersistedCacheOptimizerConfig(path), { version: 2 });
    assert.equal(warnings.some((text) => text.includes("schema rejected")), true);

    warnings.length = 0;
    await writeFile(path, JSON.stringify({ version: 3, retention: "short" }) + "\n");
    assert.deepEqual(readPersistedCacheOptimizerConfig(path), { version: 3, retention: "short" });
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompt-cache-key rollback preserves v3-only config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-rollback-v3-"));
  try {
    const configPath = join(dir, "pi-cache-optimizer-config.json");
    const receiptPath = join(dir, "pi-cache-optimizer-config-receipt.json");
    await writeFile(configPath, JSON.stringify({ version: 3, retention: "short" }) + "\n");
    const model = { provider: "p", id: "m" } as Parameters<typeof applyPromptCacheKeyConfigFix>[0];
    await applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
    const afterFix = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(afterFix.version, 3);
    assert.equal(afterFix.retention, "short");
    assert.deepEqual(afterFix.promptCacheKey, { omit: ["p/m"] });

    const snapshot = await readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
    assert.ok(snapshot, "receipt snapshot readable");
    await rollbackPromptCacheKeyConfig(snapshot, configPath, receiptPath);
    const afterRollback = JSON.parse(await readFile(configPath, "utf8"));
    // Invariant: rollback restores the pre-fix config; a v3-only file must
    // survive intact (never unlinked, v3 keys never dropped).
    assert.equal(afterRollback.version, 3);
    assert.equal(afterRollback.retention, "short");
    assert.equal(afterRollback.promptCacheKey, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("footer-mode write preserves v3 keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-footer-v3-"));
  try {
    const path = join(dir, "pi-cache-optimizer-config.json");
    await writeFile(path, JSON.stringify({ version: 3, retention: "short", promptRewrite: false }) + "\n");
    await writePersistedFooterMode("process", path);
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.equal(after.version, 3);
    assert.equal(after.retention, "short");
    assert.equal(after.promptRewrite, false);
    assert.equal(after.footerMode, "process");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
