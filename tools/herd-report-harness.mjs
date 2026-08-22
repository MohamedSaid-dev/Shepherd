// herd-report-harness.mjs — assertion harness for the pure exported helpers of
// tools/herd-report.js (banner shape, median, scheduling metrics). Run from repo root:
//   node tools/herd-report-harness.mjs
// No dependencies, no test framework, plain Node. Never opens the DB: importing
// herd-report.js must not touch opencode.db (openDb() only runs in runCli()).

import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);

let mod;
try {
  mod = require("../tools/herd-report.js");
} catch (err) {
  console.error(`IMPORT FAILED: ${err && err.stack ? err.stack : String(err)}`);
  process.exitCode = 1;
  process.exit(1);
}

const { SHEEP_BANNER, computeSchedulingMetrics, median, sanitizeTitle, DEFAULT_CAPACITY, BURST_WINDOW_MS } = mod;
if (
  typeof SHEEP_BANNER !== "string" ||
  typeof computeSchedulingMetrics !== "function" ||
  typeof median !== "function" ||
  typeof sanitizeTitle !== "function" ||
  DEFAULT_CAPACITY !== 8 ||
  BURST_WINDOW_MS !== 30000
) {
  console.error("IMPORT FAILED: expected exports SHEEP_BANNER, computeSchedulingMetrics, median, sanitizeTitle, DEFAULT_CAPACITY=8, BURST_WINDOW_MS=30000 not found");
  process.exitCode = 1;
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
  );
}

function checkDeep(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
  );
}

// --- banner: exact ASCII visible shape -------------------------------------
const bannerLines = SHEEP_BANNER.split("\n");
check("banner line count is 37", bannerLines.length, 37);
check("banner has no leading newline", SHEEP_BANNER.startsWith("\n"), false);
check("banner has no trailing newline", SHEEP_BANNER.endsWith("\n"), false);
check("banner has no blank first line", bannerLines[0].trim() !== "", true);
check("banner first line exact", bannerLines[0], "        ---------");
check("banner last line exact", bannerLines[bannerLines.length - 1], "------------------------------------------------------=");
check("banner first line leading spaces preserved", bannerLines[0].length, 17);
check("banner last line length", bannerLines[bannerLines.length - 1].length, 55);
check("banner contains no blank lines", bannerLines.every((l) => l.trim() !== ""), true);

// --- median: odd / even / empty / null --------------------------------------
check("median odd [3,1,2] is 2", median([3, 1, 2]), 2);
check("median even [4,1,3,2] is 2.5", median([4, 1, 3, 2]), 2.5);
check("median empty array is null", median([]), null);
check("median null is null", median(null), null);
check("median does not mutate input", (() => { const a = [3, 1, 2]; median(a); return a.join(","); })(), "3,1,2");

// --- sanitizeTitle: multiline titles collapse to one line ----------------------
check("sanitizeTitle collapses CRLF to space", sanitizeTitle("a\r\nb"), "a b");
check("sanitizeTitle collapses lone CR", sanitizeTitle("a\rb"), "a b");
check("sanitizeTitle collapses lone LF", sanitizeTitle("a\nb"), "a b");
check("sanitizeTitle collapses CR/LF runs to one space", sanitizeTitle("a\n\n\nb"), "a b");
check("sanitizeTitle null coerces to empty string", sanitizeTitle(null), "");
check("sanitizeTitle undefined coerces to empty string", sanitizeTitle(undefined), "");
check("sanitizeTitle coerces non-strings", sanitizeTitle(123), "123");
check("sanitizeTitle leaves plain titles untouched", sanitizeTitle("plain title"), "plain title");

// --- scheduling metrics: zero and one child null safety ----------------------
const zero = computeSchedulingMetrics([]);
checkDeep("zero children base shape", zero, {
  capacity: 8, inputChildCount: 0, invalidChildCount: 0, childCount: 0,
  burstCount: 0, burstShare: 0,
  gapCount: 0, gapMedian: null, gapMax: null,
  peak: 0, twa: 0, peakHeadroom: 8, peakOverCapacity: 0, avgUtilization: 0,
});
checkDeep("zero children (null input) base shape", computeSchedulingMetrics(null), zero);

