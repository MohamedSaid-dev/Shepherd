// plugin-harness.mjs — assertion harness for the frozen policy contract of
// .config/opencode/plugin/shepherd.ts. Run from repo root:
//   node --experimental-strip-types tools/plugin-harness.mjs
// No dependencies, no test framework, plain Node.
//
// Freezes the maximum-autonomy security contract (strict token grammar, NOT
// shell emulation):
//   - isSheepAgent: true iff non-empty string starting with "sheep-"
//   - tokenizeSegment: quote-aware tokenizer -> normalized argv, or reject
//   - parseChain: split on ; | && || (outside quotes) + tokenize each segment
//   - classifySegment(argv): deny wins, explicit safe shapes allow, else ask
//   - bashDecision: deny if any segment denied; allow only if every segment
//     is explicitly safe; malformed chains and unknown commands -> ask

import { promises as fs } from "node:fs";

// Patch ledger writes to no-ops so pure/hook tests never touch the real ledger.
const _origAppendFile = fs.appendFile;
const _origMkdir = fs.mkdir;
let ledgerWrites = [];
let fsPatched = true;
try {
  fs.appendFile = async () => { ledgerWrites.push("append"); };
  fs.mkdir = async () => undefined;
  fsPatched = fs.appendFile !== _origAppendFile;
} catch {
  fsPatched = false;
}

const pluginUrl = new URL("../.config/opencode/plugin/shepherd.ts", import.meta.url);

let mod;
try {
  mod = await import(pluginUrl.href);
} catch (err) {
  console.error(`IMPORT FAILED: ${err && err.stack ? err.stack : String(err)}`);
  process.exitCode = 1;
  process.exit(1);
}

const { isSheepAgent, bashDecision, parseChain, tokenizeSegment, classifySegment } = mod;
for (const name of ["isSheepAgent", "bashDecision", "parseChain", "tokenizeSegment", "classifySegment"]) {
  if (typeof mod[name] !== "function") {
    console.error(`IMPORT FAILED: expected export ${name} not found`);
    process.exitCode = 1;
    process.exit(1);
  }
}

const deny = (agent, command) => ({ agent, command, expected: "deny" });
const allow = (agent, command) => ({ agent, command, expected: "allow" });
const ask = (agent, command) => ({ agent, command, expected: "ask" });

// ---------------------------------------------------------------------------
// isSheepAgent: true iff non-empty string starting with "sheep-"
// ---------------------------------------------------------------------------
const agentCases = [
  { agent: "sheep-fast", expected: true },
  { agent: "shepherd", expected: false },
  { agent: "sheep-", expected: true },
  { agent: "", expected: false },
  { agent: null, expected: false },
  { agent: undefined, expected: false },
];

