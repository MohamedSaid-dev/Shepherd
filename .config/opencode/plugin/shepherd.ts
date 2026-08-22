// Shepherd herd governance: live ledger, fail-fast bash policy, and sheep completion signals.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

type LedgerKind = "tool.after" | "permission.denied" | "permission.ask" | "sheep.event";

type LedgerRecord = {
  ts: string;
  kind: LedgerKind;
  tool: string;
  sessionID: string;
  agent: string | null;
  ok: boolean;
  summary: string;
};

type SessionInfo = {
  agent: string | null;
  parentID: string | null;
  title: string;
};

// ============================================================================
// Strict token grammar (maximum autonomy = strict grammar, NOT shell emulation)
// ----------------------------------------------------------------------------
// The classifier below does NOT emulate a shell. It accepts a deliberately tiny
// language: a chain of simple segments joined only by `;`, `|`, `&&`, `||`,
// where each segment is a whitespace-separated list of tokens. A token is either
// a bare word or a single fully-quoted word. We deliberately reject the vast
// majority of shell syntax (expansion, redirection, globs, control constructs,
// escapes, quote concatenation) so that the only commands which can ever be
// auto-allowed are ones we have enumerated exactly. Anything we do not
// understand is downgraded to `ask` rather than guessed. This is the whole point
// of the redesign: autonomy is bounded by a verifiable grammar, not by trying
// to out-smart shell obfuscation.
// ============================================================================

// Hard deny: exact normalized git mutation subcommands.
const DENY_GIT_MUTATIONS = [
  "push",
  "commit",
  "rebase",
  "reset",
  "merge",
  "cherry-pick",
  "stash",
  "tag",
  "clean",
  "restore",
] as const;

// Read-only git subcommands that are safe for Sheep autonomy.
const GIT_READONLY = ["status", "diff", "log", "show", "ls-files"] as const;

// PowerShell read-only cmdlets that are safe for Sheep autonomy (argv0 only).
const PS_READONLY = [
  "Get-Content",
  "Test-Path",
  "Get-FileHash",
  "Select-String",
  "Resolve-Path",
  "Write-Output",
  "Write-Host",
] as const;

// Exact POSIX/cross-platform read-only executables safe for Sheep autonomy
// (argv0 only, case-sensitive — POSIX names are case-sensitive). Prefix
// lookalikes, suffix lookalikes, and path-qualified binaries (e.g. /bin/cat)
// remain ask. `ls` is intentionally excluded to preserve the frozen `ls -la`
// -> ask decision. No shell syntax, globs, or write-capable commands are
// included.
const POSIX_READONLY = [
  "cat",
  "test",
  "sha256sum",
  "shasum",
  "realpath",
  "head",
  "tail",
  "pwd",
  "wc",
] as const;

// Exact repository-relative node scripts allowed to be executed directly.
// Normalized to forward slashes; no basename/keyword matching, no absolute or
// outside-repo paths, no arbitrary scripts.
const EXACT_NODE_SCRIPTS = [
  "tools/plugin-harness.mjs",
  "tools/herd-report-harness.mjs",
  "tools/herd-report.js",
  "tools/herd-models.js",
] as const;

// Package-runner script families that are auto-allowed (exact, no substring
// `contest`). `<suffix>` is any non-empty run of characters after the colon.
const RUN_FAMILIES = ["test", "lint", "typecheck", "check"] as const;
// The harmless `type` family is retained only because it was already required.
const RUN_FAMILY_TYPE = "type";

// Long-running / interactive modes that must never be auto-allowed.
const WATCH_MODE_SUBSTRINGS = ["watch", "serve", "server", "dev", "build"] as const;

const TOOL_NAMES = ["edit", "write", "patch", "bash", "task"] as const;

