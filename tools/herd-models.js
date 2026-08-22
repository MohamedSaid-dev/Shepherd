// Print the Shepherd herd runtime settings from an opencode.json agent block.
// Usage: node tools/herd-models.js [configPath] [--check]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const doCheck = args.includes('--check');
const positional = args.filter((arg) => arg !== '--check');
const configPath = positional[0] ?? path.join(__dirname, '..', '.config', 'opencode', 'opencode.json');

let raw;
try {
  raw = fs.readFileSync(configPath, 'utf8');
} catch (err) {
  console.error(`error: cannot read ${configPath}: ${err?.message ?? err}`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(raw);
} catch (err) {
  console.error(`error: failed to parse ${configPath}: ${err?.message ?? err}`);
  process.exit(1);
}

const agents = cfg?.agent;
if (!agents || typeof agents !== 'object' || Array.isArray(agents) || Object.keys(agents).length === 0) {
  console.error('no agent block found');
  process.exit(1);
}

const rows = Object.entries(agents)
  .map(([agent, value]) => {
    const model = value?.model ?? '-';
    const variant = value?.variant ?? '-';
    const tempRaw = value?.temperature;
    const stepsRaw = value?.steps;

    const temp = tempRaw == null ? '-' : Number(tempRaw).toString();
    const steps = stepsRaw == null ? '-' : String(Math.trunc(stepsRaw));

    return { agent, model, variant, temp, steps };
  })
  .sort((a, b) => a.agent.localeCompare(b.agent));

let modelList = '';
let checkRows;
if (doCheck) {
  const res = spawnSync('opencode models', { encoding: 'utf8', shell: true, timeout: 60000 });
  if (res.error || res.status !== 0) {
    const reason = res.error?.message ?? `exit code ${res.status}`;
    console.error(`model check skipped: ${reason}`);
    process.exit(0);
  }
  modelList = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const ids = new Set(
    modelList
      .split(/\s+/)
      .map((t) => t.replace(/^\u001b\[[0-9;]*m/g, '').replace(/\u001b\[[0-9;]*m/g, '').trim())
      .filter((t) => t.includes('/'))
  );
  if (ids.size === 0) {
    console.error('model check skipped: no model IDs parsed from opencode models');
    process.exit(0);
  }
  checkRows = rows.map((r) => ({ ...r, status: ids.has(r.model) ? 'OK' : 'UNKNOWN' }));
} else {
  checkRows = rows;
}

const headers = doCheck
  ? ['Agent', 'Model', 'Variant', 'Temp', 'Steps', 'Status']
  : ['Agent', 'Model', 'Variant', 'Temp', 'Steps'];

const cols = headers.map((h, i) => h.length);
for (const r of checkRows) {
  cols[0] = Math.max(cols[0], r.agent.length);
  cols[1] = Math.max(cols[1], String(r.model).length);
  cols[2] = Math.max(cols[2], String(r.variant).length);
  cols[3] = Math.max(cols[3], String(r.temp).length);
  cols[4] = Math.max(cols[4], String(r.steps).length);
  if (doCheck) {
    cols[5] = Math.max(cols[5], String(r.status).length);
  }
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

const lines = [];
lines.push([
  pad(headers[0], cols[0]),
  pad(headers[1], cols[1]),
  pad(headers[2], cols[2]),
  pad(headers[3], cols[3]),
  pad(headers[4], cols[4]),
  ...(doCheck ? [pad(headers[5], cols[5])] : []),
]
  .join(' | '));

for (const r of checkRows) {
  const colsValues = [
    pad(r.agent, cols[0]),
    pad(r.model, cols[1]),
    pad(r.variant, cols[2]),
    pad(r.temp, cols[3]),
    pad(r.steps, cols[4]),
  ];
  if (doCheck) {
    colsValues.push(pad(r.status, cols[5]));
  }
  lines.push(colsValues.join(' | '));
}

console.log(lines.join('\n'));

if (doCheck) {
  const unknown = checkRows.filter((r) => r.status === 'UNKNOWN').length;
  const total = checkRows.length;
  const ok = total - unknown;
  console.log(`${ok}/${total} model IDs found in opencode models`);
  if (unknown > 0) process.exit(1);
}