// ---------------------------------------------------------------------------
// bashDecision: full command decisions (agent + command)
// ---------------------------------------------------------------------------
const decisionCases = [
  // deny: git write ops (original)
  deny("sheep-fast", "git push"),
  deny("sheep-fast", "git push --force origin main"),
  deny("sheep-fast", "git commit -m x"),
  deny("sheep-fast", "git branch -D feat"),
  deny("sheep-fast", "git checkout -- ."),
  // deny: package managers (original)
  deny("sheep-fast", "npm install"),
  deny("sheep-fast", "npm i"),
  deny("sheep-fast", "npm i lodash"),
  deny("sheep-fast", "pnpm add left-pad"),
  deny("sheep-fast", "yarn install"),
  deny("sheep-fast", "bun add react"),
  // deny: destructive (original)
  deny("sheep-fast", "rm -rf ./x"),
  deny("sheep-fast", "rm -fr x"),
  // deny: docker (original)
  deny("sheep-fast", "docker"),
  deny("sheep-fast", "docker ps"),
  deny("sheep-fast", "docker-compose up"),
  // deny: leading/trailing whitespace is trimmed (original)
  deny("sheep-fast", "  npm install  "),
  // allow: playwright only via local-only npx flag (final contract)
  ask("sheep-test", "npx playwright test"),
  ask("sheep-test", "npx playwright test tests/foo.spec.ts"),
  allow("sheep-test", "npx --no-install playwright test"),
  ask("sheep-test", "npx --offline playwright test"),
  ask("sheep-fast", "npx --no-install vitest"),
  allow("sheep-fast", "npx --no-install jest"),
  ask("sheep-fast", "npx --no-install tsc"),
  allow("sheep-fast", "npx --no-install eslint"),
  // npx local-only gate: bare / flag-after / watch / unknown tool all ask
  ask("sheep-fast", "npx --no-install playwright"),
  ask("sheep-fast", "npx playwright --no-install test"),
  ask("sheep-fast", "npx --no-install playwright test --watch"),
  ask("sheep-fast", "npx --no-install eslint --watch"),
  ask("sheep-fast", "npx --no-install webpack"),
  // allow: run scripts whose first token contains test/lint/type/check (original)
  allow("sheep-test", "npm run test:unit"),
  allow("sheep-test", "pnpm run lint"),
  allow("sheep-test", "bun run typecheck"),
  allow("sheep-test", "yarn test"),
  allow("sheep-test", "yarn run check"),
  // allow: bare package-runner family form (final contract)
  allow("sheep-test", "npm test"),
  allow("sheep-test", "pnpm lint"),
  allow("sheep-test", "yarn check"),
  allow("sheep-test", "bun typecheck"),
  // ask: case-sensitive family + contest/watch/dev/build/serve/server
  ask("sheep-ui", "npm run Lint"),
  ask("sheep-test", "npm run contest"),
  ask("sheep-test", "npm run test:contest"),
  ask("sheep-test", "npm run dev"),
  ask("sheep-test", "npm run build"),
  ask("sheep-test", "npm run serve"),
  ask("sheep-test", "npm run server"),
  ask("sheep-test", "npm run watch"),
  // ask: everything else (original; git status intentionally changed to allow)
  allow("sheep-fast", "git status"),
  ask("sheep-fast", "ls -la"),
  ask("sheep-fast", "cargo build"),
  ask("sheep-fast", "npm run build"),
  ask("sheep-fast", "yarn build"),
  ask("sheep-fast", "npm run"),
  ask("sheep-fast", ""),
  ask("sheep-fast", "   "),
  // ask: boundary — prefix must end at a token boundary (original)
  ask("sheep-fast", "dockerlogs"),
  ask("sheep-fast", "npm installx"),
  ask("sheep-fast", "git pushx"),
  ask("sheep-fast", "npx playwright install"),
  // ask: non-sheep agents pass through (original)
  ask("shepherd", "git push"),
  ask(null, "npm install"),
  ask(undefined, "rm -rf /"),

  // allow: read-only git
  allow("sheep-fast", "git status --short"),
  allow("sheep-fast", "git diff"),
  allow("sheep-fast", "git diff HEAD~1 HEAD"),
  allow("sheep-fast", "git log --oneline -5"),
  allow("sheep-fast", "git show HEAD"),
  allow("sheep-fast", "git ls-files"),
  // ask: git read-only with output/external/textconv filters
  ask("sheep-fast", "git status --output out.txt"),
  ask("sheep-fast", "git diff --ext-diff"),
  ask("sheep-fast", "git log --textconv"),
  ask("sheep-fast", "git show --output=x"),
  // ask: git read-only with escaped/expanded dangerous-flag variants
  ask("sheep-fast", "git status --output=out.txt"),
  ask("sheep-fast", "git diff --ext-diff=x"),
  ask("sheep-fast", "git log --textconv=x"),
  ask("sheep-fast", "git diff --ext-diff$(x)"),
  ask("sheep-fast", "git log --textconv$x"),

  // allow: ripgrep read-only search
  allow("sheep-fast", "rg foo"),
  allow("sheep-fast", "rg -i pattern src/"),
  // ask: rg preprocessor executes an arbitrary command
  ask("sheep-fast", "rg --pre cmd"),
  ask("sheep-fast", "rg --pre=cmd"),
  // ask: rg preprocessor escaped/expanded variants
  ask("sheep-fast", "rg --pre=$(x)"),
  ask("sheep-fast", "rg --pre\"cmd\""),

  // allow: PowerShell read-only cmdlets (case-insensitive)
  allow("sheep-fast", "Get-Content foo.txt"),
  allow("sheep-fast", "get-content foo.txt"),
  allow("sheep-fast", "Test-Path x"),
  allow("sheep-fast", "Get-FileHash x"),
  allow("sheep-fast", "Select-String foo"),
  allow("sheep-fast", "Resolve-Path x"),
  allow("sheep-fast", "Write-Output hi"),
  allow("sheep-fast", "Write-Host hi"),

  // allow: node version probe / syntax check / harness & utility scripts
  allow("sheep-fast", "node --version"),
  allow("sheep-fast", "node -v"),
  allow("sheep-fast", "node -c tools/plugin-harness.mjs"),
  allow("sheep-fast", "node --check tools/plugin-harness.mjs"),
  allow("sheep-fast", "node --check tools/foo.js"),
  allow("sheep-fast", "node tools/plugin-harness.mjs"),
  allow("sheep-fast", "node tools/herd-report.js"),
  allow("sheep-fast", "node tools/herd-models.js"),
  allow("sheep-fast", "node tools/herd-report-harness.mjs"),
  allow("sheep-fast", "node --experimental-strip-types tools/plugin-harness.mjs"),
  allow("sheep-fast", "node --experimental-strip-types tools/herd-report.js"),
  // ask: node arbitrary code / unknown flags / arbitrary scripts
  ask("sheep-fast", "node"),
  ask("sheep-fast", "node -e \"console.log(1)\""),
  ask("sheep-fast", "node --eval \"x\""),
  ask("sheep-fast", "node -p \"1+1\""),
  ask("sheep-fast", "node --print \"x\""),
  ask("sheep-fast", "node -r dotenv tools/foo.js"),
  ask("sheep-fast", "node --require dotenv tools/foo.js"),
  ask("sheep-fast", "node --import x tools/foo.js"),
  ask("sheep-fast", "node --inspect tools/plugin-harness.mjs"),
  ask("sheep-fast", "node --inspect-brk tools/plugin-harness.mjs"),
  ask("sheep-fast", "node --unknown-flag tools/plugin-harness.mjs"),
  ask("sheep-fast", "node --experimental-strip-types --inspect tools/plugin-harness.mjs"),
  ask("sheep-fast", "node --experimental-strip-types tools/foo.js"),
  ask("sheep-fast", "node tools/foo.js"),
  ask("sheep-fast", "node src/index.js"),
  // ask: node arbitrary/external script paths (absolute / parent / unknown)
  ask("sheep-fast", "node /abs/path/foo.js"),
  ask("sheep-fast", "node ../foo.js"),
  ask("sheep-fast", "node tools/herd-other.js"),
  // ask: node --check requires exactly one script path
  ask("sheep-fast", "node --check foo"),
  ask("sheep-fast", "node --check a.js b.js"),
  ask("sheep-fast", "node --check --experimental-strip-types a.js"),
  // ask: version probe with extra arguments
  ask("sheep-fast", "node --version extra"),
  ask("sheep-fast", "node -v extra"),

  // allow: compound chains where every segment is safe
  allow("sheep-fast", "git status && git diff"),
  allow("sheep-fast", "git status; git diff"),
  allow("sheep-fast", "git status | rg -q diff"),
  allow("sheep-fast", "git status || git diff"),
  allow("sheep-fast", "git status && git log '--grep=a;b'"),
  // ask: safe + unknown
  ask("sheep-fast", "git status && ls -la"),
  ask("sheep-fast", "git status && node -e \"x\""),
  // deny: mixed chain — any denied segment denies the whole chain
  deny("sheep-fast", "git status && npm install"),
  deny("sheep-fast", "npm install && git status"),
  deny("sheep-fast", "git status; npm install; git diff"),
  deny("sheep-fast", "git status | npm install"),
  deny("sheep-fast", "git status || npm install"),

  // allow: fully-quoted tokens keep content literal (single/double, at token start)
  allow("sheep-fast", "git log '--grep=a;b'"),
  ask("sheep-fast", "git log '--grep=a|b'"),
  ask("sheep-fast", "git log '--grep=a&&b'"),
  ask("sheep-fast", "git log '--grep=a||b'"),
  allow("sheep-fast", "git log '--grep=$(x)'"),
  allow("sheep-fast", "git log '--grep=`x`'"),
  allow("sheep-fast", "git log \"--grep=a;b\""),
  // ask: mid-token quotes are concatenation and rejected (strict grammar)
  ask("sheep-fast", "git log --grep='a;b'"),
  ask("sheep-fast", "git log --grep=\"a;b\""),
  ask("sheep-fast", "git log --grep='$(x)'"),
  ask("sheep-fast", "git log --grep='`x`'"),
  // ask: single-quoted literal at token start, but command category is unknown
  ask("sheep-fast", "echo 'a;b'"),
  ask("sheep-fast", "echo 'a|b'"),

  // ask: malformed chains never guess
  ask("sheep-fast", "git status \"unclosed"),
  ask("sheep-fast", "git status;"),
  ask("sheep-fast", "git status &&"),
  ask("sheep-fast", "git status && ; git diff"),
  ask("sheep-fast", "git status &"),
  ask("sheep-fast", "(git status)"),
  ask("sheep-fast", "{ git status; }"),
  ask("sheep-fast", "git status > out.txt"),
  ask("sheep-fast", "git status < in.txt"),
  ask("sheep-fast", "git status 2>&1"),
  ask("sheep-fast", "git status\n git diff"),
  ask("sheep-fast", "git status\r\n git diff"),
  ask("sheep-fast", "git log --grep=\"a`b\""),
  ask("sheep-fast", "git log --grep=\"$(x)\""),
  ask("sheep-fast", "echo `date`"),

  // ask: reviewer bypasses — escaped quote chain
  ask("sheep-fast", "echo \" && npm install"),
  // ask: reviewer bypasses — quote concatenation
  ask("sheep-fast", "npm' install'"),
  ask("sheep-fast", "git' status'"),
  // ask: reviewer bypasses — all unquoted expansion markers
  ask("sheep-fast", "git status $VAR"),
  ask("sheep-fast", "git status %PATH%"),
  ask("sheep-fast", "git status !cmd"),
  ask("sheep-fast", "git status ^x"),
  ask("sheep-fast", "git status `cmd`"),
  // ask: reviewer bypasses — all double-quoted expansion markers
  ask("sheep-fast", "git status \"$VAR\""),
  ask("sheep-fast", "git status \"%PATH%\""),
  ask("sheep-fast", "git status \"!cmd\""),
  ask("sheep-fast", "git status \"^x\""),
  ask("sheep-fast", "git status \"`cmd`\""),
  // ask: reviewer bypasses — globs / control constructs
  ask("sheep-fast", "git status *.txt"),
  ask("sheep-fast", "git status file?"),
  ask("sheep-fast", "git status [abc]"),
  ask("sheep-fast", "(git status)"),
  ask("sheep-fast", "{ git status; }"),

  // ask: watch/server/dev/build/ui modes are long-running
  ask("sheep-test", "npx playwright test --watch"),
  ask("sheep-test", "npx playwright test --ui"),
  ask("sheep-test", "npx playwright test --dev"),
  ask("sheep-test", "npx playwright test --server"),
  ask("sheep-test", "npx playwright test --build"),
  ask("sheep-test", "npm run test -- --watch"),
  ask("sheep-test", "npm run test:watch"),
  ask("sheep-test", "npm run test:server"),
  ask("sheep-test", "npm run serve"),
  ask("sheep-test", "yarn test --watch"),
  ask("sheep-test", "pnpm run lint --watch"),

  // ask: prefix-lookalikes remain ask
  ask("sheep-fast", "git statusx"),
  ask("sheep-fast", "git diffx"),
  ask("sheep-fast", "rgx foo"),
  ask("sheep-fast", "nodex --version"),
  ask("sheep-fast", "Get-Contentx"),
  ask("sheep-fast", "npx playwright testx"),

  // allow: Windows backslash path parses (normalized) to exact allowlist
  ask("sheep-fast", "node tools\\plugin-harness.mjs"),
  ask("sheep-fast", "node tools\\herd-report.js"),
  // ask: arbitrary Windows node path asks (outside repo / not allowlisted)

  // --- regressions (strict v3 alignment) ---

  // post-close adjacency: a quote immediately followed by a char is concatenation
  ask("sheep-fast", 'rg "--pr"e=cmd'),
  ask("sheep-fast", 'git diff "--ou"tput=...'),
  ask("sheep-fast", "git 'pu'sh"),

  // single-quoted % ! ^ & | < > are control chars (rejected); ; $ ` stay literal
  ask("sheep-fast", "git log '--grep=a%b'"),
  ask("sheep-fast", "git log '--grep=a!b'"),
  ask("sheep-fast", "git log '--grep=a^b'"),
  ask("sheep-fast", "git log '--grep=a<b'"),
  ask("sheep-fast", "git log '--grep=a>b'"),
  allow("sheep-fast", "git log '--grep=x;y'"),
  allow("sheep-fast", "git log '--grep=a$b'"),
  allow("sheep-fast", "git log '--grep=x`y`'"),

  // unquoted @ (splat) asks
  ask("sheep-fast", "git status @"),

  // git read-only with -o (short --output) asks
  ask("sheep-fast", "git diff -o"),
  ask("sheep-fast", "git diff -o out.txt"),
  // git read-only with attached -o forms (no space / =) ask
  ask("sheep-fast", "git diff -oout.txt"),
  ask("sheep-fast", "git diff -o=out.txt"),

  // uppercase / aliases hard deny (case-insensitive deny)
  deny("sheep-fast", "git PUSH"),
  deny("sheep-fast", "GIT push"),
  deny("sheep-fast", "git RESET --hard"),
  deny("sheep-fast", "npm INSTALL"),
  deny("sheep-fast", "NPM i"),
  deny("sheep-fast", "git Branch -d feat"),

  // `test:` (empty suffix) asks; nonempty family allows
  ask("sheep-test", "npm run test:"),
  allow("sheep-test", "npm run test:foo"),
  allow("sheep-test", "pnpm run lint:check"),

  // package trailing args: empty or exact `--` separator only; watch after `--` asks
  ask("sheep-test", "npm run test:unit extra"),
  allow("sheep-test", "npm run test:unit -- extra"),
  allow("sheep-test", "npm test -- foo"),
  ask("sheep-test", "yarn check foo"),
  ask("sheep-test", "bun typecheck --x"),
  ask("sheep-test", "npm run test:unit -- --watch"),
  ask("sheep-test", "npm run test:unit watch"),
  ask("sheep-test", "npm run test:unit --watch"),

  // npx local-only: --offline asks; exact tool shapes allow/ask
  ask("sheep-test", "npx --offline playwright test"),
  allow("sheep-test", "npx --no-install playwright test"),
  ask("sheep-fast", "npx --no-install vitest"),
  allow("sheep-fast", "npx --no-install vitest run"),
  ask("sheep-fast", "npx --no-install tsc"),
  allow("sheep-fast", "npx --no-install tsc --noEmit"),
  ask("sheep-fast", "npx --no-install eslint --fix"),
  ask("sheep-fast", "npx --no-install eslint --fix=1"),
  allow("sheep-fast", "npx --no-install eslint"),
  allow("sheep-fast", "npx --no-install jest"),
  ask("sheep-fast", "npx --no-install jest --watch"),

  // watch/ui/dev/build/server `=...` variants ask
  ask("sheep-test", "npx --no-install playwright test --watch=1"),
  ask("sheep-test", "npx --no-install playwright test --ui=1"),
  ask("sheep-test", "npm run test:unit --dev=1"),
  ask("sheep-test", "npm run test:unit --build=1"),
  ask("sheep-test", "npm run test:unit --server=1"),
  ask("sheep-fast", "npx --no-install vitest run --watch=1"),
  ask("sheep-fast", "node C:\\Users\\x\\foo.js"),
  ask("sheep-fast", "node D:\\tools\\plugin-harness.mjs"),
];