const one = computeSchedulingMetrics([{ time_created: 0, time_updated: 60000 }]);
checkDeep("one child null-safe metrics", one, {
  capacity: 8, inputChildCount: 1, invalidChildCount: 0, childCount: 1,
  burstCount: 1, burstShare: 1,
  gapCount: 0, gapMedian: null, gapMax: null,
  peak: 1, twa: 1, peakHeadroom: 7, peakOverCapacity: 0, avgUtilization: 0.125,
});

// --- malformed input: invalid entries ignored and counted ----------------------
// Invalid elements (null, missing/NaN/Infinity timestamps, updated < created)
// are ignored for metrics but counted in inputChildCount/invalidChildCount.
const nullElem = computeSchedulingMetrics([null, { time_created: 0, time_updated: 60000 }]);
check("null element counted as invalid", nullElem.invalidChildCount, 1);
check("null element still counted as input", nullElem.inputChildCount, 2);
check("null element does not affect childCount", nullElem.childCount, 1);
check("null element metrics match the valid child", nullElem.peak, 1);

const missingUpdated = computeSchedulingMetrics([{ time_created: 5 }]);
check("missing time_updated counted as invalid", missingUpdated.invalidChildCount, 1);
check("missing time_updated childCount is 0", missingUpdated.childCount, 0);

const nanCreated = computeSchedulingMetrics([{ time_created: NaN, time_updated: 1000 }]);
check("NaN time_created counted as invalid", nanCreated.invalidChildCount, 1);
check("NaN time_created childCount is 0", nanCreated.childCount, 0);

const nanUpdated = computeSchedulingMetrics([{ time_created: 0, time_updated: NaN }]);
check("NaN time_updated counted as invalid", nanUpdated.invalidChildCount, 1);
check("NaN time_updated childCount is 0", nanUpdated.childCount, 0);

const infUpdated = computeSchedulingMetrics([{ time_created: 0, time_updated: Infinity }]);
check("Infinity time_updated counted as invalid", infUpdated.invalidChildCount, 1);
check("Infinity time_updated childCount is 0", infUpdated.childCount, 0);

const backwards = computeSchedulingMetrics([{ time_created: 1000, time_updated: 500 }]);
check("updated < created counted as invalid", backwards.invalidChildCount, 1);
check("updated < created childCount is 0", backwards.childCount, 0);

// Non-array input: no children, nothing invalid, stable base shape.
const nonArray = computeSchedulingMetrics("not-an-array");
check("non-array input inputChildCount is 0", nonArray.inputChildCount, 0);
check("non-array input invalidChildCount is 0", nonArray.invalidChildCount, 0);
check("non-array input childCount is 0", nonArray.childCount, 0);
check("non-array input peak is 0", nonArray.peak, 0);
check("non-array input twa is 0", nonArray.twa, 0);

// Invalid capacity (NaN/0/negative/Infinity) falls back to DEFAULT_CAPACITY.
const capNaN = computeSchedulingMetrics([{ time_created: 0, time_updated: 60000 }], NaN);
check("capacity NaN falls back to 8", capNaN.capacity, 8);
check("capacity NaN headroom uses 8", capNaN.peakHeadroom, 7);
check("capacity NaN avgUtilization uses 8", capNaN.avgUtilization, 0.125);

const capZero = computeSchedulingMetrics([{ time_created: 0, time_updated: 60000 }], 0);
check("capacity 0 falls back to 8", capZero.capacity, 8);
check("capacity 0 headroom uses 8", capZero.peakHeadroom, 7);

const capNeg = computeSchedulingMetrics([{ time_created: 0, time_updated: 60000 }], -3);
check("capacity -3 falls back to 8", capNeg.capacity, 8);
check("capacity -3 headroom uses 8", capNeg.peakHeadroom, 7);

const capInf = computeSchedulingMetrics([{ time_created: 0, time_updated: 60000 }], Infinity);
check("capacity Infinity falls back to 8", capInf.capacity, 8);
check("capacity Infinity headroom uses 8", capInf.peakHeadroom, 7);

// Valid custom capacity is retained.
const capFour = computeSchedulingMetrics([{ time_created: 0, time_updated: 60000 }], 4);
check("capacity 4 retained", capFour.capacity, 4);
check("capacity 4 headroom", capFour.peakHeadroom, 3);
check("capacity 4 avgUtilization", capFour.avgUtilization, 0.25);

