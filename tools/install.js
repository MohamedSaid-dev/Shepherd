#!/usr/bin/env node
'use strict';

/*
 * Shepherd installer (dependency-free CommonJS).
 *
 * Usage:
 *   node tools/install.js [--config-dir <absolute-or-relative-path>] [--force] [--dry-run]
 *
 * Default config root resolution (flag wins over env wins over built-in):
 *   --config-dir <v>  >  OPENCODE_CONFIG_DIR env (if set)  >  ~/.config/opencode
 *
 * The source bundle is always resolved relative to this repo (never cwd).
 * The installer merges opencode.json (never overwrites) and copies the exact
 * 11 owned files. Conflicts (differing owned files or differing Shepherd agent
 * entries) abort before any write unless --force is given. --dry-run reports
 * intended actions with zero writes.
 *
 * Safety model (race-hardened, dependency-free Node APIs only):
 *  - Directories are created with fs.mkdirSync(dir,{recursive:true,mode:0o700})
 *    using an extended/UNC-safe path on Windows to avoid MAX_PATH limits.
 *  - A root-aware ancestor walk (from path.parse(root) up to the config dir)
 *    lstats EVERY existing component and rejects any symlink/junction or
 *    non-directory, including an existing descendant beneath a symlink target.
 *    Parent/destination validation is re-run immediately before each write and
 *    each rollback action.
 *  - Every destination (including initially absent ones) is snapshotted as
 *    {exists, symlink, dev, ino, size, hash}. Under the owned lock and
 *    immediately before each commit we require the snapshot identity AND
 *    content/existence to be unchanged since lock time.
 *  - Initially absent destinations are created exclusively with `wx`, so they
 *    can NEVER overwrite a file that raced in. Existing replacements use a
 *    same-directory exclusive temp + rename after an identity recheck.
 *  - Exclusive artifacts (temps, backups, baseline, lock, new config, new owned
 *    files) are opened with `wx` and their intended mode on open
 *    (config-state 0o600, new owned 0o644). We never write permissive then
 *    chmod. Backups use exclusive random paths and are verified. The baseline is
 *    created exclusively (no overwrite). fsync is performed before close where
 *    practical.
 *  - Cooperative same-root locking (.shepherd-install.lock) is acquired only
 *    after validation/conflict/no-op determination, holding the lock fd for the
 *    install (closed before release so it never blocks our own unlink). The lock
 *    carries a random nonce; on success/rollback we close then remove it ONLY if
 *    it is still a regular file with the same dev/ino identity AND nonce. A
 *    pre-existing/replaced lock is never removed. Failure to release is reported,
 *    never silently ignored.
 *  - Rollback captures the resulting dev/ino/hash of every committed artifact.
 *    Before restore/delete it re-validates ancestor safety and requires the
 *    EXACT installed identity+hash (not content alone). Replacements are restored
 *    through an exclusive temp + rename; a vanished target is restored from its
 *    backup via an exclusive new create. Prior mode is preserved. If identity
 *    differs, a conflict is reported and nothing is done.
 *
 * Residual limitations (documented, not hidden):
 *  - Non-cooperative race: between the final identity recheck and the
 *    rename/unlink, a malicious or non-cooperative concurrent process could swap
 *    the destination. Node's fs API provides no stronger atomic compare-and-swap
 *    than this check-then-act; we acknowledge this irreducible window.
 *  - Windows ACL inheritance: POSIX modes are set at creation (0o600/0o700) but
 *    parent ACL inheritance is not controlled; we do not promise ACL
 *    preservation (cooperative, best-effort only).
 *  - POSIX runtime skipped here: this build is exercised on Windows; POSIX-mode
 *    assertions are validated only where the platform permits.
 *  - We make NO claim of universal/atomic locking across all filesystems.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(REPO_ROOT, '.config', 'opencode');

// The exact 11 copied files (relative to both SOURCE_ROOT and the config root).
const OWNED_FILES = [
  'agents/shepherd.md',
  'agents/sheep-cheap.md',
  'agents/sheep-fast.md',
  'agents/sheep-ui.md',
  'agents/sheep-test.md',
  'agents/sheep-search.md',
  'agents/sheep-review.md',
  'agents/sheep-docs.md',
  'command/sheeps-models.md',
  'command/herd.md',
  'plugin/shepherd.ts',
];

// The exact 8 Shepherd agent keys replaced from source.
const SHEPHERD_AGENTS = [
  'shepherd', 'sheep-cheap', 'sheep-fast', 'sheep-ui',
  'sheep-test', 'sheep-search', 'sheep-review', 'sheep-docs',
];

const PLUGIN_PATH = './plugin/shepherd.ts';
const BASELINE_PREFIX = 'shepherd-baseline-';
const LOCK_NAME = '.shepherd-install.lock';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Property-safe copy that preserves own `__proto__` JSON keys (Object.assign /
// spread would treat `__proto__` as a prototype setter, not an own key).
function copyOwnProps(dest, src) {
  const keys = Object.keys(src);
  for (const k of keys) {
    Object.defineProperty(dest, k, {
      value: src[k], writable: true, enumerable: true, configurable: true,
    });
  }
  return dest;
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

function fail(msg, code) {
  process.stderr.write('shepherd-install: ' + msg + '\n');
  process.exit(typeof code === 'number' ? code : 1);
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function safeRead(p) {
  try { return fs.readFileSync(p); } catch (e) { return null; }
}
function hashBuf(b) {
  return crypto.createHash('sha256').update(b).digest('hex');
}

// Extended/UNC-safe path for syscalls that create/open files or directories on
// Windows (avoids MAX_PATH and special-character pitfalls). No-op elsewhere.
function ep(p) {
  if (process.platform !== 'win32') return p;
  const r = path.resolve(p);
  if (r.startsWith('\\\\?\\')) return r;
  if (r.startsWith('\\\\')) return '\\\\?\\UNC\\' + r.slice(2);
  return '\\\\?\\' + r;
}

// Deterministic, injectable name fragment. Under NODE_ENV=test with
// SHEPHERD_INSTALL_TEST_FIXED_NAME set, every generated artifact name uses that
// fixed fragment so a collision can be forced deterministically. Production is
// unaffected (the env var is only honored under NODE_ENV=test).
function rand() {
  if (process.env.NODE_ENV === 'test' && process.env.SHEPHERD_INSTALL_TEST_FIXED_NAME) {
    return String(process.env.SHEPHERD_INSTALL_TEST_FIXED_NAME);
  }
  return crypto.randomBytes(12).toString('hex') + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Snapshots and identity
// ---------------------------------------------------------------------------

// Snapshot a destination with full identity: {exists, symlink, dev, ino, size, hash}.
// Absent paths yield {exists:false, symlink:false, dev:null, ino:null, size:null, hash:null}.
function snapshot(p) {
  const st = lstatOrNull(p);
  if (!st) return { exists: false, symlink: false, dev: null, ino: null, size: null, hash: null };
  if (st.isSymbolicLink()) {
    return { exists: true, symlink: true, dev: st.dev, ino: st.ino, size: st.size, hash: null };
  }
  let hash = null;
  try { hash = hashBuf(fs.readFileSync(p)); } catch (_) { /* unreadable */ }
  return { exists: true, symlink: false, dev: st.dev, ino: st.ino, size: st.size, hash };
}

