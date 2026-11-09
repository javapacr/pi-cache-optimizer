import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createJiti } from "jiti";
import {
  CACHE_RETENTION_MODES,
  PI_CACHE_RETENTION_ENV,
  RETENTION_ENV,
  applyCacheRetentionMode,
  decidePromptCacheRetention,
  parseCacheRetentionMode,
  resolveCacheRetentionMode,
} from "../src/retention.ts";

// config.ts, index.ts and command-completion.ts are loaded only through fresh(),
// after agentDir(): a static import would bind STATE_DIR to the inherited agent dir.
type ConfigModule = typeof import("../src/config.ts");
type PromptCacheKeyConfigModule = typeof import("../src/prompt-cache-key-config.ts");
type ExtensionModule = typeof import("../index.ts");

const CONFIG_FILE_NAME = "pi-cache-optimizer-config.json";
const FOOTER_MODE_ENV = "PI_CACHE_OPTIMIZER_FOOTER_MODE";
const BASELINE_SYMBOL_DESCRIPTION = "pi.cache.optimizer.retention-baseline.v1";
const SNAPSHOT_KEYS = ["PI_CODING_AGENT_DIR", PI_CACHE_RETENTION_ENV, RETENTION_ENV, FOOTER_MODE_ENV] as const;

const envSnapshot = Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

beforeEach(() => {
  delete process.env[RETENTION_ENV];
  delete process.env[FOOTER_MODE_ENV];
});