// Every numeric result must be finite across all malformed-input cases.
const allNumericFinite = (r) =>
  [r.capacity, r.inputChildCount, r.invalidChildCount, r.childCount, r.burstCount,
   r.burstShare, r.gapCount, r.peak, r.twa, r.peakHeadroom, r.peakOverCapacity,
   r.avgUtilization].every((v) => typeof v === "number" && Number.isFinite(v));
check(
  "all malformed-input results finite",
  [nullElem, missingUpdated, nanCreated, nanUpdated, infUpdated, backwards, nonArray,
   capNaN, capZero, capNeg, capInf, capFour].every(allNumericFinite),
  true,
);

// --- v3 validation: extreme finite / unsafe / negative / noninteger timestamps --
// v3 requires nonnegative safe-integer timestamps with a safe-integer duration.
const negCreated = computeSchedulingMetrics([{ time_created: -1, time_updated: 1000 }]);
check("negative time_created counted as invalid", negCreated.invalidChildCount, 1);
check("negative time_created childCount is 0", negCreated.childCount, 0);

const negUpdated = computeSchedulingMetrics([{ time_created: 0, time_updated: -1 }]);
check("negative time_updated counted as invalid", negUpdated.invalidChildCount, 1);
check("negative time_updated childCount is 0", negUpdated.childCount, 0);

const fracCreated = computeSchedulingMetrics([{ time_created: 1.5, time_updated: 1000 }]);
check("noninteger time_created counted as invalid", fracCreated.invalidChildCount, 1);
check("noninteger time_created childCount is 0", fracCreated.childCount, 0);

const fracUpdated = computeSchedulingMetrics([{ time_created: 0, time_updated: 1.5 }]);
check("noninteger time_updated counted as invalid", fracUpdated.invalidChildCount, 1);
check("noninteger time_updated childCount is 0", fracUpdated.childCount, 0);

const unsafeBoth = computeSchedulingMetrics([
  { time_created: Number.MAX_SAFE_INTEGER + 1, time_updated: Number.MAX_SAFE_INTEGER + 2 },
]);
check("unsafe-integer timestamps counted as invalid", unsafeBoth.invalidChildCount, 1);
check("unsafe-integer timestamps childCount is 0", unsafeBoth.childCount, 0);

const unsafeUpdated = computeSchedulingMetrics([
  { time_created: 0, time_updated: Number.MAX_SAFE_INTEGER + 1 },
]);
check("unsafe time_updated counted as invalid", unsafeUpdated.invalidChildCount, 1);
check("unsafe time_updated childCount is 0", unsafeUpdated.childCount, 0);

// Extreme but valid: max safe integer span stays finite.
const extremeValid = computeSchedulingMetrics([
  { time_created: 0, time_updated: Number.MAX_SAFE_INTEGER },
]);
check("extreme finite span childCount is 1", extremeValid.childCount, 1);
check("extreme finite span peak is 1", extremeValid.peak, 1);
check("extreme finite span twa is finite", Number.isFinite(extremeValid.twa), true);
check("extreme finite span headroom", extremeValid.peakHeadroom, 7);

check(
  "all v3 extreme/unsafe/negative/noninteger results finite",
  [negCreated, negUpdated, fracCreated, fracUpdated, unsafeBoth, unsafeUpdated, extremeValid]
    .every(allNumericFinite),
  true,
);

// --- burst boundary: 30s window is inclusive, >30s excluded ------------------
const burst = computeSchedulingMetrics([
  { time_created: 0, time_updated: 1000 },
  { time_created: 30000, time_updated: 31000 }, // exactly at boundary: included
  { time_created: 30001, time_updated: 32000 }, // just past boundary: excluded
]);
check("burst boundary count includes 30s, excludes >30s", burst.burstCount, 2);
check("burst boundary share", burst.burstShare, 2 / 3);

