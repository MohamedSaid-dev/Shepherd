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
- delegate external research to `sheep-docs`, and gate completion on `sheep-review`: every artifact-producing wave (including Shepherd's own direct edits) is independently reviewed before the task is called done, with the verdict, findings, and their resolution reported to the user - or, only on a captured provider failure of `sheep-review`, the direct verification performed instead,
- delegate test authoring and narrow validation runs to `sheep-test`,
- dispatch every currently unblocked independent assignment in parallel waves,
- run up to eight Sheep in parallel,
- continue partial Sheep assignments when their step limits are reached,
- avoid taking over delegable labor except when subagent tooling is unavailable or the user explicitly requests direct work,
- avoid broad tests, linting, formatting, builds, and dependency changes during worker execution,
- run risk-based validation only after integration.

## Permissions

Implementation Sheep (`sheep-cheap`, `sheep-fast`, `sheep-ui`) and `sheep-test` can edit, and run with a scoped bash allowlist: read-only git inspection (`status`, `diff`, `log`, `show`) and targeted test/type/lint commands (`npm/bun/pnpm test`, `vitest`, `jest`, `tsc`, `eslint`, and for `sheep-test` also `playwright test`, `typecheck`, `lint` scripts) run without approval. Every other shell command still requires approval. Search/docs/review Sheep are read-only and cannot delegate further.

## Herd telemetry

After a big run, check herd health from the opencode database:

```bash
node tools/herd-report.js --list        # recent shepherd sessions
node tools/herd-report.js --all         # one-line health summary per session
node tools/herd-report.js <sessionId>   # full report (default: latest)
```

The report shows wall vs active sheep time (stall %), worst-stalled assignments, re-dispatch churn, parent idle time, question calls, and peak/average concurrency. A stall % above ~40% means the herd waited more than it worked; check step limits and continuation latency.

## Live ledger and `/herd`

The shepherd plugin (see "Plugins and hooks") appends every Sheep edit, bash command, task dispatch, permission denial, and sheep session completion to a live JSONL ledger:

```
~/.local/share/opencode/shepherd/ledger.jsonl
```

One JSON object per line with fields `ts`, `kind` (`tool.after` | `permission.denied` | `sheep.event`), `tool`, `sessionID`, `agent`, `ok`, `summary`.

Run `/herd [N]` in any Shepherd session for a live status report built from the last N ledger lines (default 60): per-agent activity counts, the 10 most recent records, denials, sheep completions, and anomalies. Complements the post-hoc `herd-report.js` database analysis with a real-time feed.

## Plugins and hooks

`plugin/shepherd.ts` runs inside every opencode process (including Sheep subagent sessions) and does three things:

1. **Live ledger** - appends every Sheep edit, write, bash command, and task dispatch to `~/.local/share/opencode/shepherd/ledger.jsonl` (see "Live ledger and `/herd`").
2. **Fail-fast bash policy** - when a Sheep triggers a permission ask for a bash command, the plugin answers programmatically instead of parking the herd: out-of-scope commands (`git push/commit/rebase/...`, package installs like `npm install`/`pnpm add`, `rm -rf`, `docker`) are denied instantly so the Sheep reports back and Shepherd redispatches; targeted runner commands (`npx playwright test`, `npm/pnpm/bun/yarn run <script containing test|lint|type|check>`) are allowed. Everything else falls through to the normal ask flow. Policy is fail-open: if the agent cannot be resolved or no command string can be extracted, nothing is mutated.
3. **Sheep completion signals** - when a subagent session goes idle or errors, a `sheep.event` record lands in the ledger and a `[shepherd]` line goes to the opencode log.

The policy tables are plain prefix-match constants at the top of the plugin file - edit and restart opencode to tune them. All hook bodies are exception-safe: a plugin error never breaks a session. The ledger is append-only with no rotation (known limitation).