afterEach(async () => {
  for (const key of SNAPSHOT_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function agentDir(config?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cache-retention-mode-"));
  tempDirs.push(dir);
  if (config !== undefined) await writeFile(join(dir, CONFIG_FILE_NAME), typeof config === "string" ? config : JSON.stringify(config) + "\n");
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function fresh<T>(relativePath: string): Promise<T> {
  const jiti = createJiti(join(process.cwd(), "tests", "retention-mode.test.ts"), { moduleCache: false });
  return jiti.import<T>(join(process.cwd(), relativePath));
}

type ChildResult = {
  value: string | null;
  baseline: { wasSet: boolean; value?: string } | undefined;
  userRequestedLong: boolean;
  writes: Array<{ op: "set" | "delete"; value?: string }>;
};

function script(entry: "index.ts" | "src/retention.ts"): string {
  return `
    const writes = [];
    process.env = new Proxy(process.env, {
      set(target, key, value) {
        if (key === ${JSON.stringify(PI_CACHE_RETENTION_ENV)}) writes.push({ op: "set", value: String(value) });
        return Reflect.set(target, key, value);
      },
      deleteProperty(target, key) {
        if (key === ${JSON.stringify(PI_CACHE_RETENTION_ENV)}) writes.push({ op: "delete" });
        return Reflect.deleteProperty(target, key);
      },
    });
    await import(${JSON.stringify(join(process.cwd(), entry))});
    const loaded = await import(${JSON.stringify(join(process.cwd(), "src/retention.ts"))});
    const retention = loaded.userRequestedLongCacheRetention ? loaded : loaded.default;
    console.log(JSON.stringify({
      value: process.env.PI_CACHE_RETENTION ?? null,
      baseline: globalThis[Symbol.for(${JSON.stringify(BASELINE_SYMBOL_DESCRIPTION)})]?.snapshot,
      userRequestedLong: retention.userRequestedLongCacheRetention(),
      writes,
    }));
  `;
}

function child(entry: "index.ts" | "src/retention.ts", vars: Record<string, string | undefined>): ChildResult {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env[PI_CACHE_RETENTION_ENV];
  delete env[RETENTION_ENV];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const stdout = execFileSync(process.execPath, ["--import", "jiti/register", "--input-type=module", "-e", script(entry)], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60000,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as ChildResult;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function sessionStartValue(): Promise<string | undefined> {
  const extension = await fresh<ExtensionModule>("index.ts");
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  extension.default({
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand() {},
  } as never);
  process.env[PI_CACHE_RETENTION_ENV] = "sentinel";
  const ctx = {
    model: undefined,
    hasUI: false,
    sessionManager: { getSessionId: () => "retention-mode-session" },
    modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] },
    ui: { notify() {}, setStatus() {} },
  };
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  await extension.__internals_for_tests.waitForStatsRestore();
  return process.env[PI_CACHE_RETENTION_ENV];
}

async function enableSiteValue(): Promise<string | undefined> {
  const config = await fresh<ConfigModule>("src/config.ts");
  process.env[PI_CACHE_RETENTION_ENV] = "sentinel";
  config.setRuntimeOptimizerEnabled(true);
  return process.env[PI_CACHE_RETENTION_ENV];
}

const UPSTREAM_SHAPED = { version: 3, footerMode: "session", retention: "short", features: { promptRewrite: false } };

test("default: no setting means long at module load, enable and session_start", async () => {
  const dir = await agentDir();
  const loaded = child("index.ts", { PI_CODING_AGENT_DIR: dir, [PI_CACHE_RETENTION_ENV]: "short" });
  assert.equal(loaded.value, "long");
  assert.equal(loaded.userRequestedLong, false);
  assert.equal(await enableSiteValue(), "long");
  assert.equal(await sessionStartValue(), "long");
});

test("upstream-shaped: the I11 file keeps footerMode, retention and features", async () => {
  const dir = await agentDir(UPSTREAM_SHAPED);
  const config = await fresh<ConfigModule>("src/config.ts");
  assert.deepEqual(config.readPersistedCacheOptimizerConfig(join(dir, CONFIG_FILE_NAME)), {
    version: 3,
    footerMode: "session",
    retention: "short",
    features: { promptRewrite: false },
  });
  assert.equal(child("index.ts", { PI_CODING_AGENT_DIR: dir }).value, "short");
  assert.equal(await enableSiteValue(), "short");
  assert.equal(await sessionStartValue(), "short");
});

test("modes: apply semantics", () => {
  const long: Record<string, string | undefined> = { PI_CACHE_RETENTION: "x" };
  applyCacheRetentionMode("long", long);
  assert.equal(long.PI_CACHE_RETENTION, "long");

  const short: Record<string, string | undefined> = {};
  applyCacheRetentionMode("short", short);
  assert.equal(short.PI_CACHE_RETENTION, "short");

  const none: Record<string, string | undefined> = { PI_CACHE_RETENTION: "x" };
  applyCacheRetentionMode("none", none);
  assert.equal("PI_CACHE_RETENTION" in none, false);

  const startupNoSnapshot: Record<string, string | undefined> = { PI_CACHE_RETENTION: "x" };
  applyCacheRetentionMode("startup", startupNoSnapshot);
  assert.equal(startupNoSnapshot.PI_CACHE_RETENTION, "x");

  const startupUnset: Record<string, string | undefined> = { PI_CACHE_RETENTION: "x" };
  applyCacheRetentionMode("startup", startupUnset, { wasSet: false });
  assert.equal("PI_CACHE_RETENTION" in startupUnset, false);

  const startupSet: Record<string, string | undefined> = { PI_CACHE_RETENTION: "x" };
  applyCacheRetentionMode("startup", startupSet, { wasSet: true, value: "short" });
  assert.equal(startupSet.PI_CACHE_RETENTION, "short");
});

test("modes: parse trims and lowercases, rejects unknown values", () => {
  assert.equal(parseCacheRetentionMode(" Short "), "short");
  assert.equal(parseCacheRetentionMode("forever"), undefined);
  assert.equal(parseCacheRetentionMode(undefined), undefined);
  assert.equal(parseCacheRetentionMode(3), undefined);
  for (const mode of CACHE_RETENTION_MODES) assert.equal(parseCacheRetentionMode(mode), mode);
});

test("modes: precedence config > env > default", () => {
  assert.deepEqual(resolveCacheRetentionMode("none", { [RETENTION_ENV]: "short" }), { mode: "none", source: "config" });
  assert.deepEqual(resolveCacheRetentionMode(undefined, { [RETENTION_ENV]: "short" }), { mode: "short", source: "env" });
  assert.deepEqual(resolveCacheRetentionMode(undefined, { [RETENTION_ENV]: " STARTUP " }), { mode: "startup", source: "env" });
  assert.deepEqual(resolveCacheRetentionMode(undefined, {}), { mode: "long", source: "default" });
});

test("modes: each mode at enable and session_start", async () => {
  const expected: Record<(typeof CACHE_RETENTION_MODES)[number], string | undefined> = {
    long: "long",
    short: "short",
    none: undefined,
    startup: "sentinel",
  };
  for (const mode of CACHE_RETENTION_MODES) {
    await agentDir({ version: 3, retention: mode });
    assert.equal(await enableSiteValue(), expected[mode], `enable ${mode}`);
    assert.equal(await sessionStartValue(), expected[mode], `session_start ${mode}`);
  }
});

// Acceptance: under startup the inherited value is never even briefly overwritten.
function assertLoadWrites(loaded: ChildResult, mode: (typeof CACHE_RETENTION_MODES)[number], label: string): void {
  if (mode === "startup") assert.deepEqual(loaded.writes, [], `${label} writes`);
  else assert.ok(loaded.writes.length >= 1, `${label} writes`);
}

test("module load: each mode in a fresh process (config and env source)", async () => {
  const expected: Record<(typeof CACHE_RETENTION_MODES)[number], string | null> = {
    long: "long",
    short: "short",
    none: null,
    startup: "preset-value",
  };
  for (const mode of CACHE_RETENTION_MODES) {
    const configDir = await agentDir({ version: 3, retention: mode });
    const fromConfig = child("index.ts", { PI_CODING_AGENT_DIR: configDir, [PI_CACHE_RETENTION_ENV]: "preset-value" });
    assert.equal(fromConfig.value, expected[mode], `config ${mode}`);
    assertLoadWrites(fromConfig, mode, `config ${mode}`);
    assert.deepEqual(fromConfig.baseline, { wasSet: true, value: "preset-value" });

    const envDir = await agentDir();
    const fromEnv = child("index.ts", { PI_CODING_AGENT_DIR: envDir, [PI_CACHE_RETENTION_ENV]: "preset-value", [RETENTION_ENV]: mode });
    assert.equal(fromEnv.value, expected[mode], `env ${mode}`);
    assertLoadWrites(fromEnv, mode, `env ${mode}`);
    assert.deepEqual(fromEnv.baseline, { wasSet: true, value: "preset-value" });
  }
});

test("module load: retention.ts alone no longer writes", async () => {
  const dir = await agentDir();
  const loaded = child("src/retention.ts", { PI_CODING_AGENT_DIR: dir, [PI_CACHE_RETENTION_ENV]: "preset-value" });
  assert.equal(loaded.value, "preset-value");
});

test("invalid: an invalid config retention is ignored on its own", async () => {
  const dir = await agentDir({ version: 3, footerMode: "total", retention: "forever", features: { promptRewrite: false } });
  const config = await fresh<ConfigModule>("src/config.ts");
  assert.deepEqual(config.readPersistedCacheOptimizerConfig(join(dir, CONFIG_FILE_NAME)), {
    version: 3,
    footerMode: "total",
    features: { promptRewrite: false },
  });
  assert.equal(child("index.ts", { PI_CODING_AGENT_DIR: dir, [RETENTION_ENV]: "short" }).value, "short");
  assert.equal(child("index.ts", { PI_CODING_AGENT_DIR: dir }).value, "long");
});

test("invalid: an invalid env falls back to the default", () => {
  assert.deepEqual(resolveCacheRetentionMode(undefined, { [RETENTION_ENV]: "forever" }), { mode: "long", source: "default" });
});

test("writers: retention survives footer-mode, config <feature> and config reset", async () => {
  const dir = await agentDir({ version: 3, retention: "short" });
  const path = join(dir, CONFIG_FILE_NAME);
  const config = await fresh<ConfigModule>("src/config.ts");

  await config.writePersistedFooterMode("total", path);
  let raw = await readJson(path);
  assert.equal(raw.version, 3);
  assert.equal(raw.retention, "short");
  assert.equal(raw.footerMode, "total");

  await config.writePersistedFeature("promptRewrite", false, path);
  raw = await readJson(path);
  assert.equal(raw.version, 3);
  assert.equal(raw.retention, "short");
  assert.equal(raw.footerMode, "total");

  await config.resetPersistedFeatures(path);
  raw = await readJson(path);
  assert.equal(raw.version, 3);
  assert.equal(raw.retention, "short");
  assert.equal(raw.footerMode, "total");
});

test("writers: a retention-only file stays version 3", async () => {
  const dir = await agentDir({ version: 3, retention: "none" });
  const path = join(dir, CONFIG_FILE_NAME);
  const config = await fresh<ConfigModule>("src/config.ts");

  await config.resetPersistedFeatures(path);
  let raw = await readJson(path);
  assert.equal(raw.version, 3);
  assert.equal(raw.retention, "none");

  await config.writePersistedFooterMode("session", path);
  raw = await readJson(path);
  assert.equal(raw.version, 3);
  assert.equal(raw.retention, "none");
});

test("writers: retention survives prompt-cache-key fix and rollback", async () => {
  const dir = await agentDir();
  const configPath = join(dir, CONFIG_FILE_NAME);
  const receiptPath = join(dir, "pi-cache-optimizer-config-receipt.json");
  await writeFile(configPath, JSON.stringify({ version: 3, retention: "short", features: { promptRewrite: false } }) + "\n");
  const promptCacheKey = await fresh<PromptCacheKeyConfigModule>("src/prompt-cache-key-config.ts");
  const model = { provider: "p", id: "m" } as Parameters<PromptCacheKeyConfigModule["applyPromptCacheKeyConfigFix"]>[0];

  await promptCacheKey.applyPromptCacheKeyConfigFix(model, configPath, receiptPath);
  const afterFix = await readJson(configPath);
  assert.equal(afterFix.version, 3);
  assert.equal(afterFix.retention, "short");
  assert.deepEqual(afterFix.promptCacheKey, { omit: ["p/m"] });
  assert.deepEqual(afterFix.features, { promptRewrite: false });

  const snapshot = await promptCacheKey.readPromptCacheKeyConfigReceiptSnapshot(receiptPath);
  assert.ok(snapshot, "receipt snapshot readable");
  await promptCacheKey.rollbackPromptCacheKeyConfig(snapshot, configPath, receiptPath);
  const afterRollback = await readJson(configPath);
  assert.equal(afterRollback.version, 3);
  assert.equal(afterRollback.retention, "short");
  assert.equal(afterRollback.promptCacheKey, undefined);
  assert.deepEqual(afterRollback.features, { promptRewrite: false });
});

test("writers: writePersistedRetention upgrades v1/v2 and keeps siblings", async () => {
  const dir = await agentDir();
  const config = await fresh<ConfigModule>("src/config.ts");

  const v2Path = join(dir, "v2.json");
  await writeFile(v2Path, JSON.stringify({ version: 2, footerMode: "total", promptCacheKey: { omit: ["p/m"] } }) + "\n");
  await config.writePersistedRetention("short", v2Path);
  assert.deepEqual(await readJson(v2Path), { version: 3, footerMode: "total", promptCacheKey: { omit: ["p/m"] }, retention: "short" });

  const v1Path = join(dir, "v1.json");
  await writeFile(v1Path, JSON.stringify({ version: 1, footerMode: "process" }) + "\n");
  await config.writePersistedRetention("none", v1Path);
  assert.deepEqual(await readJson(v1Path), { version: 3, footerMode: "process", retention: "none" });

  const missingPath = join(dir, "missing.json");
  await config.writePersistedRetention("long", missingPath);
  assert.deepEqual(await readJson(missingPath), { version: 3, retention: "long" });

  const brokenPath = join(dir, "broken.json");
  await writeFile(brokenPath, "{ not json");
  await assert.rejects(() => config.writePersistedRetention("short", brokenPath), /invalid or unreadable/);
  assert.equal(await readFile(brokenPath, "utf8"), "{ not json");
});

test("gate: fork-mode writes never count as user-requested", async () => {
  type Case = { mode: (typeof CACHE_RETENTION_MODES)[number]; source: "config" | "env"; preset: string | undefined };
  const cases: Case[] = [];
  for (const mode of CACHE_RETENTION_MODES) {
    for (const preset of [undefined, "long", "short"]) cases.push({ mode, source: "config", preset });
  }
  cases.push({ mode: "long", source: "env", preset: undefined });

  for (const { mode, source, preset } of cases) {
    const label = `${source} ${mode} preset=${preset ?? "unset"}`;
    const dir = await agentDir(source === "config" ? { version: 3, retention: mode } : undefined);
    const result = child("index.ts", {
      PI_CODING_AGENT_DIR: dir,
      [PI_CACHE_RETENTION_ENV]: preset,
      [RETENTION_ENV]: source === "env" ? mode : undefined,
    });
    assert.equal(result.userRequestedLong, preset === "long", label);
    const emitsLong = mode === "long" || (mode === "startup" && preset === "long");
    if (!emitsLong) {
      assert.notEqual(result.value, "long", label);
      continue;
    }
    assert.equal(result.value, "long", label);
    const decision = decidePromptCacheRetention({
      providerRejected: false,
      officialOpenAI: false,
      explicitOptIn: false,
      userRequestedLong: result.userRequestedLong,
    });
    assert.deepEqual(decision, preset === "long" ? { keep: true, reason: "user-requested-long" } : { keep: false, reason: "unverified-endpoint" }, label);
  }
});