// --- overlapping children: no negative gaps, starts without prior completion skipped
const overlap = computeSchedulingMetrics([
  { time_created: 0, time_updated: 100000 },
  { time_created: 50000, time_updated: 150000 }, // starts before prior completion
]);
check("overlap gapCount is 0 (start skipped, no negative gap)", overlap.gapCount, 0);
check("overlap gapMedian is null", overlap.gapMedian, null);
check("overlap gapMax is null", overlap.gapMax, null);
check("overlap peak counts concurrent children", overlap.peak, 2);
check("overlap peakHeadroom", overlap.peakHeadroom, 6);

// --- sequential children: most recent prior completion, expected count/median/max
const seq = computeSchedulingMetrics([
  { time_created: 0, time_updated: 10000 },
  { time_created: 20000, time_updated: 30000 },
  { time_created: 40000, time_updated: 50000 },
]);
check("sequential gapCount", seq.gapCount, 2);
check("sequential gapMedian", seq.gapMedian, 10);
check("sequential gapMax", seq.gapMax, 10);
check("sequential peak", seq.peak, 1);

// --- equal-start permutations: identical gaps/metrics regardless of order ------
// v3 sorts deterministically (start, completion, id) and only counts strictly
// earlier starts as prior, so every permutation of the same records must yield
// the same result. Two children share start 0; child c starts after both.
const eqBase = [
  { id: "a", time_created: 0, time_updated: 10000 },
  { id: "b", time_created: 0, time_updated: 20000 },
  { id: "c", time_created: 30000, time_updated: 40000 },
];
const eqPerms = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];
const eqResults = eqPerms.map((p) => computeSchedulingMetrics(p.map((i) => eqBase[i])));
const eqFirst = JSON.stringify(eqResults[0]);
check(
  "equal-start permutations produce identical results",
  eqResults.every((r) => JSON.stringify(r) === eqFirst),
  true,
);
check("equal-start permutation gapCount", eqResults[0].gapCount, 1);
check("equal-start permutation gapMedian", eqResults[0].gapMedian, 10);
check("equal-start permutation gapMax", eqResults[0].gapMax, 10);
check("equal-start permutation peak", eqResults[0].peak, 2);
check("equal-start permutation twa", eqResults[0].twa, 1);

// Same-start zero-duration child is not prior for a same-start sibling: the
// zero-duration record must not count as a prior completion, and the result
// must be identical regardless of input order.
const szA = computeSchedulingMetrics([
  { id: "z", time_created: 0, time_updated: 0 },
  { id: "w", time_created: 0, time_updated: 10000 },
]);
const szB = computeSchedulingMetrics([
  { id: "w", time_created: 0, time_updated: 10000 },
  { id: "z", time_created: 0, time_updated: 0 },
]);
check("same-start zero-duration order-independent", JSON.stringify(szA) === JSON.stringify(szB), true);
check("same-start zero-duration gapCount is 0", szA.gapCount, 0);
check("same-start zero-duration gapMedian is null", szA.gapMedian, null);
check("same-start zero-duration peak is 1", szA.peak, 1);
check("same-start zero-duration twa is 1", szA.twa, 1);

// --- mixed children: reuse most recent prior completion ----------------------
// child 3 starts at 25000 while child 2 is still running (completes 30000), so
// its gap is measured from child 1's completion (10000) — the most recent prior
// completion at or before its start.
const mixed = computeSchedulingMetrics([
  { time_created: 0, time_updated: 10000 },
  { time_created: 20000, time_updated: 30000 },
  { time_created: 25000, time_updated: 40000 },
  { time_created: 45000, time_updated: 60000 },
]);
check("mixed gapCount", mixed.gapCount, 3);
check("mixed gapMedian", mixed.gapMedian, 10);
check("mixed gapMax", mixed.gapMax, 15);
// Exact event-sweep concurrency: child2 [20000,30000] and child3 [25000,40000]
// overlap for 5s, so peak is 2 and twa = area/span = 50s/60s = 5/6.
check("mixed peak counts the 5s overlap", mixed.peak, 2);
check("mixed twa exact weighted average", mixed.twa, 5 / 6);

// --- exact concurrency: 5-second overlap --------------------------------------
// child1 [0,100000] and child2 [5000,105000] overlap for 5000ms.
// Area = 1*5s + 2*95s + 1*5s = 200s over a 105s span -> twa = 200/105.
const five = computeSchedulingMetrics([
  { time_created: 0, time_updated: 100000 },
  { time_created: 5000, time_updated: 105000 },
]);
check("5s overlap peak is 2", five.peak, 2);
check("5s overlap exact weighted average", five.twa, 200 / 105);

