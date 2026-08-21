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

const db = openDb();
const arg = process.argv[2] || "";
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

  // concurrency: peak and time-weighted average over the herd window
  let peak = 0, twa = 0;
  if (kids.length) {
    const t0 = Math.min(...kids.map((k) => k.time_created));
    const t1 = Math.max(...kids.map((k) => k.time_updated));
    const STEP = 60000;
    let buckets = 0, sum = 0;
    for (let t = t0; t < t1; t += STEP) {
      let al = 0;
      for (const k of kids) if (k.time_created <= t && k.time_updated > t) al++;
      peak = Math.max(peak, al); sum += al; buckets++;
    }
    twa = buckets ? sum / buckets : 0;
  }

  const dups = Object.entries(dup).filter(([, v]) => v.n > 1).sort((a, b) => b[1].n - a[1].n);
  return { parent, kids, byAgent, stalls, dups, totWall, totActive, totIn, totOut, parentIdle, idleGaps, questionCalls, taskCalls, peak, twa };
}

function printFull(sid) {
  const r = analyze(sid);
  const p = r.parent;
  const wallH = (p.time_updated - p.time_created) / 3600000;
  console.log(`\nHERD REPORT  ${p.id}`);
  console.log(`  ${p.title || "(untitled)"}`);
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
      console.log(`    ${new Date(s.start).toISOString().slice(5, 16)} ${s.agent.padEnd(13)} stalled ${fmtMin(s.stall)} of ${fmtMin(s.wall)}  ${s.title.slice(0, 50)}`);
  }

  if (r.dups.length) {
    console.log(`\n  re-dispatched titles (continuation/redispatch churn):`);
    for (const [t, v] of r.dups.slice(0, 8))
      console.log(`    x${v.n} ${fmtMin(v.wall)} ${fmtTok(v.tin).padStart(6)}  ${t.slice(0, 60)}`);
  }

  if (r.idleGaps.length) {
    console.log(`\n  parent idle >${PARENT_IDLE_MIN / 60}m (waiting on user/permissions): total ${fmtH(r.parentIdle)}`);
    for (const g of r.idleGaps.slice(0, 6))
      console.log(`    ${hhmm(g.from)} -> ${hhmm(g.to)}  ${fmtMin(g.sec)}`);
  }

  const stallPct = r.totWall ? (((r.totWall - r.totActive) / r.totWall) * 100) : 0;
  console.log(`\n  VERDICT: ${stallPct > 40 ? "STALL-DOMINATED - herd waited more than worked; check step limits and continuation latency" : stallPct > 20 ? "moderate stalling; review worst stalls above" : "healthy duty cycle"}`);
}

if (arg === "--list") {
  for (const s of shepherdSessions())
    console.log(`${new Date(s.time_created).toISOString().slice(0, 16)}  ${(((s.time_updated - s.time_created) / 3600000)).toFixed(1).padStart(5)}h  ${s.id}  ${(s.title || "").slice(0, 60)}`);
} else if (arg === "--all") {
  for (const s of shepherdSessions()) {
    const r = analyze(s.id);
    const stallPct = r.totWall ? (((r.totWall - r.totActive) / r.totWall) * 100).toFixed(0) : 0;
    console.log(`${new Date(s.time_created).toISOString().slice(0, 16)} ${(((s.time_updated - s.time_created) / 3600000)).toFixed(1).padStart(6)}h sheep:${String(r.kids.length).padStart(3)}/tasks:${String(r.taskCalls).padStart(3)} stall:${String(stallPct).padStart(3)}% idle:${fmtH(r.parentIdle).padStart(5)} q:${r.questionCalls} peak:${r.peak}  ${(s.title || "").slice(0, 45)}`);
  }
} else {
  const sid = arg || shepherdSessions(1)[0]?.id;
  if (!sid) {
    console.error("no shepherd sessions found");
    process.exit(1);
  }
  printFull(sid);
}
