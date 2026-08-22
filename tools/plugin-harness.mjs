// plugin-harness.mjs — assertion harness for the frozen policy contract of
// .config/opencode/plugin/shepherd.ts. Run from repo root:
//   node --experimental-strip-types tools/plugin-harness.mjs
// No dependencies, no test framework, plain Node.

const pluginUrl = new URL("../.config/opencode/plugin/shepherd.ts", import.meta.url);

let mod;
try {
  mod = await import(pluginUrl.href);
} catch (err) {
  console.error(`IMPORT FAILED: ${err && err.stack ? err.stack : String(err)}`);
  process.exitCode = 1;
  process.exit(1);
}

const { isSheepAgent, bashDecision } = mod;
if (typeof isSheepAgent !== "function" || typeof bashDecision !== "function") {
  console.error("IMPORT FAILED: expected exports isSheepAgent and bashDecision not found");
  process.exitCode = 1;
  process.exit(1);
}

const deny = (agent, command) => ({ agent, command, expected: "deny" });
const allow = (agent, command) => ({ agent, command, expected: "allow" });
const ask = (agent, command) => ({ agent, command, expected: "ask" });

const cases = [
  // isSheepAgent: true iff non-empty string starting with "sheep-"
  { agent: "sheep-fast", command: null, expected: true },
  { agent: "shepherd", command: null, expected: false },
  { agent: "sheep-", command: null, expected: true },
  { agent: "", command: null, expected: false },
  { agent: null, command: null, expected: false },
  { agent: undefined, command: null, expected: false },
  // deny: git write ops
  deny("sheep-fast", "git push"),
  deny("sheep-fast", "git push --force origin main"),
  deny("sheep-fast", "git commit -m x"),
  deny("sheep-fast", "git branch -D feat"),
  deny("sheep-fast", "git checkout -- ."),
  // deny: package managers
  deny("sheep-fast", "npm install"),
  deny("sheep-fast", "npm i"),
  deny("sheep-fast", "npm i lodash"),
  deny("sheep-fast", "pnpm add left-pad"),
  deny("sheep-fast", "yarn install"),
  deny("sheep-fast", "bun add react"),
  // deny: destructive
  deny("sheep-fast", "rm -rf ./x"),
  deny("sheep-fast", "rm -fr x"),
  // deny: docker
  deny("sheep-fast", "docker"),
  deny("sheep-fast", "docker ps"),
  deny("sheep-fast", "docker-compose up"),
  // deny: leading/trailing whitespace is trimmed
  deny("sheep-fast", "  npm install  "),
  // allow: playwright
  allow("sheep-test", "npx playwright test"),
  allow("sheep-test", "npx playwright test tests/foo.spec.ts"),
  // allow: run scripts whose first token contains test/lint/type/check (case-insensitive)
  allow("sheep-test", "npm run test:unit"),
  allow("sheep-test", "pnpm run lint"),
  allow("sheep-test", "bun run typecheck"),
  allow("sheep-test", "yarn test"),
  allow("sheep-test", "yarn run check"),
  allow("sheep-ui", "npm run Lint"),
  // ask: everything else
  ask("sheep-fast", "git status"),
  ask("sheep-fast", "ls -la"),
  ask("sheep-fast", "cargo build"),
  ask("sheep-fast", "npm run build"),
  ask("sheep-fast", "yarn build"),
  ask("sheep-fast", "npm run"),
  ask("sheep-fast", ""),
  ask("sheep-fast", "   "),
  // ask: boundary — prefix must end at a token boundary
  ask("sheep-fast", "dockerlogs"),
  ask("sheep-fast", "npm installx"),
  ask("sheep-fast", "git pushx"),
  ask("sheep-fast", "npx playwright install"),
  // ask: non-sheep agents pass through
  ask("shepherd", "git push"),
  ask(null, "npm install"),
  ask(undefined, "rm -rf /"),
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const actual = c.command === null ? isSheepAgent(c.agent) : bashDecision(c.agent, c.command);
  const ok = actual === c.expected;
  if (ok) passed += 1;
  else failed += 1;
  const label = c.command === null ? "isSheepAgent" : "bashDecision";
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label} agent=${JSON.stringify(c.agent)} command=${JSON.stringify(c.command)} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(actual)}`,
  );
}

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