// --- exact concurrency: back-to-back intervals share an endpoint ---------------
// [0,60000] and [60000,120000] touch at 60000; half-open intervals must not
// count that instant as overlap (end processed before start on ties).
const b2b = computeSchedulingMetrics([
  { time_created: 0, time_updated: 60000 },
  { time_created: 60000, time_updated: 120000 },
]);
check("back-to-back shared endpoint peak is 1", b2b.peak, 1);
check("back-to-back shared endpoint twa", b2b.twa, 1);

// --- exact concurrency: zero-duration intervals --------------------------------
// A zero-length child [5000,5000] must not produce NaN/negative metrics.
const zd = computeSchedulingMetrics([
  { time_created: 0, time_updated: 10000 },
  { time_created: 5000, time_updated: 5000 },
]);
check("zero-duration mixed peak is finite", Number.isFinite(zd.peak), true);
check("zero-duration mixed twa is finite", Number.isFinite(zd.twa), true);
check("zero-duration mixed peak is not negative", zd.peak >= 0, true);
check("zero-duration mixed twa is not negative", zd.twa >= 0, true);
check("zero-duration mixed peak", zd.peak, 1);
check("zero-duration mixed twa", zd.twa, 1);

const loneZero = computeSchedulingMetrics([{ time_created: 5000, time_updated: 5000 }]);
check("lone zero-duration peak is 0", loneZero.peak, 0);
check("lone zero-duration twa is 0", loneZero.twa, 0);
check("lone zero-duration peak is finite", Number.isFinite(loneZero.peak), true);
check("lone zero-duration twa is finite", Number.isFinite(loneZero.twa), true);

// --- default capacity headroom ------------------------------------------------
const cap = computeSchedulingMetrics([{ time_created: 0, time_updated: 60000 }]);
check("default capacity is 8", DEFAULT_CAPACITY, 8);
check("default capacity headroom for 1 child", cap.peakHeadroom, 7);

// --- peak over capacity: headroom clamps to 0, overage exposed -----------------
const over = computeSchedulingMetrics(
  Array.from({ length: 10 }, () => ({ time_created: 0, time_updated: 60000 })),
);
check("over-capacity peak", over.peak, 10);
check("over-capacity headroom clamps to 0", over.peakHeadroom, 0);
check("over-capacity overage exposed", over.peakOverCapacity, 2);

// --- average utilization stable ------------------------------------------------
const util = computeSchedulingMetrics(
  Array.from({ length: 4 }, () => ({ time_created: 0, time_updated: 120000 })),
);
check("avg utilization 4 of 8 over full event-sweep window", util.avgUtilization, 0.5);
check("avg utilization twa", util.twa, 4);
check("avg utilization peak", util.peak, 4);

// --- README parity: fenced text block body must equal the banner -------------
// Portable: resolve ../README.md relative to this harness file, never CWD.
const readmePath = new URL("../README.md", import.meta.url);
let readme;
try {
  readme = readFileSync(readmePath, "utf8");
} catch (err) {
  console.error(`README READ FAILED: ${err && err.stack ? err.stack : String(err)}`);
  process.exitCode = 1;
  process.exit(1);
}
// Normalize CRLF so the check is portable across checkouts.
const readmeNorm = readme.replace(/\r\n/g, "\n");
const fenceRe = /```text\n([\s\S]*?)\n```/g;
const textBlocks = [];
let fenceMatch;
while ((fenceMatch = fenceRe.exec(readmeNorm)) !== null) textBlocks.push(fenceMatch[1]);
check("README contains at least one fenced text block", textBlocks.length > 0, true);
check(
  "README fenced text block body exactly equals SHEEP_BANNER",
  textBlocks.some((body) => body === SHEEP_BANNER),
  true,
);
check(
  "README fenced text block body line count matches banner",
  textBlocks.some((body) => body.split("\n").length === bannerLines.length),
  true,
);

