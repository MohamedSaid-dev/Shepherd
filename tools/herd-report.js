#!/usr/bin/env node
// herd-report.js - Shepherd herd telemetry from the local opencode database.
//
// Usage:
//   node tools/herd-report.js --list          list recent shepherd sessions
//   node tools/herd-report.js --all           one-line summary per shepherd session
//   node tools/herd-report.js <sessionId>     full report (default: latest shepherd session)
//
// Metrics:
//   wall     = child session lifetime (created -> updated)
//   active   = wall minus inter-message gaps over STALL_GRACE seconds (starvation, step-limit parking)
//   stalled  = wall - active; high values mean the herd waited, not worked
//
// Requires Node >= 22.13 (node:sqlite). Read-only; safe to run any time.

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const os = require("os");
const fs = require("fs");

const STALL_GRACE = 180; // seconds of silence tolerated inside a running sheep
const PARENT_IDLE_MIN = 300; // report parent gaps longer than this
const DEFAULT_CAPACITY = 8; // comparison ceiling, NOT evidence work was ready
const BURST_WINDOW_MS = 30000; // 30s window from first child start for initial burst

// User-supplied ASCII sheep banner. Printed exactly once per CLI invocation.
const SHEEP_BANNER = `        ---------
                    ---------------------
                 --------------------------
               --------------------------------
              ------------------------------------
             ---------------------------------------
            *===-------------------------------------
       **********+-----------------------------------
    *************+----+*******+----------=-----------
   **************---*************************=-----++*
  **************--=****************************----*****+
  ************---=******************************=--+*******
   +*******+-----********************************---+*******
     -=+=-------+*******####*********************+---********+
     -----------+*******###*************###*******---+********
    ------------+************************##*******---=*******
   --------------+*************##**#**************----*****+
   ---------------+**************##**************+-----
   -----------------=****************************------
   --------------------=+**********************--------
   ---------------------------=***********+=-----------
 -----------------------------------------------------=
------------------------------------------------------
-------------------------------------------------------
--------------------------------------------------------
--------------------------------------------------------=`;