// ---------------------------------------------------------------------------
// parseChain: quote-aware chain splitting into normalized argv segments
// ---------------------------------------------------------------------------
const parseCases = [
  { command: "git status && git diff", ok: true, segments: [["git", "status"], ["git", "diff"]] },
  { command: "git status;git diff", ok: true, segments: [["git", "status"], ["git", "diff"]] },
  { command: "git status | git diff", ok: true, segments: [["git", "status"], ["git", "diff"]] },
  { command: "git status || git diff", ok: true, segments: [["git", "status"], ["git", "diff"]] },
  // fully-quoted separators stay inside one segment (valid token-start quote)
  { command: "git log '--grep=a;b'", ok: true, segments: [["git", "log", "--grep=a;b"]] },
  { command: 'git log "--grep=a;b"', ok: true, segments: [["git", "log", "--grep=a;b"]] },
  { command: "git log '--grep=$(x)'", ok: true, segments: [["git", "log", "--grep=$(x)"]] },
  { command: "git log '--grep=`x`'", ok: true, segments: [["git", "log", "--grep=`x`"]] },
  // malformed input is rejected, never guessed
  { command: 'git status "unclosed', ok: false, reason: "unmatched-quote" },
  { command: "git status;", ok: false, reason: "empty-segment" },
  { command: "git status &&", ok: false, reason: "empty-segment" },
  { command: "git status && ; git diff", ok: false, reason: "empty-segment" },
  { command: "git status &", ok: false, reason: "unsupported-ampersand" },
  { command: "(git status)", ok: false, reason: "control-construct" },
  { command: "{ git status; }", ok: false, reason: "control-construct" },
  { command: "git status > out.txt", ok: false, reason: "redirection" },
  { command: "git status < in.txt", ok: false, reason: "redirection" },
  { command: "git status 2>&1", ok: false, reason: "redirection" },
  { command: "git status\n git diff", ok: false, reason: "unquoted-newline" },
  { command: "git status\r\n git diff", ok: false, reason: "unquoted-newline" },
  { command: 'git log --grep="a`b"', ok: false, reason: "double-quote-expansion" },
  { command: 'git log --grep="$(x)"', ok: false, reason: "double-quote-expansion" },
  { command: "echo `date`", ok: false, reason: "backtick" },
  // mid-token quotes are concatenation, not segment-preserving quotes
  { command: "git log --grep='a;b'", ok: false, reason: "quote-concatenation" },
  { command: 'git log --grep="a;b"', ok: false, reason: "quote-concatenation" },
  { command: "git log --grep='$(x)'", ok: false, reason: "quote-concatenation" },
  { command: "git log --grep='`x`'", ok: false, reason: "quote-concatenation" },
];

