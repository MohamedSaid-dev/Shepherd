#!/usr/bin/env node
// Self-contained Shepherd installer harness (ESM, no dependencies).
//
// Verifies, via the CLI only (child_process), that tools/install.js:
//   1. performs a fresh install (exact 11 files + merged config),
//   2. preserves unrelated config/plugin entries,
//   3. refuses conflicts with zero writes (no --force),
//   4. with --force backs up and merges,
//   5. is idempotent,
//   6. with --dry-run performs zero writes,
//   7. refuses invalid target/type,
//   8. rejects unknown arguments before any write.
//   Plus review-hardening cases:
//   9.  exact equality of all 8 merged source agents,
//   10. baseline records prior state and backup mappings,
//   11. explicit --config-dir overrides OPENCODE_CONFIG_DIR; env used when no flag,
//   12. --dry-run reports actual would-back-up paths (no agent: labels),
//   13. rejects symlink/junction traversal (when platform permits),
//   14. POSIX mode preservation and 0o600 for config-state (non-Windows),
//   15. refuses when the install lock already exists,
//   16. deterministic failure injection proves safe rollback (test env only).
//
// Uses temp directories and runs the installer from a neutral cwd to prove
// cwd-independence. Exits nonzero if any scenario fails.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_JS = path.join(REPO_ROOT, 'tools', 'install.js');

const OWNED_FILES = [
  'agents/shepherd.md', 'agents/sheep-cheap.md', 'agents/sheep-fast.md',
  'agents/sheep-ui.md', 'agents/sheep-test.md', 'agents/sheep-search.md',
  'agents/sheep-review.md', 'agents/sheep-docs.md',
  'command/sheeps-models.md', 'command/herd.md', 'plugin/shepherd.ts',
];
const SHEPHERD_AGENTS = [
  'shepherd', 'sheep-cheap', 'sheep-fast', 'sheep-ui',
  'sheep-test', 'sheep-search', 'sheep-review', 'sheep-docs',
];
const PLUGIN_PATH = './plugin/shepherd.ts';

const HARNESS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-harness-'));

function assert(cond, msg) {
  if (!cond) throw new Error('assertion failed: ' + msg);
}

// Mark a scenario as skipped (e.g. platform does not permit symlinks, or POSIX
// modes are not enforced). Skipped scenarios are reported as skipped, NOT passed.
function skip(msg) {
  const e = new Error(msg || 'skipped');
  e.__skip = true;
  throw e;
}

function runInstall(cfgDir, extraArgs = []) {
  const args = [INSTALL_JS, '--config-dir', cfgDir, ...extraArgs];
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd: HARNESS_TMP });
}
// Run with fully explicit args (e.g. the empty-equals form `--config-dir=`).
function runInstallArgs(extraArgs) {
  const args = [INSTALL_JS, ...extraArgs];
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd: HARNESS_TMP });
}
// Run with an explicit (merged) environment.
function runInstallEnv(extraArgs, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  const args = [INSTALL_JS, ...extraArgs];
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd: HARNESS_TMP, env });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readSource(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, '.config', 'opencode', rel));
}

function listTree(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d, base) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = base ? path.join(base, e.name) : e.name;
      if (e.isDirectory()) walk(full, rel);
      else out.push(rel.split(path.sep).join('/'));
    }
  };
  walk(dir, '');
  return out;
}

function countBackups(cfgDir) {
  return listTree(cfgDir).filter((f) => f.includes('.shepherd-backup-')).length;
}
function countBaselines(cfgDir) {
  return listTree(cfgDir).filter((f) => f.includes('shepherd-baseline-')).length;
}
function countTemps(cfgDir) {
  return listTree(cfgDir).filter((f) => f.includes('.shepherd-tmp-')).length;
}
function findBackupWithContent(cfgDir, content) {
  for (const f of listTree(cfgDir)) {
    if (f.includes('.shepherd-backup-')) {
      if (fs.readFileSync(path.join(cfgDir, f), 'utf8') === content) return f;
    }
  }
  return null;
}

// Complete-tree snapshot: every file (including baselines/backups) with a
// content hash, so we can prove the whole tree is byte-identical across runs.
function snapshotTree(dir) {
  const tree = listTree(dir).sort();
  const hashes = tree.map((f) =>
    f + '#' + crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'));
  return JSON.stringify({ tree, hashes });
}

function newCfg() {
  return fs.mkdtempSync(path.join(HARNESS_TMP, 'cfg-'));
}

function writeConfig(cfgDir, obj) {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'opencode.json'), JSON.stringify(obj, null, 2));
}