// Pure, deterministic, null-safe median (exportable for a later harness).
function median(arr) {
  if (!arr || !arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Pure title sanitizer: collapse any run of CR/LF characters to a single space
// so a multiline title can never inject extra physical lines into a one-line
// report row. Null/undefined is coerced to an empty string.
function sanitizeTitle(title) {
  return (title == null ? "" : String(title)).replace(/[\r\n]+/g, " ");
}

// Pure scheduling-metrics helper. Operates only on child session timestamps
// (time_created / time_updated). It never touches the DB and is safe to import.
//
// Returns heuristics, not exact ready-queue data:
//   - initial burst: kids that started within BURST_WINDOW_MS of the first start
//   - start-after-most-recent-prior-completion gaps: kid[i].start - most recent prior completion at/before start
//   - peak headroom / avg utilization vs DEFAULT_CAPACITY (a comparison ceiling)
// For zero/one child it returns stable zero/null-safe values.
function computeSchedulingMetrics(kids, capacity = DEFAULT_CAPACITY) {
  // Normalize capacity: nonfinite or <=0 is not a usable ceiling; fall back to
  // DEFAULT_CAPACITY so downstream math never divides by zero or goes NaN.
  const effectiveCapacity =
    typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0
      ? capacity
      : DEFAULT_CAPACITY;

  // Validate scheduling input. Accept only array entries that are objects with
  // nonnegative safe-integer time_created/time_updated, time_updated >=
  // time_created, and a safe-integer duration. This bounds the global span and
  // prevents finite extreme overflow / NaN. Everything else is ignored and
  // counted as invalid (never throws, no NaN).
  const inputChildCount = Array.isArray(kids) ? kids.length : 0;
  const valid = [];
  let invalidChildCount = 0;
  if (Array.isArray(kids)) {
    for (const k of kids) {
      if (
        k &&
        typeof k === "object" &&
        Number.isSafeInteger(k.time_created) &&
        k.time_created >= 0 &&
        Number.isSafeInteger(k.time_updated) &&
        k.time_updated >= 0 &&
        k.time_updated >= k.time_created &&
        Number.isSafeInteger(k.time_updated - k.time_created)
      ) {
        valid.push(k);
      } else {
        invalidChildCount++;
      }
    }
  }
  const n = valid.length;
  const base = {
    capacity: effectiveCapacity,
    inputChildCount,
    invalidChildCount,
    childCount: n,
    burstCount: 0,
    burstShare: 0,
    gapCount: 0,
    gapMedian: null,
    gapMax: null,
    peak: 0,
    twa: 0,
    peakHeadroom: effectiveCapacity,
    peakOverCapacity: 0,
    avgUtilization: 0,
  };
  if (n === 0) return base;

  // Deterministic sort: by start time, then completion time, then id so that
  // equal-start ties resolve consistently. The gap policy depends only on
  // strictly earlier starts, but a stable order keeps the whole computation
  // reproducible across runs.
  const sorted = [...valid].sort((a, b) => {
    if (a.time_created !== b.time_created) return a.time_created - b.time_created;
    if (a.time_updated !== b.time_updated) return a.time_updated - b.time_updated;
    const ai = a.id == null ? "" : String(a.id);
    const bi = b.id == null ? "" : String(b.id);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  const t0 = sorted[0].time_created;

  // Initial start burst: count kids starting within the window of first start.
  let burst = 0;
  for (const k of sorted) if (k.time_created - t0 <= BURST_WINDOW_MS) burst++;

  // Start-after-most-recent-prior-completion gaps (seconds). For each child i,
  // find the most recent prior child completion (time_updated) at or before
  // child i's start (time_created). Equal-start policy: only completions from
  // records with STRICTLY EARLIER start times count as prior, so records that
  // share a start time never count as prior for one another (deterministic
  // ties). If no strictly-earlier-start child has completed, that start is
  // skipped. Reusing the same most recent prior completion for several later
  // starts is an observed heuristic, not exact slot refill.
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const start = sorted[i].time_created;
    let latest = null;
    for (let j = 0; j < i; j++) {
      if (sorted[j].time_created < start) {
        const c = sorted[j].time_updated;
        if (c <= start && (latest === null || c > latest)) latest = c;
      }
    }
    if (latest !== null) gaps.push((start - latest) / 1000);
  }

  // Concurrency: exact peak and time-weighted average over the herd window.
  // Each child is a half-open interval [time_created, time_updated). We sweep
  // sorted event times; when an end and a start share a timestamp the end is
  // processed first so the intervals do not overlap at that instant. The area
  // under the active-concurrency curve is divided by (tEnd - tStart).
  let peak = 0, twa = 0;
  const tStart = Math.min(...sorted.map((k) => k.time_created));
  const tEnd = Math.max(...sorted.map((k) => k.time_updated));
  if (tEnd > tStart) {
    const events = [];
    for (const k of sorted) {
      events.push({ t: k.time_created, d: 1 });
      events.push({ t: k.time_updated, d: -1 });
    }
    // Sort by time; on ties, ends (-1) before starts (+1) so shared timestamps
    // do not count as overlapping.
    events.sort((a, b) => (a.t - b.t) || (a.d - b.d));
    let active = 0, area = 0, prev = events[0].t;
    for (const e of events) {
      const span = e.t - prev;
      if (span > 0) {
        area += active * span;
        if (active > peak) peak = active;
      }
      active += e.d;
      prev = e.t;
    }
    twa = area / (tEnd - tStart);
  }

  const result = {
    ...base,
    burstCount: burst,
    burstShare: burst / n,
    gapCount: gaps.length,
    gapMedian: median(gaps),
    gapMax: gaps.length ? Math.max(...gaps) : null,
    peak,
    twa,
    peakHeadroom: Math.max(0, effectiveCapacity - peak),
    peakOverCapacity: Math.max(0, peak - effectiveCapacity),
    avgUtilization: effectiveCapacity ? twa / effectiveCapacity : 0,
  };

  // Defensively ensure every returned numeric metric is finite. Null fields
  // (gapMedian / gapMax) are left untouched; any stray NaN/Infinity from the
  // arithmetic above is clamped to 0 so downstream consumers never see NaN.
  for (const key of Object.keys(result)) {
    const v = result[key];
    if (typeof v === "number" && !Number.isFinite(v)) result[key] = 0;
  }
  return result;
}

let db; // assigned in runCli(); kept module-scoped so analyze() can read it.

function openDb() {
  const candidates = [
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return new DatabaseSync(c, { readOnly: true });
  }
  console.error("opencode.db not found under: " + candidates.join(", "));
  process.exit(1);
}

const fmtMin = (s) => (s / 60).toFixed(0) + "m";
const fmtH = (s) => (s / 3600).toFixed(1) + "h";
const fmtTok = (t) => (t >= 1e6 ? (t / 1e6).toFixed(2) + "M" : (t / 1e3).toFixed(0) + "K");
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

function shepherdSessions(limit = 200) {
  return db
    .prepare(
      `SELECT id, directory, title, time_created, time_updated, tokens_input, tokens_output
       FROM session WHERE agent = 'shepherd' AND parent_id IS NULL
       ORDER BY time_created DESC LIMIT ?`
    )
    .all(limit);
}

function analyze(sid) {
  const parent = db.prepare(`SELECT * FROM session WHERE id = ?`).get(sid);
  if (!parent) {
    console.error("session not found: " + sid);
    process.exit(1);
  }
  const kids = db
    .prepare(
      `SELECT id, agent, title, time_created, time_updated, tokens_input, tokens_output
       FROM session WHERE parent_id = ? ORDER BY time_created`
    )
    .all(sid);

  const byAgent = {};
  const stalls = [];
  const dup = {};
  let totWall = 0, totActive = 0, totIn = 0, totOut = 0;
  const msgTimes = [];

  for (const k of kids) {
    const times = db
      .prepare(`SELECT time_created FROM message WHERE session_id = ? ORDER BY time_created`)
      .all(k.id)
      .map((m) => m.time_created);
    msgTimes.push(...times.map((t) => ({ t, sid: k.id })));
    const wall = (k.time_updated - k.time_created) / 1000;
    let stall = 0;
    for (let i = 1; i < times.length; i++) {
      const g = (times[i] - times[i - 1]) / 1000;
      if (g > STALL_GRACE) stall += g - STALL_GRACE;
    }
    const active = Math.max(0, wall - stall);
    totWall += wall; totActive += active;
    totIn += k.tokens_input || 0; totOut += k.tokens_output || 0;
    const a = (byAgent[k.agent] ||= { n: 0, wall: 0, active: 0, in: 0, out: 0 });
    a.n++; a.wall += wall; a.active += active;
    a.in += k.tokens_input || 0; a.out += k.tokens_output || 0;
    if (stall > 600) stalls.push({ agent: k.agent, title: (k.title || "").replace(/ \(@sheep-.*$/, ""), wall, stall, start: k.time_created });
    const key = (k.title || "").replace(/ \(@sheep-.*$/, "");
    (dup[key] ||= { n: 0, wall: 0, tin: 0 });
    dup[key].n++; dup[key].wall += wall; dup[key].tin += k.tokens_input || 0;
  }

  // parent-side metrics
  const parentMsgs = db
    .prepare(`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created`)
    .all(sid);
  let parentIdle = 0;
  const idleGaps = [];
  for (let i = 1; i < parentMsgs.length; i++) {
    const g = (parentMsgs[i].time_created - parentMsgs[i - 1].time_created) / 1000;
    if (g > PARENT_IDLE_MIN) {
      parentIdle += g;
      idleGaps.push({ from: parentMsgs[i - 1].time_created, to: parentMsgs[i].time_created, sec: g });
    }
  }
  const questionCalls = db
    .prepare(`SELECT COUNT(*) c FROM part WHERE session_id = ? AND data LIKE '%"tool":"question"%'`)
    .get(sid).c;
  const taskCalls = db
    .prepare(`SELECT COUNT(*) c FROM part WHERE session_id = ? AND data LIKE '%"tool":"task"%'`)
    .get(sid).c;

  // concurrency + scheduling heuristics (pure helper; capacity is a ceiling)
  const sched = computeSchedulingMetrics(kids, DEFAULT_CAPACITY);
  const peak = sched.peak;
  const twa = sched.twa;

  const dups = Object.entries(dup).filter(([, v]) => v.n > 1).sort((a, b) => b[1].n - a[1].n);
  return { parent, kids, byAgent, stalls, dups, totWall, totActive, totIn, totOut, parentIdle, idleGaps, questionCalls, taskCalls, peak, twa, sched };
}

function printFull(sid) {
  const r = analyze(sid);
  const p = r.parent;
  const wallH = (p.time_updated - p.time_created) / 3600000;
  console.log(`\nHERD REPORT  ${p.id}`);
  console.log(`  ${sanitizeTitle(p.title) || "(untitled)"}`);
  console.log(`  ${p.directory} | ${new Date(p.time_created).toISOString().slice(0, 16)} -> ${new Date(p.time_updated).toISOString().slice(0, 16)} | wall ${wallH.toFixed(1)}h`);
  console.log(`  dispatches: ${r.taskCalls} task calls -> ${r.kids.length} sheep sessions | questions: ${r.questionCalls} | peak concurrency: ${r.peak} | avg: ${r.twa.toFixed(1)}`);

  console.log(`\n  sheep totals: wall ${fmtH(r.totWall)} | active ${fmtH(r.totActive)} | STALLED ${fmtH(r.totWall - r.totActive)} (${r.totWall ? (((r.totWall - r.totActive) / r.totWall) * 100).toFixed(0) : 0}%) | tokens in ${fmtTok(r.totIn)} out ${fmtTok(r.totOut)}`);
  console.log(`\n  per agent:`);
  console.log(`    ${"agent".padEnd(14)}${"n".padStart(3)} ${"wall".padStart(6)} ${"active".padStart(6)} ${"stalled".padStart(7)} ${"stall%".padStart(6)} ${"tok in".padStart(8)}`);
  for (const [a, v] of Object.entries(r.byAgent).sort((x, y) => y[1].wall - x[1].wall)) {
    console.log(`    ${a.padEnd(14)}${String(v.n).padStart(3)} ${fmtMin(v.wall).padStart(6)} ${fmtMin(v.active).padStart(6)} ${fmtMin(v.wall - v.active).padStart(7)} ${(((v.wall - v.active) / v.wall) * 100).toFixed(0).padStart(5)}% ${fmtTok(v.in).padStart(8)}`);
  }

  if (r.stalls.length) {
    r.stalls.sort((a, b) => b.stall - a.stall);
    console.log(`\n  worst stalls (>10m):`);
    for (const s of r.stalls.slice(0, 8))
      console.log(`    ${new Date(s.start).toISOString().slice(5, 16)} ${s.agent.padEnd(13)} stalled ${fmtMin(s.stall)} of ${fmtMin(s.wall)}  ${sanitizeTitle(s.title).slice(0, 50)}`);
  }

  if (r.dups.length) {
    console.log(`\n  re-dispatched titles (continuation/redispatch churn):`);
    for (const [t, v] of r.dups.slice(0, 8))
      console.log(`    x${v.n} ${fmtMin(v.wall)} ${fmtTok(v.tin).padStart(6)}  ${sanitizeTitle(t).slice(0, 60)}`);
  }

  if (r.idleGaps.length) {
    console.log(`\n  parent idle >${PARENT_IDLE_MIN / 60}m (waiting on user/permissions): total ${fmtH(r.parentIdle)}`);
    for (const g of r.idleGaps.slice(0, 6))
      console.log(`    ${hhmm(g.from)} -> ${hhmm(g.to)}  ${fmtMin(g.sec)}`);
  }

  const stallPct = r.totWall ? (((r.totWall - r.totActive) / r.totWall) * 100) : 0;

  // Scheduling heuristics (from child create/update timestamps only).
  const sc = r.sched;
  console.log(`\n  scheduling (heuristics; capacity ${sc.capacity} is a comparison ceiling, not evidence work was ready):`);
  console.log(`    initial burst: ${sc.burstCount}/${sc.childCount} started within ${(BURST_WINDOW_MS / 1000).toFixed(0)}s of first start (${(sc.burstShare * 100).toFixed(0)}%)`);
  console.log(`    start after most recent prior completion: n=${sc.gapCount} median ${sc.gapMedian == null ? "-" : fmtMin(sc.gapMedian)} max ${sc.gapMax == null ? "-" : fmtMin(sc.gapMax)}`);
  console.log(`    peak headroom vs ${sc.capacity}: ${sc.peakHeadroom} (peak concurrency ${sc.peak})${sc.peakOverCapacity ? ` | OVER capacity by ${sc.peakOverCapacity}` : ""} | avg utilization ${(sc.avgUtilization * 100).toFixed(0)}%`);
  console.log(`    NOTE: ready timestamps / queue state are NOT persisted. ready-but-undispatched count and true ready-to-dispatch / refill latency are UNAVAILABLE. burst/gaps above are heuristics only.`);

  if (sc.invalidChildCount > 0) {
    console.log(`\n  WARNING: ${sc.invalidChildCount} of ${sc.inputChildCount} child records ignored for scheduling (invalid/missing timestamps or time_updated < time_created).`);
  }

  console.log(`\n  VERDICT: ${stallPct > 40 ? "STALL-DOMINATED - herd waited more than worked; check step limits and continuation latency" : stallPct > 20 ? "moderate stalling; review worst stalls above" : "healthy duty cycle"}`);
}

function runCli() {
  console.log(SHEEP_BANNER); // exactly once per CLI invocation, before DB access
  db = openDb();
  const arg = process.argv[2] || "";

  if (arg === "--list") {
    for (const s of shepherdSessions())
      console.log(`${new Date(s.time_created).toISOString().slice(0, 16)}  ${(((s.time_updated - s.time_created) / 3600000)).toFixed(1).padStart(5)}h  ${s.id}  ${sanitizeTitle(s.title).slice(0, 60)}`);
  } else if (arg === "--all") {
    for (const s of shepherdSessions()) {
      const r = analyze(s.id);
      const stallPct = r.totWall ? (((r.totWall - r.totActive) / r.totWall) * 100).toFixed(0) : 0;
      const sc = r.sched;
      const burstField = sc.childCount ? `${sc.burstCount}/${sc.childCount}:${Math.round(sc.burstShare * 100)}%` : "-";
      const headField = sc.childCount ? (sc.peakOverCapacity ? `over${sc.peakOverCapacity}` : String(sc.peakHeadroom)) : "-";
      const invalidField = sc.invalidChildCount > 0 ? ` invalid:${sc.invalidChildCount}` : "";
      console.log(`${new Date(s.time_created).toISOString().slice(0, 16)} ${(((s.time_updated - s.time_created) / 3600000)).toFixed(1).padStart(6)}h sheep:${String(r.kids.length).padStart(3)}/tasks:${String(r.taskCalls).padStart(3)} stall:${String(stallPct).padStart(3)}% idle:${fmtH(r.parentIdle).padStart(5)} q:${r.questionCalls} peak:${r.peak} burst:${burstField} head:${headField}${invalidField}  ${sanitizeTitle(s.title).slice(0, 45)}`);
    }
  } else {
    const sid = arg || shepherdSessions(1)[0]?.id;
    if (!sid) {
      console.error("no shepherd sessions found");
      process.exit(1);
    }
    printFull(sid);
  }
}

if (require.main === module) runCli();

module.exports = { SHEEP_BANNER, computeSchedulingMetrics, median, sanitizeTitle, DEFAULT_CAPACITY, BURST_WINDOW_MS };