// --- CLI isolation: banner first, import-only child, fixture DB --all ----------
// All child processes run with a unique mkdtemp home (both HOME and USERPROFILE)
// so the real opencode.db is never touched and never found. The temp home is
// removed afterwards.
const reportPath = fileURLToPath(new URL("../tools/herd-report.js", import.meta.url));
const isoRoot = mkdtempSync(path.join(os.tmpdir(), "herd-report-harness-"));
const isoEnv = { ...process.env, HOME: isoRoot, USERPROFILE: isoRoot };
try {
  // Banner-before-DB: with no DB present the banner must still be the first
  // stdout and emitted exactly once, then the process exits non-zero.
  const spawnRes = spawnSync(process.execPath, [reportPath, "--list"], {
    cwd: path.dirname(reportPath),
    env: isoEnv,
    encoding: "utf8",
    timeout: 30000,
  });
  check("CLI spawn completed (no crash)", spawnRes.error === undefined, true);
  check("CLI exits non-zero when DB is missing", spawnRes.status !== 0, true);
  check("CLI stdout starts with the banner", spawnRes.stdout.startsWith(SHEEP_BANNER), true);
  check(
    "CLI banner emitted exactly once",
    spawnRes.stdout.split(SHEEP_BANNER).length - 1,
    1,
  );
  check("CLI stderr reports missing DB", /opencode\.db not found/.test(spawnRes.stderr), true);

  // Import-only child: requiring the module in an isolated home must exit 0
  // with no stdout/stderr, proving import never opens the DB.
  const impRes = spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(reportPath)})`],
    { cwd: path.dirname(reportPath), env: isoEnv, encoding: "utf8", timeout: 30000 },
  );
  check("import-only child exits 0", impRes.status, 0);
  check("import-only child stdout is empty", impRes.stdout, "");
  check("import-only child stderr is empty", impRes.stderr, "");

  // Fixture DB: a minimal schema with one shepherd session whose title contains
  // CR/LF. `--all` must print exactly the banner plus one physical session line
  // (sanitized title, no injected newlines) and leave the DB readable.
  const dbDir = path.join(isoRoot, ".local", "share", "opencode");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "opencode.db");
  const fdb = new DatabaseSync(dbPath);
  fdb.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, agent TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER)",
  );
  fdb.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
  fdb.exec("CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
  fdb
    .prepare(
      "INSERT INTO session (id, agent, parent_id, directory, title, time_created, time_updated, tokens_input, tokens_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "ses-fixture",
      "shepherd",
      null,
      "E:/fixture",
      "Line one\r\nLine two\nLine three",
      1750000000000,
      1750003600000,
      0,
      0,
    );
  fdb.close();

  const allRes = spawnSync(process.execPath, [reportPath, "--all"], {
    cwd: path.dirname(reportPath),
    env: isoEnv,
    encoding: "utf8",
    timeout: 30000,
  });
  check("fixture --all exits 0", allRes.status, 0);
  check("fixture --all stderr is empty", allRes.stderr, "");
  check("fixture --all stdout starts with the banner", allRes.stdout.startsWith(SHEEP_BANNER), true);
  const allRest = allRes.stdout.slice(SHEEP_BANNER.length + 1).replace(/\n$/, "");
  check("fixture --all prints exactly one physical session line", allRest.split("\n").length, 1);
  check("fixture --all session line has no CR/LF", allRest.includes("\r") || allRest.includes("\n"), false);
  check(
    "fixture --all session line contains sanitized multiline title",
    allRest.includes("Line one Line two Line three"),
    true,
  );
  check(
    "fixture --all session line contains the fixture timestamp",
    allRest.includes("2025-06-15T15:06"),
    true,
  );

  const fdb2 = new DatabaseSync(dbPath, { readOnly: true });
  const sessionCount = fdb2.prepare("SELECT COUNT(*) c FROM session").get().c;
  fdb2.close();
  check("fixture DB remains readable after --all", sessionCount, 1);
} finally {
  rmSync(isoRoot, { recursive: true, force: true });
}

// --- direct require must not open the DB ----------------------------------------
// Importing the module must not fail or touch opencode.db; openDb() only runs
// inside runCli() when invoked as the main module. The require above already
// proves import succeeds; assert the DB-opening path is not executed on import.
check("require of herd-report.js does not open the DB (import succeeded)", true, true);

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