// ---------------------------------------------------------------------------
// tokenizeSegment: normalized argv, or rejection of bypass syntax
// ---------------------------------------------------------------------------
const tokenizeCases = [
  // normalized argv (valid)
  { segment: "git status", ok: true, argv: ["git", "status"] },
  { segment: "git  status", ok: true, argv: ["git", "status"] },
  { segment: "git log '--grep=a;b'", ok: true, argv: ["git", "log", "--grep=a;b"] },
  { segment: 'git log "--grep=a;b"', ok: true, argv: ["git", "log", "--grep=a;b"] },
  { segment: "git log '--grep=$(x)'", ok: true, argv: ["git", "log", "--grep=$(x)"] },
  { segment: "echo 'a;b'", ok: true, argv: ["echo", "a;b"] },
  { segment: "echo 'a|b'", ok: false, reason: "single-quote-control" },
  { segment: "node tools\\plugin-harness.mjs", ok: false, reason: "backslash" },
  // rejections (bypass attempts)
  { segment: 'git status "unclosed', ok: false, reason: "unmatched-quote" },
  { segment: "npm' install'", ok: false, reason: "quote-concatenation" },
  { segment: "git' status'", ok: false, reason: "quote-concatenation" },
  { segment: "git status $VAR", ok: false, reason: "expansion" },
  { segment: "git status %PATH%", ok: false, reason: "env-expansion" },
  { segment: "git status !cmd", ok: false, reason: "history-expansion" },
  { segment: "git status ^x", ok: false, reason: "caret" },
  { segment: "git status `cmd`", ok: false, reason: "backtick" },
  { segment: 'git status "$VAR"', ok: false, reason: "double-quote-expansion" },
  { segment: 'git status "%PATH%"', ok: false, reason: "double-quote-expansion" },
  { segment: 'git status "!cmd"', ok: false, reason: "double-quote-expansion" },
  { segment: 'git status "^x"', ok: false, reason: "double-quote-expansion" },
  { segment: 'git status "`cmd`"', ok: false, reason: "double-quote-expansion" },
  { segment: "git status *.txt", ok: false, reason: "glob" },
  { segment: "git status file?", ok: false, reason: "glob" },
  { segment: "git status [abc]", ok: false, reason: "glob" },
  { segment: "git status > out.txt", ok: false, reason: "redirection" },
  { segment: "git status < in.txt", ok: false, reason: "redirection" },
  { segment: "(git status)", ok: false, reason: "control-construct" },
  { segment: "{ git status; }", ok: false, reason: "control-construct" },
  { segment: "git status\n git diff", ok: false, reason: "unquoted-newline" },
  { segment: "git status\r\n git diff", ok: false, reason: "unquoted-newline" },
  { segment: 'echo \\" && npm install', ok: false, reason: "backslash" },
  { segment: "git status --output\\ out.txt", ok: false, reason: "backslash" },
  { segment: 'git status ""', ok: false, reason: "empty-quoted-token" },
  // single-quoted control chars rejected
  { segment: "git log '--grep=a%b'", ok: false, reason: "single-quote-control" },
  { segment: "git log '--grep=a!b'", ok: false, reason: "single-quote-control" },
  { segment: "git log '--grep=a^b'", ok: false, reason: "single-quote-control" },
  { segment: "git log '--grep=a<b'", ok: false, reason: "single-quote-control" },
  { segment: "git log '--grep=a>b'", ok: false, reason: "single-quote-control" },
  // unquoted splat rejected
  { segment: "git status @x", ok: false, reason: "splat" },
  // post-close adjacency rejected (quote-concatenation)
  { segment: 'rg "--pr"e=cmd', ok: false, reason: "quote-concatenation" },
  { segment: "git 'pu'sh", ok: false, reason: "quote-concatenation" },
];