function verifyMergedConfig(cfgDir) {
  const cfg = readJson(path.join(cfgDir, 'opencode.json'));
  assert(cfg.default_agent === 'shepherd', 'default_agent should be shepherd');
  assert(isPlainObject(cfg.agent), 'agent should be an object');
  for (const k of SHEPHERD_AGENTS) {
    assert(Object.prototype.hasOwnProperty.call(cfg.agent, k), 'missing shepherd agent: ' + k);
    assert(isPlainObject(cfg.agent[k]), 'shepherd agent value should be object: ' + k);
  }
  assert(Array.isArray(cfg.plugin), 'plugin should be normalized to array');
  assert(cfg.plugin.includes(PLUGIN_PATH), 'plugin should include ' + PLUGIN_PATH);
  return cfg;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function verifyOwnedFilesCopied(cfgDir) {
  for (const rel of OWNED_FILES) {
    const dest = path.join(cfgDir, rel);
    assert(fs.existsSync(dest), 'owned file missing: ' + rel);
    const src = readSource(rel);
    const got = fs.readFileSync(dest);
    assert(src.equals(got), 'owned file content mismatch: ' + rel);
  }
}

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

// Returns true if the platform permits creating symlinks/junctions here.
function canMakeSymlink() {
  const d = fs.mkdtempSync(path.join(HARNESS_TMP, 'symtest-'));
  const target = path.join(d, 'target.txt');
  const link = path.join(d, 'link.txt');
  fs.writeFileSync(target, 'x');
  try { fs.symlinkSync(target, link); return true; }
  catch (_) { return false; }
  finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
}

const scenarios = [];
function scenario(name, fn) { scenarios.push({ name, fn }); }

// 1. Fresh install
scenario('fresh install copies 11 files and merges config', () => {
  const cfg = newCfg();
  const r = runInstall(cfg);
  assert(r.status === 0, 'exit 0, got ' + r.status + ' stderr=' + r.stderr);
  verifyOwnedFilesCopied(cfg);
  verifyMergedConfig(cfg);
  assert(countBackups(cfg) === 0, 'fresh install should create no backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 1, 'fresh install should write one baseline, got ' + countBaselines(cfg));
  // Baseline must carry the .json suffix and the lock must be released.
  const bl0 = listTree(cfg).find((f) => f.includes('shepherd-baseline-'));
  assert(bl0 && bl0.endsWith('.json'), 'baseline must end with .json, got ' + bl0);
  assert(!fs.existsSync(path.join(cfg, '.shepherd-install.lock')), 'lock must be removed after successful install');
});

// 2. Preservation of unrelated config/plugin entries
scenario('preserves unrelated config and plugin entries', () => {
  const cfg = newCfg();
  writeConfig(cfg, {
    model: { provider: 'x', id: 'y' },
    agent: { 'my-agent': { model: 'custom' } },
    plugin: './plugin/other.ts',
    default_agent: 'something-else',
  });
  const r = runInstall(cfg);
  assert(r.status === 0, 'exit 0, got ' + r.status + ' stderr=' + r.stderr);
  verifyOwnedFilesCopied(cfg);
  const c = verifyMergedConfig(cfg);
  assert(isPlainObject(c.model) && c.model.id === 'y', 'unrelated model key not preserved');
  assert(isPlainObject(c.agent['my-agent']) && c.agent['my-agent'].model === 'custom', 'unrelated agent not preserved');
  assert(c.plugin[0] === './plugin/other.ts', 'existing plugin entry not preserved first');
  assert(c.plugin[c.plugin.length - 1] === PLUGIN_PATH, 'shepherd plugin not appended last');
  assert(c.plugin.length === 2, 'plugin should have exactly 2 entries, got ' + c.plugin.length);
});

// 3. Conflict refusal (file) with zero writes
scenario('conflict (file) refuses with zero writes', () => {
  const cfg = newCfg();
  fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agents', 'shepherd.md'), 'CUSTOM CONTENT');
  const r = runInstall(cfg);
  assert(r.status !== 0, 'should exit nonzero on conflict, got ' + r.status);
  assert(!fs.existsSync(path.join(cfg, 'opencode.json')), 'no opencode.json should be written on conflict');
  assert(countBackups(cfg) === 0, 'no backups on conflict refusal, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 0, 'no baseline on conflict refusal, got ' + countBaselines(cfg));
  assert(fs.readFileSync(path.join(cfg, 'agents', 'shepherd.md'), 'utf8') === 'CUSTOM CONTENT', 'custom file must be untouched');
});

// 3b. Conflict refusal (agent entry) with zero writes
scenario('conflict (agent entry) refuses with zero writes', () => {
  const cfg = newCfg();
  writeConfig(cfg, {
    default_agent: 'shepherd',
    agent: { shepherd: { model: 'custom-model', variant: 'weird' } },
    plugin: [PLUGIN_PATH],
  });
  const r = runInstall(cfg);
  assert(r.status !== 0, 'should exit nonzero on agent conflict, got ' + r.status);
  const c = readJson(path.join(cfg, 'opencode.json'));
  assert(c.agent.shepherd.model === 'custom-model', 'existing config must be untouched on conflict');
  assert(countBackups(cfg) === 0, 'no backups on conflict refusal, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 0, 'no baseline on conflict refusal, got ' + countBaselines(cfg));
});

// 4. --force backs up and merges
scenario('--force backs up and merges conflicting content', () => {
  const cfg = newCfg();
  fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agents', 'shepherd.md'), 'CUSTOM CONTENT');
  writeConfig(cfg, {
    default_agent: 'other',
    agent: { shepherd: { model: 'custom-model' } },
    plugin: ['./plugin/other.ts'],
  });
  const r = runInstall(cfg, ['--force']);
  assert(r.status === 0, 'exit 0 with --force, got ' + r.status + ' stderr=' + r.stderr);
  verifyOwnedFilesCopied(cfg);
  const c = verifyMergedConfig(cfg);
  assert(c.agent.shepherd.model !== 'custom-model', 'shepherd agent should be replaced by source');
  assert(c.plugin.includes('./plugin/other.ts'), 'other plugin preserved');
  assert(countBackups(cfg) === 2, 'should create 2 backups (file + config), got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 1, 'should write one baseline, got ' + countBaselines(cfg));
  // backup content should reflect the pre-install (custom) state
  const bakFile = listTree(cfg).find((f) => f.includes('agents/shepherd.md.shepherd-backup-'));
  assert(bakFile, 'shepherd.md backup should exist');
  assert(fs.readFileSync(path.join(cfg, bakFile), 'utf8') === 'CUSTOM CONTENT', 'backup should hold pre-install content');
});

// 5. Idempotence
scenario('idempotent re-run makes no changes, no backups, no new baseline', () => {
  const cfg = newCfg();
  const r1 = runInstall(cfg);
  assert(r1.status === 0, 'first run exit 0, got ' + r1.status);
  verifyOwnedFilesCopied(cfg);
  verifyMergedConfig(cfg);
  assert(countBackups(cfg) === 0, 'fresh install should create no backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 1, 'fresh install should write one baseline, got ' + countBaselines(cfg));
  // Idempotence: re-running must not change the COMPLETE tree (including the
  // baseline artifact) or any file contents, and must create no new artifacts.
  const before = snapshotTree(cfg);
  const r2 = runInstall(cfg);
  assert(r2.status === 0, 'second run exit 0, got ' + r2.status);
  const after = snapshotTree(cfg);
  assert(before === after, 'complete tree (including baselines) and file contents must be unchanged on re-run');
  assert(countBackups(cfg) === 0, 'idempotent re-run should create no backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 1, 'idempotent re-run must not create a new baseline, got ' + countBaselines(cfg));
  assert(r2.stdout.includes('Baseline: none'), 'idempotent re-run should report baseline as none, stdout=' + r2.stdout);
  assert(r2.stdout.includes('no change'), 'idempotent re-run should report no change, stdout=' + r2.stdout);
});

// 6. Dry-run zero writes
scenario('--dry-run performs zero writes', () => {
  const cfg = newCfg();
  fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agents', 'shepherd.md'), 'CUSTOM CONTENT');
  writeConfig(cfg, { agent: { shepherd: { model: 'custom-model' } }, plugin: [PLUGIN_PATH] });
  const beforeCfg = fs.readFileSync(path.join(cfg, 'opencode.json'), 'utf8');
  const r = runInstall(cfg, ['--dry-run']);
  assert(r.status === 0, 'dry-run exit 0, got ' + r.status);
  // The test setup created opencode.json; dry-run must leave it byte-for-byte unchanged.
  const afterCfg = fs.readFileSync(path.join(cfg, 'opencode.json'), 'utf8');
  assert(afterCfg === beforeCfg, 'dry-run must not modify opencode.json');
  assert(countBackups(cfg) === 0, 'dry-run must not create backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 0, 'dry-run must not write baseline, got ' + countBaselines(cfg));
  assert(fs.readFileSync(path.join(cfg, 'agents', 'shepherd.md'), 'utf8') === 'CUSTOM CONTENT', 'dry-run must not alter files');
  assert(r.stdout.includes('DRY-RUN'), 'dry-run output should mention DRY-RUN');
});

// 7. Invalid target/type refusal
scenario('invalid target root (array) refuses with zero writes', () => {
  const cfg = newCfg();
  writeConfig(cfg, [1, 2, 3]);
  const r = runInstall(cfg);
  assert(r.status !== 0, 'array root should be rejected, got ' + r.status);
  assert(countBackups(cfg) === 0, 'no backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 0, 'no baseline, got ' + countBaselines(cfg));
  assert(listTree(cfg).filter((f) => f.endsWith('.md') || f.endsWith('.ts')).length === 0, 'no owned files copied on invalid target');
});

scenario('invalid plugin (non-string array) refuses with zero writes', () => {
  const cfg = newCfg();
  writeConfig(cfg, { plugin: [42] });
  const r = runInstall(cfg);
  assert(r.status !== 0, 'plugin array with non-string should be rejected, got ' + r.status);
  assert(countBackups(cfg) === 0, 'no backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 0, 'no baseline, got ' + countBaselines(cfg));
});

scenario('invalid agent (non-object) refuses with zero writes', () => {
  const cfg = newCfg();
  writeConfig(cfg, { agent: 'not-an-object' });
  const r = runInstall(cfg);
  assert(r.status !== 0, 'agent non-object should be rejected, got ' + r.status);
  assert(countBackups(cfg) === 0, 'no backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 0, 'no baseline, got ' + countBaselines(cfg));
});

// 7b. Explicit null agent/plugin must be rejected (frozen validation: if present,
// agent must be a plain object and plugin must be string or all-string array).
scenario('explicit null agent refuses with zero writes', () => {
  const cfg = newCfg();
  writeConfig(cfg, { agent: null });
  const r = runInstall(cfg);
  assert(r.status !== 0, 'explicit null agent should be rejected, got ' + r.status);
  assert(countBackups(cfg) === 0, 'no backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 0, 'no baseline, got ' + countBaselines(cfg));
  assert(listTree(cfg).filter((f) => f.endsWith('.md') || f.endsWith('.ts')).length === 0, 'no owned files copied on null agent');
});

scenario('explicit null plugin refuses with zero writes', () => {
  const cfg = newCfg();
  writeConfig(cfg, { plugin: null });
  const r = runInstall(cfg);
  assert(r.status !== 0, 'explicit null plugin should be rejected, got ' + r.status);
  assert(countBackups(cfg) === 0, 'no backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 0, 'no baseline, got ' + countBaselines(cfg));
  assert(listTree(cfg).filter((f) => f.endsWith('.md') || f.endsWith('.ts')).length === 0, 'no owned files copied on null plugin');
});

// 7c. Empty --config-dir value (including the empty-equals form) must be
// rejected before any write.
scenario('empty --config-dir value is rejected before writes', () => {
  // Empty string value form: `--config-dir ""`.
  const r1 = runInstall('');
  assert(r1.status !== 0, 'empty --config-dir "" should fail, got ' + r1.status);
  assert(r1.stderr.includes('config-dir'), 'error should mention config-dir, stderr=' + r1.stderr);
  // Empty equals form: `--config-dir=`.
  const r2 = runInstallArgs(['--config-dir=']);
  assert(r2.status !== 0, 'empty --config-dir= should fail, got ' + r2.status);
  assert(r2.stderr.includes('config-dir'), 'error should mention config-dir, stderr=' + r2.stderr);
});

// 8. Unknown argument rejection
scenario('unknown argument fails before any write', () => {
  const cfg = newCfg();
  const r = runInstall(cfg, ['--bogus']);
  assert(r.status !== 0, 'unknown arg should fail, got ' + r.status);
  assert(!fs.existsSync(path.join(cfg, 'opencode.json')), 'no writes on unknown arg');
  assert(countBackups(cfg) === 0, 'no backups on unknown arg, got ' + countBackups(cfg));
});

// 9. Exact equality of all 8 merged source agents
scenario('merged config contains exact 8 source agents', () => {
  const cfg = newCfg();
  const r = runInstall(cfg);
  assert(r.status === 0, 'exit 0, got ' + r.status + ' stderr=' + r.stderr);
  const installed = readJson(path.join(cfg, 'opencode.json'));
  const source = readJson(path.join(REPO_ROOT, '.config', 'opencode', 'opencode.json'));
  for (const k of SHEPHERD_AGENTS) {
    assert(deepEqual(installed.agent[k], source.agent[k]), 'agent not exactly equal to source: ' + k);
  }
});

// 10. Baseline records prior state and backup mappings
scenario('baseline records prior state and backup mappings', () => {
  const cfg = newCfg();
  fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agents', 'shepherd.md'), 'CUSTOM');
  writeConfig(cfg, { default_agent: 'other', agent: { shepherd: { model: 'custom' } }, plugin: [PLUGIN_PATH] });
  const r = runInstall(cfg, ['--force']);
  assert(r.status === 0, 'exit 0, got ' + r.status + ' stderr=' + r.stderr);
  const bl = listTree(cfg).find((f) => f.includes('shepherd-baseline-'));
  assert(bl, 'baseline should exist');
  const baseline = readJson(path.join(cfg, bl));
  assert(baseline.files['agents/shepherd.md'].existed === true, 'prior existed should be true');
  assert(typeof baseline.files['agents/shepherd.md'].backupPath === 'string', 'prior backupPath should be set');
  assert(fs.existsSync(baseline.files['agents/shepherd.md'].backupPath), 'baseline backupPath should exist');
  assert(baseline.config.backupPath && fs.existsSync(baseline.config.backupPath), 'config backupPath should exist');
  assert(baseline.config.agents.shepherd.existed === true, 'prior agent existed true');
  assert(deepEqual(baseline.config.agents.shepherd.value, { model: 'custom' }), 'prior agent value recorded');
  assert(baseline.config.defaultAgent.existed === true, 'prior default_agent existed');
  assert(baseline.config.defaultAgent.value === 'other', 'prior default_agent value');
  assert(baseline.backups.length === 2, 'should record 2 backups, got ' + baseline.backups.length);
  assert(fs.readFileSync(baseline.files['agents/shepherd.md'].backupPath, 'utf8') === 'CUSTOM', 'backup holds pre-install content');
});

// 11. Explicit --config-dir overrides OPENCODE_CONFIG_DIR; env used when no flag
scenario('explicit --config-dir overrides env; env used when no flag', () => {
  const dirA = newCfg();
  const dirB = newCfg();
  // flag wins over env
  const r1 = runInstallEnv(['--config-dir', dirB], { OPENCODE_CONFIG_DIR: dirA });
  assert(r1.status === 0, 'exit 0, got ' + r1.status + ' stderr=' + r1.stderr);
  assert(fs.existsSync(path.join(dirB, 'opencode.json')), 'should write to flag dir B');
  assert(!fs.existsSync(path.join(dirA, 'opencode.json')), 'should NOT write to env dir A when flag given');
  // env used when no flag
  const dirC = newCfg();
  const r2 = runInstallEnv([], { OPENCODE_CONFIG_DIR: dirC });
  assert(r2.status === 0, 'exit 0, got ' + r2.status + ' stderr=' + r2.stderr);
  assert(fs.existsSync(path.join(dirC, 'opencode.json')), 'should write to env dir C when no flag');
});

// 12. --dry-run reports actual would-back-up paths (no agent: labels)
scenario('--dry-run reports actual would-back-up paths (no agent: labels)', () => {
  const cfg = newCfg();
  fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agents', 'shepherd.md'), 'CUSTOM');
  writeConfig(cfg, { agent: { shepherd: { model: 'custom' } }, plugin: [PLUGIN_PATH] });
  const beforeCfg = fs.readFileSync(path.join(cfg, 'opencode.json'), 'utf8');
  const r = runInstall(cfg, ['--dry-run']);
  assert(r.status === 0, 'dry-run exit 0, got ' + r.status);
  assert(r.stdout.includes('DRY-RUN'), 'should mention DRY-RUN');
  // zero writes
  assert(fs.readFileSync(path.join(cfg, 'opencode.json'), 'utf8') === beforeCfg, 'dry-run must not modify opencode.json');
  assert(countBackups(cfg) === 0, 'dry-run no backups');
  assert(countBaselines(cfg) === 0, 'dry-run no baseline');
  assert(fs.readFileSync(path.join(cfg, 'agents', 'shepherd.md'), 'utf8') === 'CUSTOM', 'dry-run must not alter files');
  // backups section must list the real would-back-up paths, not agent: labels
  const idx = r.stdout.indexOf('Backups would be created for:');
  assert(idx >= 0, 'should have backups section');
  const section = r.stdout.slice(idx, r.stdout.indexOf('Restart', idx));
  assert(section.includes(path.join(cfg, 'agents', 'shepherd.md')), 'should list differing owned file path');
  assert(section.includes(path.join(cfg, 'opencode.json')), 'should list opencode.json path');
  assert(!section.includes('agent:'), 'agent:<name> must not be listed as a backup path');
});

// 13. Reject symlink/junction traversal (when platform permits)
scenario('rejects symlinked destination file (when permitted)', () => {
  if (!canMakeSymlink()) skip('symlinks not permitted on this platform');
  const cfg = newCfg();
  fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
  const target = path.join(cfg, 'agents', 'real.md');
  fs.writeFileSync(target, 'REAL');
  const link = path.join(cfg, 'agents', 'shepherd.md');
  fs.symlinkSync(target, link); // destination is a symlink
  const r = runInstall(cfg);
  assert(r.status !== 0, 'should reject symlinked destination, got ' + r.status);
  assert(!fs.existsSync(path.join(cfg, 'opencode.json')), 'no opencode.json on symlink rejection');
  assert(countBackups(cfg) === 0, 'no backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 0, 'no baseline, got ' + countBaselines(cfg));
  assert(fs.readFileSync(target, 'utf8') === 'REAL', 'symlink target must be untouched');
});

scenario('rejects symlinked config root (when permitted)', () => {
  if (!canMakeSymlink()) skip('symlinks not permitted on this platform');
  const real = fs.mkdtempSync(path.join(HARNESS_TMP, 'realroot-'));
  const link = fs.mkdtempSync(path.join(HARNESS_TMP, 'linkroot-'));
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(real, link);
  const r = runInstall(link);
  assert(r.status !== 0, 'should reject symlinked config root, got ' + r.status);
  assert(!fs.existsSync(path.join(real, 'opencode.json')), 'no writes through symlink');
  assert(countBackups(real) === 0, 'no backups through symlink, got ' + countBackups(real));
});

// 14. POSIX mode preservation and 0o600 for config-state (non-Windows)
scenario('POSIX mode preservation and 0o600 for config-state (non-Windows)', () => {
  if (process.platform === 'win32') skip('Windows; POSIX modes not enforced');
  // Part A: fresh install -> new opencode.json + baseline are 0o600.
  const cfgA = newCfg();
  const rA = runInstall(cfgA);
  assert(rA.status === 0, 'fresh exit 0, got ' + rA.status + ' stderr=' + rA.stderr);
  assert(modeOf(path.join(cfgA, 'opencode.json')) === 0o600, 'new opencode.json should be 0o600, got ' + modeOf(path.join(cfgA, 'opencode.json')).toString(8));
  const blA = listTree(cfgA).find((f) => f.includes('shepherd-baseline-'));
  assert(blA && modeOf(path.join(cfgA, blA)) === 0o600, 'new baseline should be 0o600');

  // Part B: replace an owned file with a custom mode; config exists with custom mode.
  const cfgB = newCfg();
  fs.mkdirSync(path.join(cfgB, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cfgB, 'agents', 'shepherd.md'), 'CUSTOM');
  fs.chmodSync(path.join(cfgB, 'agents', 'shepherd.md'), 0o640);
  writeConfig(cfgB, { default_agent: 'other', agent: { shepherd: { model: 'x' } }, plugin: [PLUGIN_PATH] });
  fs.chmodSync(path.join(cfgB, 'opencode.json'), 0o600);
  const rB = runInstall(cfgB, ['--force']);
  assert(rB.status === 0, 'force exit 0, got ' + rB.status + ' stderr=' + rB.stderr);
  assert(modeOf(path.join(cfgB, 'agents', 'shepherd.md')) === 0o640, 'replaced owned file mode should be preserved (0o640), got ' + modeOf(path.join(cfgB, 'agents', 'shepherd.md')).toString(8));
  assert(modeOf(path.join(cfgB, 'opencode.json')) === 0o600, 'replaced config mode should be preserved (0o600)');
  const bak = findBackupWithContent(cfgB, 'CUSTOM');
  assert(bak && modeOf(path.join(cfgB, bak)) === 0o600, 'owned-file backup should be 0o600');
  const blB = listTree(cfgB).find((f) => f.includes('shepherd-baseline-'));
  assert(blB && modeOf(path.join(cfgB, blB)) === 0o600, 'baseline should be 0o600');
});

// 15. Refuses when the install lock already exists
scenario('refuses when install lock already exists', () => {
  const cfg = newCfg();
  fs.writeFileSync(path.join(cfg, '.shepherd-install.lock'), '');
  const r = runInstall(cfg);
  assert(r.status !== 0, 'should abort when lock exists, got ' + r.status);
  assert(!fs.existsSync(path.join(cfg, 'opencode.json')), 'no opencode.json on lock refusal');
  assert(countBackups(cfg) === 0, 'no backups, got ' + countBackups(cfg));
  assert(countBaselines(cfg) === 0, 'no baseline, got ' + countBaselines(cfg));
  assert(fs.existsSync(path.join(cfg, '.shepherd-install.lock')), 'pre-existing lock must not be removed by installer');
});

// 15b. Reject an existing non-directory config root (never write through it)
scenario('rejects an existing non-directory config root', () => {
  const parent = newCfg();
  const cfgFile = path.join(parent, 'notadir');
  fs.writeFileSync(cfgFile, 'i am a file');
  const r = runInstall(cfgFile);
  assert(r.status !== 0, 'should reject non-directory root, got ' + r.status);
  assert(countBackups(parent) === 0, 'no backups, got ' + countBackups(parent));
  assert(countBaselines(parent) === 0, 'no baseline, got ' + countBaselines(parent));
});

// 15c. Reject a not-yet-created root whose nearest existing ancestor is a
// symlink/junction (never write through it). Conditional on symlink support.
scenario('rejects config root whose ancestor is a symlink (when permitted)', () => {
  if (!canMakeSymlink()) skip('symlinks not permitted');
  const base = fs.mkdtempSync(path.join(HARNESS_TMP, 'ancestor-'));
  const link = path.join(base, 'link');
  fs.symlinkSync(base, link); // link -> base (a directory)
  const cfg = path.join(link, 'nested', 'config'); // nearest existing ancestor is the symlink `link`
  const r = runInstall(cfg);
  assert(r.status !== 0, 'should reject symlinked ancestor, got ' + r.status);
  assert(!fs.existsSync(path.join(cfg, 'opencode.json')), 'no writes through symlink ancestor');
});

// 16. Deterministic failure injection proves safe rollback (test env only)
scenario('failure injection triggers safe rollback (test env only)', () => {
  const cfg = newCfg();
  // 3 replaced owned files (custom content) + 8 new owned files + existing config.
  const replacedRels = ['agents/shepherd.md', 'agents/sheep-fast.md', 'command/herd.md'];
  for (const rel of replacedRels) {
    const d = path.join(cfg, path.dirname(rel));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), 'CUSTOM-' + rel);
  }
  writeConfig(cfg, {
    default_agent: 'other',
    agent: { shepherd: { model: 'custom-model' } },
    plugin: ['./plugin/other.ts'],
  });
  const origCfg = fs.readFileSync(path.join(cfg, 'opencode.json'), 'utf8');
  // Capture prior modes of replaced files (non-Windows mode assertion later).
  const priorModes = {};
  if (process.platform !== 'win32') {
    for (const rel of replacedRels) priorModes[rel] = modeOf(path.join(cfg, rel));
  }
  // Total committed writes = 11 owned + 1 config + 1 baseline = 13.
  const N = 13;
  const env = { NODE_ENV: 'test', SHEPHERD_INSTALL_TEST_FAIL_AFTER: String(N) };
  const r = runInstallEnv(['--config-dir', cfg, '--force'], env);
  assert(r.status !== 0, 'injected failure should exit nonzero, got ' + r.status + ' stderr=' + r.stderr);

  // Replaced owned files restored to original custom content; backups remain.
  for (const rel of replacedRels) {
    const dest = path.join(cfg, rel);
    assert(fs.readFileSync(dest, 'utf8') === 'CUSTOM-' + rel, 'replaced file should be restored: ' + rel);
    assert(findBackupWithContent(cfg, 'CUSTOM-' + rel) !== null, 'backup should remain for: ' + rel);
    if (process.platform !== 'win32') {
      assert(modeOf(dest) === priorModes[rel], 'restored file should keep original mode: ' + rel + ' got ' + modeOf(dest).toString(8) + ' want ' + priorModes[rel].toString(8));
    }
  }
  // New owned files removed.
  for (const rel of OWNED_FILES) {
    if (!replacedRels.includes(rel)) {
      assert(!fs.existsSync(path.join(cfg, rel)), 'new owned file should be removed: ' + rel);
    }
  }
  // Config restored to original; its backup remains.
  assert(fs.readFileSync(path.join(cfg, 'opencode.json'), 'utf8') === origCfg, 'config should be restored');
  assert(findBackupWithContent(cfg, origCfg) !== null, 'config backup should remain');
  // Baseline removed; lock and temps cleaned; backups preserved (3 + 1).
  assert(countBaselines(cfg) === 0, 'baseline must not remain after rollback, got ' + countBaselines(cfg));
  assert(!fs.existsSync(path.join(cfg, '.shepherd-install.lock')), 'lock must be removed after rollback');
  assert(countTemps(cfg) === 0, 'temps must be cleaned, got ' + countTemps(cfg));
  assert(countBackups(cfg) === replacedRels.length + 1, 'backups preserved (replaced + config), got ' + countBackups(cfg));
});

// 17. Symlink ancestor with an existing descendant beneath the symlink target
// (conditional on symlink support). The ancestor walk must reject even when a
// real descendant exists under the symlink target.
scenario('rejects symlink ancestor with existing descendant (when permitted)', () => {
  if (!canMakeSymlink()) skip('symlinks not permitted');
  const base = fs.mkdtempSync(path.join(HARNESS_TMP, 'anc-'));
  const real = path.join(base, 'real');
  fs.mkdirSync(real, { recursive: true });
  fs.mkdirSync(path.join(real, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(real, 'nested', 'desc.txt'), 'descendant'); // existing descendant
  const link = path.join(base, 'link'); // link -> real
  fs.symlinkSync(real, link);
  const cfg = path.join(link, 'nested', 'config'); // ancestor chain includes the symlink `link`
  const r = runInstall(cfg);
  assert(r.status !== 0, 'should reject symlinked ancestor with descendant, got ' + r.status + ' stderr=' + r.stderr);
  assert(!fs.existsSync(path.join(cfg, 'opencode.json')), 'no writes through symlink ancestor');
  assert(fs.readFileSync(path.join(real, 'nested', 'desc.txt'), 'utf8') === 'descendant', 'descendant under symlink target must be untouched');
});

// 18. Raced-in NEW file is never overwritten (deterministic test hook, production inert)
scenario('raced-in new file is not overwritten (test hook)', () => {
  const cfg = newCfg();
  const racedPath = path.join(cfg, 'agents', 'shepherd.md'); // first NEW destination in a fresh install
  const env = { NODE_ENV: 'test', SHEPHERD_INSTALL_TEST_RACE_NEW: racedPath };
  const r = runInstallEnv(['--config-dir', cfg], env);
  assert(r.status !== 0, 'install should abort on raced-in new file, got ' + r.status + ' stderr=' + r.stderr);
  assert(fs.existsSync(racedPath), 'raced-in file should exist');
  assert(fs.readFileSync(racedPath, 'utf8') === 'RACED-IN-CONTENT', 'raced-in file must NOT be overwritten with source content');
  assert(!fs.existsSync(path.join(cfg, 'opencode.json')), 'no opencode.json on aborted install');
  assert(!fs.existsSync(path.join(cfg, 'agents', 'sheep-cheap.md')), 'no other owned file written on abort');
  assert(!fs.existsSync(path.join(cfg, '.shepherd-install.lock')), 'lock must be released after abort');
});

// 19. Generated artifact collision aborts rather than overwrites (deterministic
// test hook for the random name fragment, production inert)
scenario('artifact name collision aborts rather than overwrites (test hook)', () => {
  const cfg = newCfg();
  fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'agents', 'shepherd.md'), 'CUSTOM'); // makes it a replace -> backup created
  const collideName = 'agents/shepherd.md.shepherd-backup-COLLIDE';
  fs.writeFileSync(path.join(cfg, collideName), 'PROTECTED'); // pre-existing artifact with the forced name
  const env = { NODE_ENV: 'test', SHEPHERD_INSTALL_TEST_FIXED_NAME: 'COLLIDE' };
  const r = runInstallEnv(['--config-dir', cfg, '--force'], env);
  assert(r.status !== 0, 'install should abort on artifact collision, got ' + r.status + ' stderr=' + r.stderr);
  assert(fs.readFileSync(path.join(cfg, collideName), 'utf8') === 'PROTECTED', 'pre-existing artifact must NOT be overwritten');
  assert(!fs.existsSync(path.join(cfg, 'opencode.json')), 'no opencode.json on aborted install');
  assert(!fs.existsSync(path.join(cfg, '.shepherd-install.lock')), 'lock must be released after abort');
});

// 20. Production-mode failure hooks are inert (NODE_ENV !== 'test')
scenario('failure hooks are inert unless NODE_ENV=test', () => {
  const cfg = newCfg();
  const racedPath = path.join(cfg, 'agents', 'shepherd.md');
  // Hooks are set but NODE_ENV is NOT 'test' -> they must not activate.
  const env = {
    NODE_ENV: 'production',
    SHEPHERD_INSTALL_TEST_RACE_NEW: racedPath,
    SHEPHERD_INSTALL_TEST_FIXED_NAME: 'COLLIDE',
  };
  const r = runInstallEnv(['--config-dir', cfg], env);
  assert(r.status === 0, 'install should succeed with inert hooks, got ' + r.status + ' stderr=' + r.stderr);
  verifyOwnedFilesCopied(cfg);
  verifyMergedConfig(cfg);
  assert(!fs.existsSync(racedPath) || fs.readFileSync(racedPath, 'utf8') !== 'RACED-IN-CONTENT', 'race hook must not activate outside NODE_ENV=test');
});

// 21. Own `__proto__` top-level key is preserved by the property-safe merge
scenario('own __proto__ top-level key is preserved (test hook)', () => {
  const cfg = newCfg();
  const env = { NODE_ENV: 'test', SHEPHERD_INSTALL_TEST_PROTO: '1' };
  const r = runInstallEnv(['--config-dir', cfg], env);
  assert(r.status === 0, 'install should succeed, got ' + r.status + ' stderr=' + r.stderr);
  verifyOwnedFilesCopied(cfg);
  const raw = fs.readFileSync(path.join(cfg, 'opencode.json'), 'utf8');
  assert(raw.includes('"__proto__"'), 'merged opencode.json should contain an own __proto__ key');
  assert(raw.includes('"preserved":true') || raw.includes('"preserved": true'), 'own __proto__ value should be preserved');
});

// 22. Successful lock absence and ownership-safe cleanup
scenario('successful lock absence and ownership-safe cleanup', () => {
  // Part A: after a successful install the lock must be absent.
  const cfgA = newCfg();
  const rA = runInstall(cfgA);
  assert(rA.status === 0, 'fresh install exit 0, got ' + rA.status + ' stderr=' + rA.stderr);
  assert(!fs.existsSync(path.join(cfgA, '.shepherd-install.lock')), 'lock must be removed after successful install');

  // Part B: a pre-existing lock with a FOREIGN nonce must never be removed.
  const cfgB = newCfg();
  fs.writeFileSync(path.join(cfgB, '.shepherd-install.lock'), 'foreign-nonce-xyz');
  const rB = runInstall(cfgB);
  assert(rB.status !== 0, 'should abort when a foreign lock exists, got ' + rB.status);
  const lockContent = fs.readFileSync(path.join(cfgB, '.shepherd-install.lock'), 'utf8');
  assert(lockContent === 'foreign-nonce-xyz', 'pre-existing foreign lock must NOT be removed by installer');
  assert(!fs.existsSync(path.join(cfgB, 'opencode.json')), 'no writes when foreign lock present');
});

// ---- run all ----
let pass = 0;
let skipCount = 0;
let failCount = 0;
const failed = [];
for (const s of scenarios) {
  try {
    s.fn();
    pass++;
    process.stdout.write('PASS  ' + s.name + '\n');
  } catch (e) {
    if (e && e.__skip) {
      skipCount++;
      process.stdout.write('SKIP  ' + s.name + (e.message ? ' (' + e.message + ')' : '') + '\n');
    } else {
      failCount++;
      failed.push(s.name);
      process.stdout.write('FAIL  ' + s.name + '\n      ' + (e && e.message ? e.message : String(e)) + '\n');
    }
  }
}

process.stdout.write('\n' + pass + ' passed, ' + skipCount + ' skipped, ' + failCount + ' failed.\n');
try { fs.rmSync(HARNESS_TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
process.exit(failCount ? 1 : 0);