// Normalize a single token: strip one pair of surrounding quotes. Used only for
// path comparison, never for deciding whether a token is "safe" by its contents.
// Backslashes are NOT normalized to forward slashes: exact forward-slash repo
// paths only (see tokenizer, which rejects every backslash rather than guess).
function normalizePathToken(token: string): string {
  let t = token;
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))
  ) {
    t = t.slice(1, -1);
  }
  return t;
}

// True if a token looks like a script file path (separator or script extension).
function looksLikeScriptPath(token: string): boolean {
  const norm = normalizePathToken(token);
  if (norm === "") {
    return false;
  }
  const hasSeparator = norm.includes("/");
  const hasExt = /\.(js|mjs|cjs|ts|mts|cts)$/i.test(norm);
  return hasSeparator || hasExt;
}

// ----------------------------------------------------------------------------
// Tokenizer: turn one raw segment into normalized argv, or reject it.
// ----------------------------------------------------------------------------
export type TokenizeResult =
  | { ok: true; argv: string[] }
  | { ok: false; reason: string };

export function tokenizeSegment(segment: string): TokenizeResult {
  const argv: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  // After a closing quote, only whitespace or end-of-segment is legal. Any
  // adjacent character (including another quote) is quote-concatenation and is
  // rejected (strict grammar, no shell emulation).
  let justClosed = false;
  const n = segment.length;

  for (let i = 0; i < n; i++) {
    const ch = segment[i];

    if (quote) {
      if (ch === quote) {
        // Closing quote ends the (entire) token. An empty quoted token is
        // rejected: we never auto-allow empty arguments.
        if (buf === "") {
          return { ok: false, reason: "empty-quoted-token" };
        }
        argv.push(buf);
        buf = "";
        quote = null;
        justClosed = true;
        continue;
      }
      // Inside single quotes we keep literal regex punctuation, semicolons,
      // `$`, and backticks, but reject dangerous cmd expansion / control chars
      // `% ! ^ & | < >` which can alter command/operator structure in cmd.exe.
      // Inside double quotes we reject every expansion marker that is also
      // rejected unquoted: `$` (parameter/command), `%` (env-var), `!`
      // (history), `^` (caret), and backtick (command substitution). This stops
      // double quotes from being used to smuggle expansion past the unquoted
      // checks.
      if (quote === "'") {
        if (ch === "%" || ch === "!" || ch === "^" || ch === "&" || ch === "|" || ch === "<" || ch === ">") {
          return { ok: false, reason: "single-quote-control" };
        }
      } else {
        if (ch === "$" || ch === "%" || ch === "!" || ch === "^" || ch === "`") {
          return { ok: false, reason: "double-quote-expansion" };
        }
      }
      buf += ch;
      continue;
    }

    // After a closing quote, only whitespace or end-of-segment is legal.
    if (justClosed) {
      if (ch === " " || ch === "\t") {
        justClosed = false;
        continue;
      }
      return { ok: false, reason: "quote-concatenation" };
    }

    if (ch === '"' || ch === "'") {
      // A quote may only BEGIN a token (entire token enclosed). A quote appearing
      // mid-token (e.g. `--"ui"` or `g'it'`) is concatenation and is rejected.
      if (buf !== "") {
        return { ok: false, reason: "quote-concatenation" };
      }
      quote = ch;
      justClosed = false;
      continue;
    }

    // Unquoted CR/LF is a command separator; never guess, fail to ask.
    if (ch === "\n" || ch === "\r") {
      return { ok: false, reason: "unquoted-newline" };
    }

    // Backticks are command substitution / unsupported shell syntax.
    if (ch === "`") {
      return { ok: false, reason: "backtick" };
    }

    // Parameter / command expansion.
    if (ch === "$") {
      return { ok: false, reason: "expansion" };
    }
    // Windows env-var expansion %...%
    if (ch === "%") {
      return { ok: false, reason: "env-expansion" };
    }
    // History / caret expansion.
    if (ch === "!") {
      return { ok: false, reason: "history-expansion" };
    }
    if (ch === "^") {
      return { ok: false, reason: "caret" };
    }

    // Redirection outside quotes is not safe to guess about.
    if (ch === "<" || ch === ">") {
      return { ok: false, reason: "redirection" };
    }

    // Braces/parens are control constructs or subshells.
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      return { ok: false, reason: "control-construct" };
    }

    // Unquoted glob syntax.
    if (ch === "*" || ch === "?" || ch === "[") {
      return { ok: false, reason: "glob" };
    }

    // A lone `&` (background) is unsupported shell syntax.
    if (ch === "&") {
      return { ok: false, reason: "unsupported-ampersand" };
    }

    // PowerShell splatting / array expansion.
    if (ch === "@") {
      return { ok: false, reason: "splat" };
    }

    // Backslash: reject ALL unquoted backslashes rather than normalize/guess.
    // Forward-slash paths remain portable; exact forward-slash repo paths only.
    if (ch === "\\") {
      return { ok: false, reason: "backslash" };
    }

    if (ch === " " || ch === "\t") {
      if (buf !== "") {
        argv.push(buf);
        buf = "";
      }
      continue;
    }

    buf += ch;
  }

  if (quote) {
    return { ok: false, reason: "unmatched-quote" };
  }
  if (buf !== "") {
    argv.push(buf);
  }
  if (argv.length === 0) {
    return { ok: false, reason: "empty-segment" };
  }
  return { ok: true, argv };
}