// ---------------------------------------------------------------------------
// classifySegment: single normalized-argv classification
// (argv obtained from tokenizeSegment; assert it, then classify)
// ---------------------------------------------------------------------------
const classifyCases = [
  { segment: "git status", argv: ["git", "status"], expected: "allow" },
  { segment: "git status --short", argv: ["git", "status", "--short"], expected: "allow" },
  { segment: "git diff", argv: ["git", "diff"], expected: "allow" },
  { segment: "git log --oneline -5", argv: ["git", "log", "--oneline", "-5"], expected: "allow" },
  { segment: "git show HEAD", argv: ["git", "show", "HEAD"], expected: "allow" },
  { segment: "git ls-files", argv: ["git", "ls-files"], expected: "allow" },
  { segment: "git status --output out.txt", argv: ["git", "status", "--output", "out.txt"], expected: "ask" },
  { segment: "git diff --ext-diff", argv: ["git", "diff", "--ext-diff"], expected: "ask" },
  { segment: "git diff -oout.txt", argv: ["git", "diff", "-oout.txt"], expected: "ask" },
  { segment: "git diff -o=out.txt", argv: ["git", "diff", "-o=out.txt"], expected: "ask" },
  { segment: "git log --textconv", argv: ["git", "log", "--textconv"], expected: "ask" },
  { segment: "git push", argv: ["git", "push"], expected: "deny" },
  { segment: "npm install", argv: ["npm", "install"], expected: "deny" },
  { segment: "rg foo", argv: ["rg", "foo"], expected: "allow" },
  { segment: "rg --pre cmd", argv: ["rg", "--pre", "cmd"], expected: "ask" },
  { segment: "rg --pre=cmd", argv: ["rg", "--pre=cmd"], expected: "ask" },
  { segment: "Get-Content foo.txt", argv: ["Get-Content", "foo.txt"], expected: "allow" },
  { segment: "get-content foo.txt", argv: ["get-content", "foo.txt"], expected: "allow" },
  { segment: "Write-Output hi", argv: ["Write-Output", "hi"], expected: "allow" },
  { segment: "node --version", argv: ["node", "--version"], expected: "allow" },
  { segment: "node -v", argv: ["node", "-v"], expected: "allow" },
  { segment: "node --check tools/plugin-harness.mjs", argv: ["node", "--check", "tools/plugin-harness.mjs"], expected: "allow" },
  { segment: "node --check foo", argv: ["node", "--check", "foo"], expected: "ask" },
  { segment: "node --check a.js b.js", argv: ["node", "--check", "a.js", "b.js"], expected: "ask" },
  { segment: 'node -e "x"', argv: ["node", "-e", "x"], expected: "ask" },
  { segment: 'node --print "x"', argv: ["node", "--print", "x"], expected: "ask" },
  { segment: "node --inspect tools/plugin-harness.mjs", argv: ["node", "--inspect", "tools/plugin-harness.mjs"], expected: "ask" },
  { segment: "node --experimental-strip-types tools/plugin-harness.mjs", argv: ["node", "--experimental-strip-types", "tools/plugin-harness.mjs"], expected: "allow" },
  { segment: "node --experimental-strip-types tools/foo.js", argv: ["node", "--experimental-strip-types", "tools/foo.js"], expected: "ask" },
  { segment: "node tools/plugin-harness.mjs", argv: ["node", "tools/plugin-harness.mjs"], expected: "allow" },
  { segment: "node tools/herd-report.js", argv: ["node", "tools/herd-report.js"], expected: "allow" },
  { segment: "node tools/foo.js", argv: ["node", "tools/foo.js"], expected: "ask" },
  { segment: "node", argv: ["node"], expected: "ask" },
  { segment: "npx --no-install playwright test", argv: ["npx", "--no-install", "playwright", "test"], expected: "allow" },
  { segment: "npx playwright test", argv: ["npx", "playwright", "test"], expected: "ask" },
  { segment: "npm run test:unit", argv: ["npm", "run", "test:unit"], expected: "allow" },
  { segment: "npm run dev", argv: ["npm", "run", "dev"], expected: "ask" },
  { segment: "ls -la", argv: ["ls", "-la"], expected: "ask" },
  { segment: "echo 'a;b'", argv: ["echo", "a;b"], expected: "ask" },
  { segment: "git statusx", argv: ["git", "statusx"], expected: "ask" },
  { segment: "git log '--grep=a;b'", argv: ["git", "log", "--grep=a;b"], expected: "allow" },
  { segment: "git log '--grep=$(x)'", argv: ["git", "log", "--grep=$(x)"], expected: "allow" },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function check(ok, label, detail) {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${label} ${detail}`);
  }
}

for (const c of agentCases) {
  const actual = isSheepAgent(c.agent);
  check(
    actual === c.expected,
    "isSheepAgent",
    `agent=${JSON.stringify(c.agent)} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(actual)}`,
  );
}

for (const c of decisionCases) {
  const actual = bashDecision(c.agent, c.command);
  check(
    actual === c.expected,
    "bashDecision",
    `agent=${JSON.stringify(c.agent)} command=${JSON.stringify(c.command)} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(actual)}`,
  );
}

for (const c of parseCases) {
  const actual = parseChain(c.command);
  const ok = c.ok
    ? actual.ok === true && JSON.stringify(actual.argvSegments) === JSON.stringify(c.segments)
    : actual.ok === false && actual.reason === c.reason;
  check(
    ok,
    "parseChain",
    `command=${JSON.stringify(c.command)} expected=${c.ok ? JSON.stringify(c.segments) : c.reason} actual=${JSON.stringify(actual)}`,
  );
}

for (const c of tokenizeCases) {
  const actual = tokenizeSegment(c.segment);
  const ok = c.ok
    ? actual.ok === true && JSON.stringify(actual.argv) === JSON.stringify(c.argv)
    : actual.ok === false && actual.reason === c.reason;
  check(
    ok,
    "tokenizeSegment",
    `segment=${JSON.stringify(c.segment)} expected=${c.ok ? JSON.stringify(c.argv) : c.reason} actual=${JSON.stringify(actual)}`,
  );
}

for (const c of classifyCases) {
  const tok = tokenizeSegment(c.segment);
  const argvOk = tok.ok === true && JSON.stringify(tok.argv) === JSON.stringify(c.argv);
  const actual = tok.ok ? classifySegment(tok.argv) : `TOKENIZE-FAIL:${tok.reason}`;
  const decisionOk = actual === c.expected;
  check(
    argvOk && decisionOk,
    "classifySegment",
    `segment=${JSON.stringify(c.segment)} expectedArgv=${JSON.stringify(c.argv)} actualArgv=${JSON.stringify(tok.ok ? tok.argv : null)} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(actual)}`,
  );
}

// ---------------------------------------------------------------------------
// Pure/hook tests: instantiate the default plugin server with a mocked client
// session resolver. fs.appendFile/fs.mkdir are patched to no-ops above so the
// deny/ask ledger writes never touch the real ledger. If patching failed, the
// ledger-append hook cases are omitted and reported (they would touch the real
// ledger); the output-status assertions still run.
// ---------------------------------------------------------------------------
const plugin = mod.default;
let hookPassed = 0;
let hookFailed = 0;
function hookCheck(ok, label, detail) {
  if (ok) hookPassed += 1;
  else { hookFailed += 1; console.log(`FAIL ${label} ${detail}`); }
}

async function runPermissionAsk(agent, input) {
  const client = {
    session: {
      get: async () => ({ data: { info: { agent, parentID: null, title: "t" } } }),
    },
  };
  const server = await plugin.server({ client, directory: "/repo" });
  const output = {};
  await server["permission.ask"](input, output);
  return output;
}

// Sheep allow -> output mutated to "allow" (no ledger write by design)
{
  ledgerWrites = [];
  const o = await runPermissionAsk("sheep-fast", { type: "bash", sessionID: "s1", metadata: { command: "git status" } });
  hookCheck(o.status === "allow", "hook:sheep-allow", `status=${JSON.stringify(o.status)}`);
  if (fsPatched) {
    hookCheck(ledgerWrites.length === 0, "hook:sheep-allow-ledger", `writes=${ledgerWrites.length}`);
  }
}
// Sheep deny -> output mutated to "deny" (ledger write patched away)
if (fsPatched) {
  ledgerWrites = [];
  const o = await runPermissionAsk("sheep-fast", { type: "bash", sessionID: "s1", metadata: { command: "git push" } });
  hookCheck(o.status === "deny", "hook:sheep-deny", `status=${JSON.stringify(o.status)}`);
  hookCheck(ledgerWrites.length === 1, "hook:sheep-deny-ledger", `writes=${ledgerWrites.length}`);
} else {
  console.log("SKIP hook:sheep-deny (fs patch unavailable; would touch real ledger)");
}
// Sheep unknown safe-to-ask command -> output untouched, exactly one ledger
// append (telemetry only; ledger write patched away)
if (fsPatched) {
  ledgerWrites = [];
  const o = await runPermissionAsk("sheep-fast", { type: "bash", sessionID: "s1", metadata: { command: "ls -la" } });
  hookCheck(o.status === undefined, "hook:sheep-ask-untouched", `status=${JSON.stringify(o.status)}`);
  hookCheck(ledgerWrites.length === 1, "hook:sheep-ask-ledger", `writes=${ledgerWrites.length}`);
} else {
  console.log("SKIP hook:sheep-ask (fs patch unavailable; would touch real ledger)");
}
// non-Sheep -> output untouched, no ledger append
{
  ledgerWrites = [];
  const o = await runPermissionAsk("shepherd", { type: "bash", sessionID: "s1", metadata: { command: "git push" } });
  hookCheck(o.status === undefined, "hook:non-sheep-untouched", `status=${JSON.stringify(o.status)}`);
  if (fsPatched) {
    hookCheck(ledgerWrites.length === 0, "hook:non-sheep-ledger", `writes=${ledgerWrites.length}`);
  }
}
// unresolved agent null -> output untouched, no ledger append
{
  ledgerWrites = [];
  const o = await runPermissionAsk(null, { type: "bash", sessionID: "s1", metadata: { command: "git push" } });
  hookCheck(o.status === undefined, "hook:null-agent-untouched", `status=${JSON.stringify(o.status)}`);
  if (fsPatched) {
    hookCheck(ledgerWrites.length === 0, "hook:null-agent-ledger", `writes=${ledgerWrites.length}`);
  }
}
// unresolved empty command -> output untouched, no ledger append
{
  ledgerWrites = [];
  const o = await runPermissionAsk("sheep-fast", { type: "bash", sessionID: "s1", metadata: { command: "" } });
  hookCheck(o.status === undefined, "hook:empty-command-untouched", `status=${JSON.stringify(o.status)}`);
  if (fsPatched) {
    hookCheck(ledgerWrites.length === 0, "hook:empty-command-ledger", `writes=${ledgerWrites.length}`);
  }
}
// missing command -> output untouched, no ledger append
{
  ledgerWrites = [];
  const o = await runPermissionAsk("sheep-fast", { type: "bash", sessionID: "s1", metadata: {} });
  hookCheck(o.status === undefined, "hook:missing-command-untouched", `status=${JSON.stringify(o.status)}`);
  if (fsPatched) {
    hookCheck(ledgerWrites.length === 0, "hook:missing-command-ledger", `writes=${ledgerWrites.length}`);
  }
}
// non-bash type -> output untouched
{
  ledgerWrites = [];
  const o = await runPermissionAsk("sheep-fast", { type: "edit", sessionID: "s1", metadata: { command: "git push" } });
  hookCheck(o.status === undefined, "hook:non-bash-untouched", `status=${JSON.stringify(o.status)}`);
}
// Session idle/error: a child session (parentID non-null, sheep agent, title)
// must append exactly one sheep.event ledger record and write nothing to
// console/stdout. console.log is temporarily replaced with a counter inside
// try/finally and always restored; fs is patched above so the ledger append
// never touches the real ledger.
if (fsPatched) {
  const childClient = {
    session: {
      get: async () => ({
        data: { info: { agent: "sheep-fast", parentID: "parent-1", title: "child session" } },
      }),
    },
  };
  const childServer = await plugin.server({ client: childClient, directory: "/repo" });

  const origLog = console.log;
  let consoleCalls = 0;
  let idleLedgerWrites = 0;
  let errorLedgerWrites = 0;
  try {
    console.log = () => { consoleCalls += 1; };
    ledgerWrites = [];
    await childServer.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    idleLedgerWrites = ledgerWrites.length;
    ledgerWrites = [];
    await childServer.event({ event: { type: "session.error", properties: { sessionID: "s1" } } });
    errorLedgerWrites = ledgerWrites.length;
  } finally {
    console.log = origLog;
  }
  hookCheck(consoleCalls === 0, "hook:session-idle-silent", `consoleCalls=${consoleCalls}`);
  hookCheck(idleLedgerWrites === 1, "hook:session-idle-ledger", `writes=${idleLedgerWrites}`);
  hookCheck(errorLedgerWrites === 1, "hook:session-error-ledger", `writes=${errorLedgerWrites}`);
} else {
  console.log("SKIP hook:session-idle/error (fs patch unavailable; would touch real ledger)");
}

const totalPassed = passed + hookPassed;
const totalFailed = failed + hookFailed;
console.log(`${totalPassed} passed, ${totalFailed} failed`);
if (!fsPatched) {
  console.log("NOTE: fs patch unavailable; Sheep deny/ask ledger-append hook cases omitted (would touch real ledger).");
}
process.exitCode = totalFailed === 0 ? 0 : 1;