// True only if identity (dev/ino) and content/existence are unchanged.
function identityUnchanged(before, after) {
  if (!before || !after) return false;
  if (before.exists !== after.exists) return false;
  if (before.symlink !== after.symlink) return false;
  if (before.exists) {
    if (before.dev !== after.dev || before.ino !== after.ino) return false;
    if (before.hash !== after.hash) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Exclusive file creation (wx + mode on open, fsync before close)
// ---------------------------------------------------------------------------

function createExclusiveFile(p, content, mode) {
  const fd = fs.openSync(ep(p), 'wx', mode);
  try {
    fs.writeSync(fd, content);
    try { fs.fsyncSync(fd); } catch (_) { /* best-effort */ }
  } finally {
    fs.closeSync(fd);
  }
}

function mkdirSafe(dir) {
  fs.mkdirSync(ep(dir), { recursive: true, mode: 0o700 });
}

function renameSafe(a, b) {
  fs.renameSync(ep(a), ep(b));
}

// ---------------------------------------------------------------------------
// Validation: ancestor walk + per-destination parent/destination checks
// ---------------------------------------------------------------------------

// Root-aware ancestor walk: from path.parse(resolved).root up to configDir,
// lstat EVERY existing component and reject any symlink/junction or
// non-directory (including an existing descendant beneath a symlink target).
function validateAncestors(configDir) {
  const resolved = path.resolve(configDir);
  const root = path.parse(resolved).root;
  const rel = path.relative(root, resolved);
  const comps = rel.split(path.sep).filter(Boolean);
  let cur = root;
  const chain = [cur];
  for (const c of comps) {
    cur = path.join(cur, c);
    chain.push(cur);
  }
  for (const c of chain) {
    const st = lstatOrNull(c);
    if (!st) continue; // not yet created; will be made by mkdirSafe
    if (st.isSymbolicLink()) fail('Path component is a symlink/junction: ' + c);
    if (!st.isDirectory()) fail('Path component is not a directory: ' + c);
  }
}

// Reject symlink/junction parent components and a symlinked destination, and
// enforce lexical containment beneath the config root. Re-run immediately before
// each write and each rollback action.
function validateDestParent(dest, configDir) {
  const rel = path.relative(configDir, dest);
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = configDir;
  for (let i = 0; i < parts.length - 1; i++) { // all but the final filename
    cur = path.join(cur, parts[i]);
    const st = lstatOrNull(cur);
    if (!st) continue; // will be created by mkdirSafe
    if (st.isSymbolicLink()) fail('Parent component is a symlink/junction: ' + cur);
    if (!st.isDirectory()) fail('Parent component is not a directory: ' + cur);
  }
  const dl = lstatOrNull(dest);
  if (dl && dl.isSymbolicLink()) fail('Destination is a symlink/junction: ' + dest);
}

function assertContained(dest, configDir) {
  const dResolved = path.resolve(dest);
  const rResolved = path.resolve(configDir);
  if (dResolved !== rResolved && !dResolved.startsWith(rResolved + path.sep)) {
    fail('Destination escapes config root: ' + dest);
  }
}

// ---------------------------------------------------------------------------
// Lock ownership
// ---------------------------------------------------------------------------

function acquireLock(lockPath) {
  const nonce = crypto.randomBytes(16).toString('hex');
  let fd;
  try {
    fd = fs.openSync(ep(lockPath), 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') fail('Install lock already present; aborting: ' + lockPath);
    throw e;
  }
  try {
    fs.writeSync(fd, nonce);
    try { fs.fsyncSync(fd); } catch (_) { /* best-effort */ }
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    throw e;
  }
  // Capture identity (dev/ino) for safe release verification.
  const snap = snapshot(lockPath);
  // NOTE: we hold the fd for the duration of the install. On Windows the fd is
  // closed before we unlink the lock, so holding never blocks our own release
  // (same-root only). If holding ever prevented a needed operation we would
  // release it; here it only provides cooperative exclusion.
  return { fd, nonce, snap };
}

// Close the lock fd, then remove the lock ONLY if it is still a regular file
// with the same dev/ino identity AND nonce. Returns a list of issues; an empty
// list means a clean release. Failure to release is reported, never ignored.
function safeLockRelease(lockPath, lock) {
  const issues = [];
  if (lock && lock.fd !== null && lock.fd !== undefined) {
    try { fs.closeSync(lock.fd); } catch (e) { issues.push('lock close failed: ' + (e.message || String(e))); }
  }
  if (lock && lock.nonce && lock.snap) {
    const cur = snapshot(lockPath);
    if (cur.exists && !cur.symlink) {
      const content = safeRead(lockPath);
      const nonceOk = !!content && content.toString('utf8') === lock.nonce;
      const identOk = cur.dev === lock.snap.dev && cur.ino === lock.snap.ino;
      if (nonceOk && identOk) {
        try { fs.unlinkSync(lockPath); }
        catch (e) { issues.push('lock remove failed: ' + (e.message || String(e))); }
      } else {
        issues.push('lock identity/nonce mismatch; not removing foreign lock');
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Test hooks (ALL inert unless NODE_ENV === 'test')
// ---------------------------------------------------------------------------

// Simulate a non-cooperative process racing in a NEW (initially absent)
// destination just before our exclusive create. Production-inert.
function maybeRaceNew(dest) {
  if (process.env.NODE_ENV !== 'test') return;
  const v = process.env.SHEPHERD_INSTALL_TEST_RACE_NEW;
  if (!v) return;
  if (path.resolve(dest) === path.resolve(v)) {
    // External-style race: create the file now so our `wx` open fails (EEXIST).
    fs.writeFileSync(dest, 'RACED-IN-CONTENT');
  }
}

// Inject an own `__proto__` key into the parsed target root to prove the merge
// preserves property-safe own `__proto__` keys. Production-inert.
function maybeInjectProto(targetRoot) {
  if (process.env.NODE_ENV !== 'test') return;
  if (!process.env.SHEPHERD_INSTALL_TEST_PROTO) return;
  Object.defineProperty(targetRoot, '__proto__', {
    value: { preserved: true }, enumerable: true, configurable: true,
  });
}

// Deterministic failure injection, ONLY enabled by an undocumented test env var
// and only when NODE_ENV=test. Triggers after N committed writes so the test
// harness can prove rollback behavior. Production is unaffected.
function maybeInjectFailure(committed) {
  if (process.env.NODE_ENV !== 'test') return;
  const v = process.env.SHEPHERD_INSTALL_TEST_FAIL_AFTER;
  if (v === undefined) return;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return;
  if (committed.length >= n) {
    throw new Error('INJECTED_FAILURE_AFTER_' + n + '_COMMITTED_WRITES');
  }
}

// ---------------------------------------------------------------------------
// Writes (each re-validates ancestors/destination and checks identity)
// ---------------------------------------------------------------------------

// Create an initially-absent destination exclusively (wx). Never overwrites a
// raced-in file. Records the resulting identity in `committed`.
function writeNew(dest, content, mode, lockSnap, committed, configDir) {
  validateDestParent(dest, configDir);
  assertContained(dest, configDir);
  const now = snapshot(dest);
  if (!identityUnchanged(lockSnap.get(dest), now)) {
    throw new Error('Stale/raced destination detected before create: ' + dest);
  }
  maybeRaceNew(dest); // test hook (production inert)
  createExclusiveFile(dest, content, mode); // wx: never overwrites a raced-in file
  const after = snapshot(dest);
  committed.push({ path: dest, type: 'new', dev: after.dev, ino: after.ino, hash: after.hash });
}

// Replace an existing destination via an exclusive same-dir temp + rename, after
// re-checking identity immediately before the rename. Records resulting identity.
function writeReplace(dest, content, priorMode, lockSnap, committed, configDir, backupPath) {
  validateDestParent(dest, configDir);
  assertContained(dest, configDir);
  const now = snapshot(dest);
  if (!identityUnchanged(lockSnap.get(dest), now)) {
    throw new Error('Stale destination detected before replace: ' + dest);
  }
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  const tmp = path.join(dir, base + '.shepherd-tmp-' + rand());
  const tmpMode = (priorMode !== null && priorMode !== undefined) ? priorMode : 0o600;
  createExclusiveFile(tmp, content, tmpMode);
  // Recheck identity immediately before rename. The window between this check
  // and rename is the irreducible non-cooperative race (documented residual).
  const pre = snapshot(dest);
  if (!identityUnchanged(lockSnap.get(dest), pre)) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw new Error('Stale destination detected before rename: ' + dest);
  }
  renameSafe(tmp, dest);
  const after = snapshot(dest);
  committed.push({
    path: dest, type: 'replace', dev: after.dev, ino: after.ino, hash: after.hash,
    priorMode, backupPath,
  });
}

// Exclusive, verified backup of an existing file.
function backupFile(filePath, backups) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const bak = path.join(dir, base + '.shepherd-backup-' + rand());
  createExclusiveFile(bak, fs.readFileSync(filePath), 0o600);
  fs.accessSync(bak, fs.constants.R_OK); // verify backup readable
  backups.push(bak);
  return bak;
}

// ---------------------------------------------------------------------------
// Rollback (identity-based)
// ---------------------------------------------------------------------------

// Rollback every committed artifact in reverse. Never overwrites/removes a path
// whose identity differs from what this invocation committed. Always removes
// lock/temp best-effort. Backups are preserved.
function doRollback(committed, tempFiles, lockPath, lock, configDir) {
  const errors = [];
  // Re-validate ancestor safety once for the whole rollback.
  try { validateAncestors(configDir); } catch (e) { errors.push('ancestor safety: ' + e.message); }
  for (let i = committed.length - 1; i >= 0; i--) {
    const c = committed[i];
    try {
      validateDestParent(c.path, configDir);
      assertContained(c.path, configDir);
      const cur = snapshot(c.path);
      if (c.type === 'replace') {
        if (!cur.exists) {
          // Vanished: restore backup via exclusive new create (no overwrite).
          if (c.backupPath && fs.existsSync(c.backupPath)) {
            const mode = (c.priorMode !== null && c.priorMode !== undefined) ? c.priorMode : 0o600;
            createExclusiveFile(c.path, fs.readFileSync(c.backupPath), mode);
          } else {
            errors.push('backup missing for ' + c.path + '; cannot restore');
          }
        } else if (cur.symlink) {
          errors.push('rollback conflict: ' + c.path + ' is now a symlink; not overwriting');
        } else if (cur.dev === c.dev && cur.ino === c.ino && cur.hash === c.hash) {
          // Exact installed identity+hash: safe to restore from backup.
          const dir = path.dirname(c.path);
          const base = path.basename(c.path);
          const tmp = path.join(dir, base + '.shepherd-tmp-' + rand());
          const mode = (c.priorMode !== null && c.priorMode !== undefined) ? c.priorMode : 0o600;
          createExclusiveFile(tmp, fs.readFileSync(c.backupPath), mode);
          renameSafe(tmp, c.path);
        } else {
          errors.push('rollback conflict: ' + c.path + ' identity changed; not overwriting');
        }
      } else { // 'new'
        if (!cur.exists) { /* already gone */ }
        else if (cur.symlink) {
          errors.push('rollback conflict: ' + c.path + ' is now a symlink; not removing');
        } else if (cur.dev === c.dev && cur.ino === c.ino && cur.hash === c.hash) {
          fs.unlinkSync(c.path);
        } else {
          errors.push('rollback conflict: ' + c.path + ' identity changed; not removing');
        }
      }
    } catch (e) {
      errors.push('rollback error on ' + c.path + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  // Best-effort cleanup of temps; backups are intentionally preserved.
  for (const t of tempFiles) { try { fs.unlinkSync(t); } catch (_) { /* ignore */ } }
  return errors;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { configDir: null, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') {
      out.force = true;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--config-dir') {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) fail('Missing or empty value for --config-dir');
      out.configDir = v;
      i++;
    } else if (a.startsWith('--config-dir=')) {
      const v = a.slice('--config-dir='.length);
      if (v === '') fail('Missing or empty value for --config-dir');
      out.configDir = v;
    } else {
      fail('Unknown argument: ' + a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printDryRun(ctx) {
  const out = [];
  out.push('Shepherd install [DRY-RUN] — no writes performed.');
  out.push('Config root: ' + ctx.configDir);
  out.push('Source bundle: ' + ctx.sourceRoot);
  out.push('Owned files (11):');
  for (const rel of OWNED_FILES) out.push('  ' + rel + ' -> ' + ctx.fileStatus[rel]);
  out.push('opencode.json merge:');
  out.push('  default_agent = "shepherd"');
  out.push('  8 Shepherd agent entries replaced from source');
  out.push('  plugin normalized to array; ' + PLUGIN_PATH + ' appended/deduped');
  if (ctx.conflicts.length > 0) {
    out.push('Conflicts that would block without --force:');
    for (const c of ctx.conflicts) out.push('  - ' + c);
  } else {
    out.push('No conflicts.');
  }
  if (ctx.wouldBackup.length > 0) {
    out.push('Backups would be created for:');
    for (const p of ctx.wouldBackup) out.push('  - ' + p);
  } else {
    out.push('Backups would be created for: none');
  }
  out.push('Restart OpenCode to load new agents and plugin (after a real run).');
  process.stdout.write(out.join('\n') + '\n');
}

function printSummary(ctx) {
  const out = [];
  out.push('Shepherd install complete.');
  out.push('Config root: ' + ctx.configDir);
  let nNew = 0, nReplace = 0, nUnchanged = 0;
  for (const rel of OWNED_FILES) {
    if (ctx.fileStatus[rel] === 'new') nNew++;
    else if (ctx.fileStatus[rel] === 'replace') nReplace++;
    else nUnchanged++;
  }
  out.push('Owned files: ' + OWNED_FILES.length + ' total — ' +
    nNew + ' new, ' + nReplace + ' replaced (backed up), ' + nUnchanged + ' unchanged.');
  out.push('opencode.json: ' + (ctx.willWriteConfig
    ? (ctx.targetExists ? 'merged (existing config backed up)' : 'created')
    : 'already up to date (no change)'));
  if (ctx.backups.length) out.push('Backups: ' + ctx.backups.join(', '));
  else out.push('Backups: none');
  out.push('Baseline: ' + ctx.baselinePath);
  out.push('Restart OpenCode to load the new agents and plugin.');
  process.stdout.write(out.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  // ---- Config root resolution: flag > env > built-in ----
  let configDir;
  if (args.configDir) configDir = path.resolve(args.configDir);
  else if (process.env.OPENCODE_CONFIG_DIR) configDir = path.resolve(process.env.OPENCODE_CONFIG_DIR);
  else configDir = path.join(os.homedir(), '.config', 'opencode');

  // ---- Phase A: reads, validation, conflict analysis, merged computation ----
  const sourceConfigPath = path.join(SOURCE_ROOT, 'opencode.json');
  let sourceRoot;
  try {
    sourceRoot = JSON.parse(fs.readFileSync(sourceConfigPath, 'utf8'));
  } catch (e) {
    fail('Cannot read/parse source opencode.json: ' + e.message);
  }
  if (!isPlainObject(sourceRoot)) fail('Source opencode.json root is not a plain object');
  if (!isPlainObject(sourceRoot.agent)) fail('Source opencode.json agent is not a plain object');
  for (const k of SHEPHERD_AGENTS) {
    if (!Object.prototype.hasOwnProperty.call(sourceRoot.agent, k)) fail('Source agent missing: ' + k);
    if (!isPlainObject(sourceRoot.agent[k])) fail('Source agent value not an object: ' + k);
  }

  const targetConfigPath = path.join(configDir, 'opencode.json');
  let targetRoot = {};
  let targetExists = false;
  if (fs.existsSync(targetConfigPath)) {
    targetExists = true;
    let raw;
    try { raw = fs.readFileSync(targetConfigPath, 'utf8'); }
    catch (e) { fail('Cannot read target opencode.json: ' + e.message); }
    try { targetRoot = JSON.parse(raw); }
    catch (e) { fail('Target opencode.json is invalid JSON: ' + e.message); }
    if (!isPlainObject(targetRoot)) fail('Target opencode.json root is not a plain object');
    if (targetRoot.agent !== undefined && !isPlainObject(targetRoot.agent))
      fail('Target opencode.json agent is not a plain object');
    if (targetRoot.plugin !== undefined) {
      const pl = targetRoot.plugin;
      if (pl === null) fail('Target opencode.json plugin is explicitly null');
      else if (typeof pl === 'string') { /* ok */ }
      else if (Array.isArray(pl)) {
        if (!pl.every((x) => typeof x === 'string')) fail('Target opencode.json plugin array contains a non-string');
      } else {
        fail('Target opencode.json plugin is neither string nor array');
      }
    }
  }

  // Test hook: inject an own `__proto__` key to prove property-safe merge.
  maybeInjectProto(targetRoot);

  // Build merged config in memory (preserve unrelated top-level keys/agents).
  const merged = copyOwnProps({}, targetRoot);
  merged.default_agent = 'shepherd';
  const mergedAgent = copyOwnProps({}, isPlainObject(targetRoot.agent) ? targetRoot.agent : {});
  for (const k of SHEPHERD_AGENTS) {
    mergedAgent[k] = JSON.parse(JSON.stringify(sourceRoot.agent[k]));
  }
  merged.agent = mergedAgent;
  let plugin;
  if (typeof targetRoot.plugin === 'string') plugin = [targetRoot.plugin];
  else if (Array.isArray(targetRoot.plugin)) plugin = targetRoot.plugin.slice();
  else plugin = [];
  if (!plugin.includes(PLUGIN_PATH)) plugin.push(PLUGIN_PATH);
  merged.plugin = plugin;

  // Owned file analysis + conflict detection.
  const fileStatus = {}; // rel -> 'new' | 'replace' | 'unchanged'
  const conflicts = [];
  for (const rel of OWNED_FILES) {
    const src = path.join(SOURCE_ROOT, rel);
    let srcContent;
    try { srcContent = fs.readFileSync(src); }
    catch (e) { fail('Cannot read source owned file: ' + rel + ' (' + e.message + ')'); }
    const dest = path.join(configDir, rel);
    if (fs.existsSync(dest)) {
      const destContent = fs.readFileSync(dest);
      if (srcContent.equals(destContent)) fileStatus[rel] = 'unchanged';
      else { fileStatus[rel] = 'replace'; conflicts.push('file:' + rel); }
    } else {
      fileStatus[rel] = 'new';
    }
  }

  // Shepherd agent entry conflict detection (default_agent/plugin are not conflicts).
  const targetAgent = isPlainObject(targetRoot.agent) ? targetRoot.agent : {};
  for (const k of SHEPHERD_AGENTS) {
    if (Object.prototype.hasOwnProperty.call(targetAgent, k)) {
      if (!deepEqual(targetAgent[k], sourceRoot.agent[k])) conflicts.push('agent:' + k);
    }
  }

  // Determine whether the merged config would actually change the target.
  let willWriteConfig = false;
  if (targetExists) {
    const existingRaw = fs.readFileSync(targetConfigPath, 'utf8');
    if (existingRaw !== JSON.stringify(merged, null, 2) + '\n') willWriteConfig = true;
  } else {
    willWriteConfig = true;
  }

  // Prior state for the uninstall baseline.
  const priorFiles = {};
  for (const rel of OWNED_FILES) {
    const dest = path.join(configDir, rel);
    priorFiles[rel] = { existed: fs.existsSync(dest), backupPath: null };
  }
  const priorDefaultAgent = {
    existed: Object.prototype.hasOwnProperty.call(targetRoot, 'default_agent'),
    value: Object.prototype.hasOwnProperty.call(targetRoot, 'default_agent') ? targetRoot.default_agent : null,
  };
  const priorAgents = {};
  for (const k of SHEPHERD_AGENTS) {
    priorAgents[k] = {
      existed: Object.prototype.hasOwnProperty.call(targetAgent, k),
      value: Object.prototype.hasOwnProperty.call(targetAgent, k) ? targetAgent[k] : null,
    };
  }
  let priorPluginType = 'absent';
  let priorPluginValue = null;
  if (targetRoot.plugin !== undefined && targetRoot.plugin !== null) {
    priorPluginType = typeof targetRoot.plugin === 'string' ? 'string' : 'array';
    priorPluginValue = targetRoot.plugin;
  }
  const priorPlugin = {
    existed: targetRoot.plugin !== undefined && targetRoot.plugin !== null,
    type: priorPluginType,
    value: priorPluginValue,
    shepherdAlreadyPresent: (typeof targetRoot.plugin === 'string')
      ? targetRoot.plugin === PLUGIN_PATH
      : (Array.isArray(targetRoot.plugin) ? targetRoot.plugin.includes(PLUGIN_PATH) : false),
  };

  // Actual would-back-up paths for dry-run reporting.
  const wouldBackup = [];
  for (const rel of OWNED_FILES) {
    if (fileStatus[rel] === 'replace') wouldBackup.push(path.join(configDir, rel));
  }
  if (willWriteConfig && targetExists) wouldBackup.push(targetConfigPath);

  // Baseline path (deterministic given rand); used for symlink validation too.
  const baselinePath = path.join(configDir, BASELINE_PREFIX + rand() + '.json');

  // All destinations (owned files + config + baseline), including absent ones.
  const allDests = [targetConfigPath, baselinePath, ...OWNED_FILES.map((rel) => path.join(configDir, rel))];

  // Validation: root-aware ancestor walk + per-destination parent/dest checks.
  // Done before any write AND before dry-run reporting.
  validateAncestors(configDir);
  for (const dest of allDests) {
    validateDestParent(dest, configDir);
    assertContained(dest, configDir);
  }

  // Dry-run: report intended actions (including any conflicts) with zero writes.
  if (args.dryRun) {
    printDryRun({
      configDir, sourceRoot: SOURCE_ROOT, fileStatus, conflicts, merged, targetExists, wouldBackup,
    });
    process.exit(0);
  }

  // Conflict handling: abort before any write unless --force.
  if (conflicts.length > 0 && !args.force) {
    const lines = conflicts.map((c) => '  - ' + c).join('\n');
    fail('Conflicts detected (use --force to authorize replacement):\n' + lines, 1);
  }

  // Idempotent no-op: every owned file is unchanged and the merged config is
  // byte-identical to the target. Perform ZERO writes, backups, or baseline
  // creation, and report the baseline as none / no changes.
  const anyFileChange = OWNED_FILES.some((rel) => fileStatus[rel] !== 'unchanged');
  if (!anyFileChange && !willWriteConfig) {
    printSummary({
      configDir, fileStatus, backups: [], baselinePath: 'none', merged, targetExists, willWriteConfig: false,
    });
    process.exit(0);
  }

  // ---- Phase B: locking, revalidation, and writes ----
  const tempFiles = [];
  const backups = [];
  const committed = [];
  let lock = null;
  let lockPath = null;
  let configBackupPath = null;

  try {
    // Create the config root if needed (newly created dirs get 0o700).
    mkdirSafe(configDir);

    // Acquire an exclusive same-root lock only now (after validation/conflict/
    // no-op determination). If it already exists, abort with no writes.
    lockPath = path.join(configDir, LOCK_NAME);
    lock = acquireLock(lockPath);

    // Under lock: snapshot ALL destinations (including absent) for stale/race
    // protection. Require identity+content/existence unchanged before each commit.
    const lockSnap = new Map();
    for (const p of allDests) lockSnap.set(p, snapshot(p));

    // Backups for owned files that will be replaced.
    for (const rel of OWNED_FILES) {
      if (fileStatus[rel] === 'replace') {
        const dest = path.join(configDir, rel);
        const st = lstatOrNull(dest);
        priorFiles[rel].priorMode = st ? (st.mode & 0o777) : null;
        const bak = backupFile(dest, backups);
        priorFiles[rel].backupPath = bak;
      }
    }

    // Backup config only if it exists and would actually change.
    let configPriorMode = null;
    if (willWriteConfig && targetExists) {
      const st = lstatOrNull(targetConfigPath);
      configPriorMode = st ? (st.mode & 0o777) : null;
      configBackupPath = backupFile(targetConfigPath, backups);
    }

    // Baseline (uninstall-reversible record). No undefined values serialized.
    const baseline = {
      createdAt: new Date().toISOString(),
      installer: 'shepherd-install',
      configRoot: configDir,
      sourceRoot: SOURCE_ROOT,
      files: priorFiles,
      config: {
        defaultAgent: priorDefaultAgent,
        agents: priorAgents,
        plugin: priorPlugin,
        backupPath: (willWriteConfig && targetExists) ? configBackupPath : null,
      },
      backups: backups.slice(),
    };
    const baselineBytes = Buffer.from(JSON.stringify(baseline, null, 2) + '\n');

    // Copy owned files (unchanged skipped; replaced already backed up).
    for (const rel of OWNED_FILES) {
      if (fileStatus[rel] === 'unchanged') continue;
      const src = path.join(SOURCE_ROOT, rel);
      const dest = path.join(configDir, rel);
      const content = fs.readFileSync(src);
      mkdirSafe(path.dirname(dest));
      if (fileStatus[rel] === 'replace') {
        writeReplace(dest, content, priorFiles[rel].priorMode, lockSnap, committed, configDir, priorFiles[rel].backupPath);
      } else {
        writeNew(dest, content, 0o644, lockSnap, committed, configDir);
      }
      maybeInjectFailure(committed);
    }

    // Write merged opencode.json (replacement revalidated immediately before).
    if (willWriteConfig) {
      const mergedBytes = Buffer.from(JSON.stringify(merged, null, 2) + '\n');
      if (targetExists) {
        writeReplace(targetConfigPath, mergedBytes, configPriorMode, lockSnap, committed, configDir, configBackupPath);
      } else {
        writeNew(targetConfigPath, mergedBytes, 0o600, lockSnap, committed, configDir);
      }
      maybeInjectFailure(committed);
    }

    // Write baseline LAST (so a mid-run failure leaves no baseline behind).
    writeNew(baselinePath, baselineBytes, 0o600, lockSnap, committed, configDir);
    maybeInjectFailure(committed);

    // Success: release the lock (close fd, then remove only if identity+nonce match).
    const issues = safeLockRelease(lockPath, lock);
    lock = null;
    lockPath = null;
    if (issues.length) {
      process.stderr.write('shepherd-install: lock release issue: ' + issues.join('; ') + '\n');
    }

    printSummary({
      configDir, fileStatus, backups, baselinePath, merged, targetExists, willWriteConfig,
    });
    process.exit(0);
  } catch (e) {
    // Roll back every committed artifact; never delete backups. Report any
    // rollback failure explicitly (no silent rollback failure).
    const errors = doRollback(committed, tempFiles, lockPath, lock, configDir);
    const lockIssues = (lock || lockPath) ? safeLockRelease(lockPath, lock) : [];
    lock = null;
    let msg = 'Install failed after partial writes;';
    const allIssues = errors.concat(lockIssues);
    if (allIssues.length) msg += ' rollback issues: ' + allIssues.join('; ');
    else msg += ' rollback completed (backups preserved).';
    msg += ' (' + (e && e.message ? e.message : String(e)) + ')';
    fail(msg);
  }
}

main();