// ----------------------------------------------------------------------------
// Chain parser: split a command into segments on `;`, `|`, `&&`, `||` (outside
// quotes) and tokenize each segment. Rejects malformed input rather than
// guessing. Returns normalized argv for every segment.
// ----------------------------------------------------------------------------
export type ChainParse =
  | { ok: true; argvSegments: string[][] }
  | { ok: false; reason: string };

export function parseChain(command: string): ChainParse {
  const argvSegments: string[][] = [];
  let seg = "";
  let quote: '"' | "'" | null = null;
  const n = command.length;
  let i = 0;

  const flush = (): ChainParse | null => {
    const t = tokenizeSegment(seg);
    if (!t.ok) {
      return { ok: false, reason: t.reason };
    }
    argvSegments.push(t.argv);
    seg = "";
    return null;
  };

  while (i < n) {
    const ch = command[i];

    if (quote) {
      seg += ch;
      if (quote === '"') {
        // Inside double quotes, reject every expansion marker rejected unquoted
        // (see tokenizeSegment): `$`, `%`, `!`, `^`, backtick. Single quotes
        // remain literal.
        if (ch === "$" || ch === "%" || ch === "!" || ch === "^" || ch === "`") {
          return { ok: false, reason: "double-quote-expansion" };
        }
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      seg += ch;
      i += 1;
      continue;
    }

    // Unquoted CR/LF is a command separator; never guess, fail to ask.
    if (ch === "\n" || ch === "\r") {
      return { ok: false, reason: "unquoted-newline" };
    }

    // Backticks are command substitution / unsupported shell syntax.
    if (ch === "`") {
      return { ok: false, reason: "backtick" };
    }

    // Parameter / command expansion.
    if (ch === "$") {
      return { ok: false, reason: "expansion" };
    }
    // Windows env-var expansion %...%
    if (ch === "%") {
      return { ok: false, reason: "env-expansion" };
    }
    // History / caret expansion.
    if (ch === "!") {
      return { ok: false, reason: "history-expansion" };
    }
    if (ch === "^") {
      return { ok: false, reason: "caret" };
    }

    // Redirection outside quotes is not safe to guess about.
    if (ch === "<" || ch === ">") {
      return { ok: false, reason: "redirection" };
    }

    // Braces/parens are control constructs or subshells.
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      return { ok: false, reason: "control-construct" };
    }

    // Unquoted glob syntax.
    if (ch === "*" || ch === "?" || ch === "[") {
      return { ok: false, reason: "glob" };
    }

    if (ch === "&") {
      if (command[i + 1] === "&") {
        const f = flush();
        if (f) {
          return f;
        }
        i += 2;
        continue;
      }
      // A lone `&` (background) is unsupported shell syntax.
      return { ok: false, reason: "unsupported-ampersand" };
    }

    if (ch === "|") {
      const f = flush();
      if (f) {
        return f;
      }
      if (command[i + 1] === "|") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === ";") {
      const f = flush();
      if (f) {
        return f;
      }
      i += 1;
      continue;
    }

    seg += ch;
    i += 1;
  }

  if (quote) {
    return { ok: false, reason: "unmatched-quote" };
  }
  const f = flush();
  if (f) {
    return f;
  }
  if (argvSegments.length === 0) {
    return { ok: false, reason: "empty-segment" };
  }
  return { ok: true, argvSegments };
}

