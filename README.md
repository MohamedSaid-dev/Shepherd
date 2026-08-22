# OpenCode Shepherd — Global Agent Bundle

This bundle mirrors the global OpenCode config tree under your home directory.

## Tree

```text
~/
└── .config/
    └── opencode/
        ├── opencode.json
        ├── agents/
        │   ├── shepherd.md
        │   ├── sheep-cheap.md
        │   ├── sheep-fast.md
        │   ├── sheep-test.md
        │   ├── sheep-ui.md
        │   ├── sheep-review.md
        │   ├── sheep-search.md
        │   └── sheep-docs.md
        ├── command/
        │   ├── sheeps-models.md
        │   └── herd.md
        └── plugin/
            └── shepherd.ts
```

`/sheeps-models` shows the live model list from `opencode models` and the current herd mapping, then edits the `agent` block in `opencode.json` (single file) and syncs this bundle.

`shepherd` is a `primary` agent, so it appears in the same Tab-cycle as Build and Plan.

The Sheep are `subagent` workers. Shepherd routes bounded work to them and reviews the result.

## Install

Copy the bundled `.config/opencode/` directory into your home directory.

If you already have `~/.config/opencode/opencode.json`, **do not overwrite it**. Merge these three things from this bundle's `opencode.json` into your existing one:

- `default_agent`
- `agent`
- `plugin`

```json
"default_agent": "shepherd",
"agent": { "...": "copy the whole agent block from this bundle's opencode.json" },
"plugin": ["./plugin/shepherd.ts"]
```

Do not re-add `model`, `variant`, `temperature`, or `steps` to agent `.md` frontmatter - frontmatter silently overrides the `agent` block, and the files no longer carry those fields.

Restart OpenCode after changing agent/config files.

## Models

All runtime settings - model, variant, temperature, steps - live in one place: the `agent` block of `.config/opencode/opencode.json`. The agent `.md` files carry only description, mode, color, permissions, and the prompt. The table below documents the current values (`node tools/herd-models.js` prints them live):

| Agent | Model | Variant |
| --- | --- | --- |
| `shepherd` | `openai/gpt-5.6-sol` | `medium` |
| `sheep-cheap` | `ollama-cloud/deepseek-v4-flash:0731` | `max` |
| `sheep-fast` | `opencode-go/hy3` | `max` |
| `sheep-ui` | `openai/gpt-5.6-luna-fast` | `max` |
| `sheep-test` | `ollama-cloud/deepseek-v4-flash:0731` | `max` |
| `sheep-review` | `openai/gpt-5.6-luna-fast` | `max` |
| `sheep-search` | `openai/gpt-5.6-luna-fast` | `low` |
| `sheep-docs` | `openai/gpt-5.6-luna-fast` | `low` |

Shepherd uses the neutral gray color `#808080` in the agent selector.

These model IDs must exist in your OpenCode provider catalog - `node tools/herd-models.js --check` verifies them against `opencode models`. Change them in the `agent` block of `.config/opencode/opencode.json` if your provider does not expose them; never re-add them to agent `.md` frontmatter.

## Step limits

| Agent | Steps |
| --- | ---: |
| `sheep-search` | 50 |
| `sheep-docs` | 50 |
| `sheep-cheap` | 60 |
| `sheep-review` | 80 |
| `sheep-test` | 100 |
| `sheep-fast` | 150 |
| `sheep-ui` | 150 |

Step limits are sized so bounded assignments finish in one run. When a Sheep does reach its limit, it reports a continuation checkpoint. Shepherd resumes or redispatches that same role with only the remaining work instead of completing the labor itself. Step limits and temperatures are set in the `agent` block of `opencode.json`, not in the agent files.

## Execution behavior

Shepherd is instructed to:

- keep architecture, contracts, product judgment, integration decisions, and final validation for itself,
- delegate project exploration to `sheep-search`,
- delegate bounded implementation to `sheep-cheap`, `sheep-fast`, or `sheep-ui`,
- delegate external research to `sheep-docs`, and gate completion on `sheep-review`: every artifact (including Shepherd's own direct edits) still requires actual-diff sheep-review before the task is called done, with the verdict, findings, and their resolution reported to the user - or, only on a captured provider failure of `sheep-review`, the direct verification performed instead,
- delegate test authoring and narrow validation runs to `sheep-test`,
- dispatch ready independent tasks together from a streaming task dependency DAG: reaching `done` (after its diff passes independent review) unlocks downstream work and refills slots, with no global wave barrier,
- move a task `ready → in-flight` only when its task call is actually issued and accepted; artifact tasks reach `review` and then `done` only after the required validation, integration, and independent review pass,
- once the ready set is finalized, dispatch all independent ready tasks in one tool batch before adding further narrative, subject to actual dependency, question, and capacity constraints,
- run at most eight Sheep in parallel by default, scaling to at most twelve only when more than eight genuinely independent, exclusively owned ready tasks exist and provider and review/integration capacity support it with a critical-path improvement,
- track tasks and artifacts lightly: dependencies, ownership, risk, acceptance/validation, producer, and review state,
- continue partial Sheep assignments promptly when their step limits are reached, without blocking unrelated critical-path tasks, and repartition only the separable, untouched remainder while completed or stateful work stays with its owner,
- hand out compact self-contained assignment packets that omit empty or inapplicable boilerplate but preserve contracts, scope, acceptance, validation, reporting, and escalation,
- avoid taking over delegable labor except when subagent tooling is unavailable or the user explicitly requests direct work,
- avoid broad tests, linting, formatting, builds, and dependency changes during worker execution,
- run risk-based validation only after integration.

```text
                          ---------
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
--------------------------------------------------------=
---------------------------------------------------------
---------------------------------------------------------
---------------------------------------------------------=

```

## Permissions

Implementation Sheep (`sheep-cheap`, `sheep-fast`, `sheep-ui`) and `sheep-test` can edit, and run with a scoped bash allowlist. Search/docs/review Sheep are read-only and cannot delegate further.

| Autoallow | Ask-gated | Hard-denied |
| --- | --- | --- |
| Read-only git inspection (`status`, `diff`, `log`, `show`, `ls-files`), `rg` searches, read-only PowerShell cmdlets | Arbitrary `node`/`npx`, unknown or malformed commands | Git mutations (`push`, `commit`, `rebase`, `reset`, `merge`, `cherry-pick`, `stash`, `tag`, `clean`, `checkout --`, `restore`, `branch -d/-D`) |
| Exact `node --check` with exactly one script path, exact `node --version`, and exact repo utility/harness paths (`tools/plugin-harness.mjs`, `tools/herd-report-harness.mjs`, `tools/herd-report.js`, `tools/herd-models.js`) | Expansions, escapes, backslashes, `@`, globs, quote concatenation | Package installs/removals (`npm install`, `npm i`, `npm uninstall/rm`, `pnpm install/add/remove`, `yarn add/install`, `bun add/install`) |
| Exact package script families (`test`, `lint`, `type`, `typecheck`, `check`, trailing args only after `--`), local-only npx with the flag before the tool (`npx --no-install <playwright test|vitest run|tsc --noEmit|jest|eslint> ...`, eslint without `--fix`) | Writes/removals not hard-denied, redirects/control syntax, builds/watchers/servers/network | `rm -rf` / `rm -fr`, Docker (`docker`, `docker-compose`) |

Auto-allow applies only to normalized strict grammar: exact commands and paths, no substitutions, escapes, backslashes, `@`, globs, or quote concatenation. `;`, `|`, `&&`, `||` are the only chain exception, and every normalized segment must be safe - any denied segment denies the whole chain, and substitution, subshell, redirection, or malformed quoting is never auto-allowed. If the plugin cannot resolve the agent or extract a command string, it makes no policy decision and creates no new ledger record; the normal OpenCode permission flow remains unchanged.

## Herd telemetry

After a big run, check herd health from the opencode database:

```bash
node tools/herd-report.js --list        # recent shepherd sessions
node tools/herd-report.js --all         # one-line health summary per session
node tools/herd-report.js <sessionId>   # full report (default: latest)
```

The report prints the ASCII sheep banner once per invocation, then shows wall vs active sheep time (stall %), worst-stalled assignments, re-dispatch churn, parent idle time, question calls, and peak/average concurrency. The default/full report also details scheduling heuristics derived from child session timestamps: the observed 30-second initial start burst (share of Sheep started within 30s of the first start), start after the most recent prior completion (median and max) - an observed timestamp heuristic, not true slot-refill latency - and peak headroom / average utilization versus the baseline capacity of 8. Capacity 8 is a baseline/default comparison only: the active adaptive ceiling and the ready set are not persisted, so headroom is not proof of wasted capacity. Child records with invalid or missing timestamps are ignored for scheduling and reported as a warning count. A stall % above ~40% means the herd waited more than it worked; check step limits and continuation latency. The existing telemetry remains useful for tuning adaptive concurrency and stall behavior.

These scheduling figures are heuristics, not exact metrics: ready-state timestamps are not persisted, so the ready-but-undispatched count and the true ready-to-dispatch/refill latency are unavailable and are not reported as exact values.

## Live ledger and `/herd`

The shepherd plugin (see "Plugins and hooks") appends every Sheep edit, bash command, task dispatch, permission denial, and sheep session completion to a live JSONL ledger:

```
~/.local/share/opencode/shepherd/ledger.jsonl
```

One JSON object per line with fields `ts`, `kind` (`tool.after` | `permission.denied` | `permission.ask` | `sheep.event`), `tool`, `sessionID`, `agent`, `ok`, `summary`. The `permission.ask` kind records Sheep bash commands that fell through to the normal ask flow (including unknown, malformed, redirection, and control syntax); it is additive - existing kinds remain unchanged, so older readers and reports keep working.

Run `/herd [N]` in any Shepherd session for a live status report built from the last N ledger lines (default 60): per-agent activity counts, the 10 most recent records, denials, ask bursts, sheep completions, and anomalies. Complements the post-hoc `herd-report.js` database analysis with a real-time feed.

## Plugins and hooks

`plugin/shepherd.ts` runs inside every opencode process (including Sheep subagent sessions) and does three things:

1. **Live ledger** - appends every Sheep edit, write, bash command, and task dispatch to `~/.local/share/opencode/shepherd/ledger.jsonl` (see "Live ledger and `/herd`").
2. **Fail-fast bash policy** - when a Sheep triggers a permission ask for a bash command, the plugin answers programmatically instead of parking the herd: hard-denied categories (git mutations, package installs like `npm install`/`pnpm add`, `rm -rf`, `docker`) are denied instantly so the Sheep reports back and Shepherd redispatches, with deny precedence over allow. Auto-allow uses strict normalized token grammar: commands are tokenized quote-aware, and only exact families and exact paths match - package-runner scripts (`test`, `lint`, `type`, `typecheck`, `check`, trailing args only after `--`), local-only npx with the flag before the tool (`npx --no-install <playwright test|vitest run|tsc --noEmit|jest|eslint> ...`, eslint without `--fix`), read-only git/rg/PowerShell inspection, and exact node version/check/utility paths - never substring matching and never bare `npx playwright`. Double-quoted or unquoted expansions (`$`, `%`, `!`, `^`, backticks), backslashes, `@`, and unsafe syntax (redirection, control constructs, quote concatenation, malformed quoting) downgrade to ask. Everything else - including watchers, builds/servers/network, `node -e`, arbitrary scripts, writes/removals - falls through to the normal ask flow, and each such fall-through by a Sheep is recorded as a `permission.ask` ledger record so ask bursts are visible in `/herd`. Policy is fail-open: if the agent cannot be resolved or no command string can be extracted, nothing is mutated and no ledger record is created.
3. **Sheep completion signals** - when a subagent session goes idle or errors, completion is recorded as a `sheep.event` ledger entry only, without writing to interactive stdout, so interactive input stays clean.

The allow/deny categories and the strict normalized parser live in the plugin source - edit and restart opencode to tune them. All hook bodies are exception-safe: a plugin error never breaks a session. The ledger is append-only with no rotation (known limitation).