// Git read-only subcommands become `ask` when arguments request output
// redirection or external/textconv filters (which can execute configured
// commands or write files). `-o` (short for `--output`) is included.
function gitArgsHaveDangerousFlag(args: string[]): boolean {
  return args.some((a) => {
    const base = a.split("=")[0];
    return a.startsWith("-o") || base === "--output" || base === "--ext-diff" || base === "--textconv";
  });
}

// ripgrep becomes `ask` when a preprocessor command (`--pre`) is requested,
// since that executes an arbitrary command per file.
function rgHasPre(args: string[]): boolean {
  return args.some((a) => a === "--pre" || a.startsWith("--pre="));
}

// True if any argument requests a long-running / interactive mode.
function hasWatchServerMode(argv: string[]): boolean {
  const lower = argv.join(" ").toLowerCase();
  // Existing substring gate (preserved): any token containing a watch/server/
  // dev/build/serve substring is treated as a long-running mode.
  if (WATCH_MODE_SUBSTRINGS.some((s) => lower.includes(s))) {
    return true;
  }
  // Explicit exact/prefix forms so mode checks catch `--watch=`, `--ui=`,
  // `--dev=`, etc., not just the bare `--watch` / `--ui` tokens.
  const modeFlags = ["--watch", "--ui", ...WATCH_MODE_SUBSTRINGS.map((s) => `--${s}`)];
  return argv.some((a) => {
    const la = a.toLowerCase();
    return modeFlags.some((f) => la === f || la.startsWith(`${f}=`));
  });
}

// True if a package-runner script name matches an exact allowed family.
// Never matches a name containing the substring `contest`.
function runScriptAllowed(script: string | undefined): boolean {
  if (!script) {
    return false;
  }
  if (script.toLowerCase().includes("contest")) {
    return false;
  }
  if ((RUN_FAMILIES as readonly string[]).includes(script)) {
    return true;
  }
  if (script === RUN_FAMILY_TYPE) {
    return true;
  }
  for (const fam of RUN_FAMILIES) {
    // Exact run family requires a NON-EMPTY suffix after the colon: `test:`
    // alone (empty suffix) is rejected, `test:unit` is allowed.
    if (script.startsWith(`${fam}:`) && script.length > fam.length + 1) {
      return true;
    }
  }
  return false;
}

// Classify a `node` invocation from normalized argv. Unknown/unsafe modifiers
// downgrade to `ask` (never auto-allow).
function classifyNode(argv: string[]): "allow" | "ask" {
  const args = argv.slice(1);
  if (args.length === 0) {
    return "ask"; // bare `node`
  }

  const first = args[0];

  // Arbitrary code execution: never allow.
  if (first === "-e" || first === "--eval" || first === "-p" || first === "--print") {
    return "ask";
  }

  // Version probe: exact apart from whitespace (no extra arguments).
  if ((first === "--version" || first === "-v") && args.length === 1) {
    return "allow";
  }

  // Syntax check: exactly one script path token, no other flags.
  if (first === "--check" || first === "-c") {
    if (args.length === 2 && looksLikeScriptPath(args[1])) {
      return "allow";
    }
    return "ask";
  }

  // Script run: only the exact safe flag `--experimental-strip-types` is allowed
  // as a leading flag; any other flag downgrades to ask. The script must be an
  // exact normalized repo-relative allowlist entry (no basename/keyword
  // matching, no absolute/outside paths, no arbitrary scripts).
  const scriptIdx = args.findIndex((a) => !a.startsWith("-"));
  if (scriptIdx === -1) {
    return "ask"; // no script path
  }
  const leadingFlags = args.slice(0, scriptIdx);
  if (leadingFlags.some((f) => f !== "--experimental-strip-types")) {
    return "ask";
  }
  const norm = normalizePathToken(args[scriptIdx]);
  if ((EXACT_NODE_SCRIPTS as readonly string[]).includes(norm)) {
    return "allow";
  }
  return "ask";
}

// Classify a single normalized argv segment. Deny rules win; then explicit safe
// shapes allow. Unknown or unsafe modifiers downgrade to `ask` (fail-open),
// never to a guessed allow.
export function classifySegment(argv: string[]): "allow" | "deny" | "ask" {
  if (argv.length === 0) {
    return "ask";
  }

  const a0 = argv[0];
  const a1 = argv[1];
  const a2 = argv[2];
  const a3 = argv[3];

  // ---- Hard deny: exact normalized commands (precedence across chain) ----
  // Comparison is case-insensitive: a deny must not be bypassed by casing.
  const la0 = a0.toLowerCase();
  const la1 = (a1 ?? "").toLowerCase();
  const la2 = (a2 ?? "").toLowerCase();

  if (la0 === "git") {
    if ((DENY_GIT_MUTATIONS as readonly string[]).includes(la1)) {
      return "deny";
    }
    if (la1 === "checkout" && la2 === "--") {
      return "deny";
    }
    if (la1 === "branch" && (la2 === "-D" || la2 === "-d")) {
      return "deny";
    }
  }
  if (la0 === "npm" && (la1 === "install" || la1 === "ci" || la1 === "uninstall" || la1 === "rm" || la1 === "i" || la1 === "add" || la1 === "remove")) {
    return "deny";
  }
  if (la0 === "pnpm" && (la1 === "install" || la1 === "add" || la1 === "remove" || la1 === "i" || la1 === "rm")) {
    return "deny";
  }
  if (la0 === "yarn" && (la1 === "add" || la1 === "install" || la1 === "remove")) {
    return "deny";
  }
  if (la0 === "bun" && (la1 === "add" || la1 === "install" || la1 === "remove")) {
    return "deny";
  }
  if (la0 === "rm" && (argv.some((a) => a.toLowerCase() === "-rf") || argv.some((a) => a.toLowerCase() === "-fr"))) {
    return "deny";
  }
  if (la0 === "docker" || la0 === "docker-compose") {
    return "deny";
  }

  // ---- Allow categories (exact only) ----

  // Read-only git. Dangerous modifiers (output file / external / textconv
  // filters) can execute configured commands or write files: downgrade to ask.
  if (a0 === "git" && (GIT_READONLY as readonly string[]).includes(a1)) {
    if (gitArgsHaveDangerousFlag(argv.slice(2))) {
      return "ask";
    }
    return "allow";
  }

  // ripgrep (read-only search). `--pre` runs an arbitrary command per file.
  if (a0 === "rg") {
    if (rgHasPre(argv.slice(1))) {
      return "ask";
    }
    return "allow";
  }

  // PowerShell read-only cmdlets (case-insensitive argv0).
  const lower0 = a0.toLowerCase();
  if ((PS_READONLY as readonly string[]).some((p) => p.toLowerCase() === lower0)) {
    return "allow";
  }

  // Exact POSIX/cross-platform read-only executables (case-sensitive argv0).
  // POSIX names are case-sensitive, so uppercase or mixed-case variants ask.
  // Prefix/suffix lookalikes and path-qualified binaries (e.g. /bin/cat) are
  // not in this list and therefore remain ask. `ls` is excluded to preserve
  // the frozen `ls -la` -> ask decision.
  if ((POSIX_READONLY as readonly string[]).includes(a0)) {
    return "allow";
  }

  // node: version probe, syntax check, or exact allowlist script only.
  if (a0 === "node") {
    return classifyNode(argv);
  }

  // Package runners. Both the `run` form (`npm run <script>`) and the bare form
  // (`npm <script>` -> `npm run <script>`) are accepted, for npm / pnpm / bun /
  // yarn. argv shapes:
  //   [<pm>, run, <script>, ...rest]   -> script at index 2
  //   [<pm>, <script>, ...rest]        -> script at index 1
  // Allowed only for an exact script family, with NO trailing args or with a
  // single literal `--` separator introducing the trailing args. Any other
  // trailing-arg shape (e.g. `npm run test:unit extra`) is rejected (strict
  // grammar, no shell emulation). `contest` and watch/server/dev/build/serve
  // modes downgrade to ask.
  if (a0 === "npm" || a0 === "pnpm" || a0 === "bun" || a0 === "yarn") {
    const hasRun = a1 === "run";
    const scriptIdx = hasRun ? 2 : 1;
    const script = argv[scriptIdx];
    const rest = argv.slice(scriptIdx + 1);
    // Trailing args must be absent, or begin with a literal `--` separator.
    const restOk = rest.length === 0 || rest[0] === "--";
    if (runScriptAllowed(script) && restOk && !hasWatchServerMode(argv)) {
      return "allow";
    }
  }

  // npx local-only execution. The `--no-install` flag MUST appear before the
  // package: argv: [npx, --no-install, <tool>, ...args]. Bare `npx <tool> ...`
  // and flag-after-package forms ask to prevent a download. `--offline` is no
  // longer accepted (only `--no-install`). A watch/ui/dev/build/server mode in
  // the remaining args (argv[3..]) downgrades to ask. No broad npx allowlist is
  // invented; each tool has an exact required shape.
  if (a0 === "npx") {
    // argv[1] must be the local-only flag; otherwise ask.
    if (a1 !== "--no-install") {
      return "ask";
    }
    const tool = a2;
    const rest = argv.slice(3);
    // Watch/ui/dev/build/server gate on the remaining args (argv[3..]).
    if (hasWatchServerMode(rest)) {
      return "ask";
    }
    // Exact local-only tools only, each with its required shape.
    if (tool === "playwright" && a3 === "test") {
      // argv: [npx, --no-install, playwright, test, ...args]
      return "allow";
    }
    if (tool === "vitest" && a3 === "run") {
      // argv: [npx, --no-install, vitest, run, ...args]
      return "allow";
    }
    if (tool === "tsc" && rest.includes("--noEmit")) {
      // argv: [npx, --no-install, tsc, ...args] where some arg is --noEmit
      return "allow";
    }
    if (tool === "eslint" && !rest.some((a) => a.startsWith("--fix"))) {
      // eslint allowed only when no argument begins with --fix
      return "allow";
    }
    if (tool === "jest") {
      // jest allowed unless a watch/ui/dev/build/server mode is present
      // (already excluded by the hasWatchServerMode check above).
      return "allow";
    }
    return "ask";
  }

  return "ask";
}

export function isSheepAgent(agent: string | null | undefined): boolean {
  return typeof agent === "string" && agent.length > 0 && agent.startsWith("sheep-");
}

export function bashDecision(agent: string | null | undefined, command: string): "allow" | "deny" | "ask" {
  const trimmed = command.trim();

  if (!trimmed || !isSheepAgent(agent)) {
    return "ask";
  }

  const parsed = parseChain(trimmed);
  if (!parsed.ok) {
    // Malformed quotes / control syntax / redirection / expansion: never guess,
    // ask.
    return "ask";
  }

  let allSafe = true;
  for (const argv of parsed.argvSegments) {
    const decision = classifySegment(argv);
    if (decision === "deny") {
      // Whole compound command is denied if any segment is denied.
      return "deny";
    }
    if (decision !== "allow") {
      allSafe = false;
    }
  }

  // Allow only if every parsed segment is explicitly safe.
  return allSafe ? "allow" : "ask";
}

function ledgerPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "shepherd", "ledger.jsonl");
}

function oneLine(value: string): string {
  return value.replace(/\r/g, " ").replace(/\n/g, " ");
}

function summaryText(value: string): string {
  return oneLine(value).slice(0, 300);
}

function argsJson(args: any): string {
  try {
    const value = JSON.stringify(args);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

async function appendLedger(record: Omit<LedgerRecord, "ts" | "summary"> & { summary: string }): Promise<void> {
  const filePath = ledgerPath();
  const entry: LedgerRecord = {
    ts: new Date().toISOString(),
    kind: record.kind,
    tool: record.tool,
    sessionID: record.sessionID,
    agent: record.agent,
    ok: record.ok,
    summary: summaryText(record.summary),
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

function sessionInfo(value: any): SessionInfo {
  const info = value?.info && typeof value.info === "object" ? value.info : value;
  return {
    agent: typeof info?.agent === "string" && info.agent.length > 0 ? info.agent : null,
    parentID: typeof info?.parentID === "string" ? info.parentID : null,
    title: typeof info?.title === "string" ? info.title : "",
  };
}

function sessionID(value: any): string | null {
  const info = value?.info && typeof value.info === "object" ? value.info : value;
  if (typeof info?.id === "string") {
    return info.id;
  }
  if (typeof info?.sessionID === "string") {
    return info.sessionID;
  }
  return typeof value?.sessionID === "string" ? value.sessionID : null;
}

async function resolveSession(
  client: any,
  directory: string,
  id: string,
  cache: Map<string, SessionInfo>,
): Promise<SessionInfo> {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }

  try {
    const response: any = await client.session.get({
      path: { id },
      query: { directory },
    });
    const info = sessionInfo(response?.data ?? response);
    cache.set(id, info);
    return info;
  } catch {
    const info: SessionInfo = { agent: null, parentID: null, title: "" };
    cache.set(id, info);
    return info;
  }
}

function permissionCommand(input: any): string | null {
  const candidates = [input?.metadata?.command, input?.title, input?.pattern];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
}

function toolSummary(tool: string, args: any): string {
  if (tool === "bash" && typeof args?.command === "string") {
    return args.command;
  }

  if (tool === "edit" || tool === "write" || tool === "patch") {
    const filePath = typeof args?.filePath === "string"
      ? args.filePath
      : typeof args?.file_path === "string"
        ? args.file_path
        : null;
    if (filePath !== null) {
      return `edit ${filePath}`;
    }
  }

  if (tool === "task") {
    const subagentType = args?.subagent_type;
    const description = args?.description;
    if (typeof subagentType === "string" && typeof description === "string") {
      return `task ${subagentType}: ${description}`;
    }
  }

  return argsJson(args);
}

const shepherdPlugin = {
  id: "shepherd",
  server: async ({ client, directory }) => {
    try {
      const sessions = new Map<string, SessionInfo>();

      return {
        "permission.ask": async (input, output) => {
          // Once a session is positively identified as a Sheep, every exception
          // path must fail closed to "deny" so no Sheep permission prompt leaks
          // to the user. Before identification (resolution error) or for
          // non-Sheep sessions, errors stay untouched (normal OpenCode flow).
          let identifiedSheep = false;
          try {
            const isBash = input.type === "bash";
            const command = permissionCommand(input);

            // Resolve session identity. If resolution fails or yields no agent,
            // the identity is unresolved and we preserve fail-safe normal
            // behavior (do not risk affecting other agents).
            const info = await resolveSession(client, directory, input.sessionID, sessions);
            const agent = info.agent;
            const sheep = isSheepAgent(agent);

            // Non-Sheep (or unresolved identity): never mutate output; preserve
            // the normal OpenCode ask flow. This keeps non-Sheep behavior
            // untouched and is the fail-safe when identity cannot be resolved.
            if (!sheep) {
              return;
            }
            identifiedSheep = true;

            // Identified Sheep: no permission prompt may reach the user. OpenCode
            // cannot delegate a permission request to the parent model, so the
            // plugin resolves it autonomously. Non-bash asks and missing/empty
            // commands are denied so no Sheep permission prompt reaches the user.
            if (!isBash || command === null || command.trim() === "") {
              output.status = "deny";
              await appendLedger({
                kind: "permission.denied",
                tool: input.type ?? "unknown",
                sessionID: input.sessionID,
                agent: agent,
                ok: false,
                summary: `deny ${input.type ?? "unknown"}: ${command !== null && command.trim() !== "" ? command : "(missing command)"}`,
              });
              return;
            }

            // Identified Sheep + bash + non-empty command: `command` is now
            // statically narrowed to a non-empty string. Defer to the existing
            // bashDecision classifier, which remains the safety authority.
            const decision = bashDecision(agent, command);
            if (decision === "deny") {
              output.status = "deny";
              await appendLedger({
                kind: "permission.denied",
                tool: "bash",
                sessionID: input.sessionID,
                agent: agent,
                ok: false,
                summary: `deny bash: ${command}`,
              });
            } else if (decision === "allow") {
              output.status = "allow";
              // Auto-allowed: intentionally not recorded to avoid ledger spam.
            } else {
              // Unclassified Sheep bash ask (identity resolved, command not
              // allowlisted): deny rather than prompt the user.
              output.status = "deny";
              await appendLedger({
                kind: "permission.denied",
                tool: "bash",
                sessionID: input.sessionID,
                agent: agent,
                ok: false,
                summary: `deny bash (unclassified): ${command}`,
              });
            }
          } catch {
            // Fail closed only for positively identified Sheep. Pre-identity,
            // unresolved, and non-Sheep errors remain untouched (normal flow).
            if (identifiedSheep) {
              output.status = "deny";
            }
            return;
          }
        },

        "tool.execute.after": async (input, _output) => {
          try {
            if (
              typeof input.tool !== "string" ||
              !TOOL_NAMES.includes(input.tool as (typeof TOOL_NAMES)[number])
            ) {
              return;
            }

            const info = await resolveSession(client, directory, input.sessionID, sessions);
            await appendLedger({
              kind: "tool.after",
              tool: input.tool,
              sessionID: input.sessionID,
              agent: info.agent,
              ok: true,
              summary: toolSummary(input.tool, input.args),
            });
          } catch {
            return;
          }
        },

        event: async ({ event }) => {
          try {
            if (event.type === "session.created" || event.type === "session.updated") {
              const info = event.properties?.info;
              const id = sessionID(info) ?? sessionID(event.properties);
              if (id) {
                sessions.set(id, sessionInfo(info));
              }
              return;
            }

            if (event.type !== "session.idle" && event.type !== "session.error") {
              return;
            }

            const id = typeof event.properties?.sessionID === "string"
              ? event.properties.sessionID
              : null;
            if (!id) {
              return;
            }

            const info = await resolveSession(client, directory, id, sessions);
            if (!info.parentID) {
              return;
            }

            const state = event.type === "session.error" ? "error" : "idle";
            const agent = info.agent ?? "unknown";
            const title = oneLine(info.title);
            await appendLedger({
              kind: "sheep.event",
              tool: "",
              sessionID: id,
              agent: info.agent,
              ok: state !== "error",
              summary: `${state} ${agent} ${title}`,
            });
          } catch {
            return;
          }
        },
      };
    } catch {
      return {};
    }
  },
} satisfies { id: string; server: Plugin };

export default shepherdPlugin;
