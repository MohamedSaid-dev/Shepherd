<p align="center">
  <img src="./sheep.png" alt="Shepherd" width="160" />
</p>

<h1 align="center">OpenCode Shepherd</h1>

<p align="center"><strong>A global OpenCode agent bundle: one high-judgment orchestrator that delegates bounded work to a herd of specialized subagents.</strong></p>

## What is Shepherd?

Shepherd is an OpenCode-only bundle that installs a primary `shepherd` agent plus seven `sheep-*` subagents (eight agents total) into your **global** OpenCode config (`%USERPROFILE%\.config\opencode\`). **Shepherd supports Windows only** — Linux, macOS, and other POSIX systems are unsupported. Shepherd owns architecture, product and design direction, integration, and final review. It routes tightly bounded labor — implementation, UI, tests, search, docs, and review — to cheaper, faster subagents, then verifies every artifact through an independent review gate.

**Why?**

- Keep your own judgment and direction; offload repetitive, mechanical, and parallelizable execution.
- Parallel dispatch with a mandatory, evidence-based review gate on every produced artifact.
- A fail-fast permission plugin keeps subagents inside a strict, auditable command grammar.

> Shepherd is a `primary` agent, so it appears in the same tab-cycle as Build and Plan. The Sheep are `subagent` workers.

## Install

> **Windows only.** Shepherd installs on Windows using PowerShell. Linux, macOS, and other POSIX operating systems are not supported — do not follow these steps on an unsupported OS.

### Option A — let your AI agent do it (recommended)

Copy the prompt below and send it to your own AI assistant. It points the agent at the authoritative, plain-text instructions in [`INSTALL.txt`](./INSTALL.txt).

```text
On Windows, use PowerShell to read the authoritative install instructions at https://raw.githubusercontent.com/MohamedSaid-dev/Shepherd/refs/heads/main/INSTALL.txt. Follow those instructions to install Shepherd into my OpenCode global config. If you cannot fetch the raw file, open the INSTALL.txt file in this repository instead. Do NOT overwrite my existing opencode.json: back up any file you change and merge only the Shepherd-owned entries.
```

You can also read the instructions directly: [INSTALL.txt](./INSTALL.txt).

### Option B — manual install

1. **Back up first.** If `%USERPROFILE%\.config\opencode\opencode.json` already exists, copy it to a backup (for example `opencode.json.shepherd-backup-<timestamp>`). Also back up any existing Shepherd-owned file you will replace.
2. **Copy only the 11 Shepherd-owned files** — the `agents/`, `command/`, and `plugin/` files, **not** `opencode.json` — into your Windows global config, preserving the directory structure. Use PowerShell and the `%USERPROFILE%` environment variable (in PowerShell, `$env:USERPROFILE`):
   - `%USERPROFILE%\.config\opencode\` (PowerShell: `$env:USERPROFILE\.config\opencode\`)
   The exact file list is in [`INSTALL.txt`](./INSTALL.txt) (step 1). Do **not** copy the whole bundled `.config/opencode/` directory into an existing target, as that would overwrite `opencode.json`.
   **Before copying each file, compare it to any same-name file already at the destination.** An exact match is idempotent — copy it normally. If the content DIFFERS, back up the existing file (step 1) and STOP / ASK before replacing, UNLESS you have already explicitly authorized overwriting customized Shepherd content. Never silently overwrite a customized same-name file.
3. **Merge `opencode.json` separately** (never overwrite it). Follow the authoritative transactional and type-validation procedure in [`INSTALL.txt`](./INSTALL.txt) (step 5) — do **not** perform a direct in-place edit. That procedure backs up, records a reversible baseline, validates types (target/agent roots are objects, each of the eight source agent values is an object, `plugin` is a string or array of strings), and writes atomically. Merge only these from the bundle's `opencode.json`:
   - `default_agent` → `"shepherd"`
   - `agent` → the eight Shepherd entries (the `shepherd` agent and the seven `sheep-*` subagents); preserve any unrelated agents you already have
   - `plugin` → append `"./plugin/shepherd.ts"` (dedupe; keep any existing plugins)
4. Restart OpenCode.

See [`INSTALL.txt`](./INSTALL.txt) for the exact, safe merge procedure an agent (or you) should follow.

## Requirements

- **Windows only.** Windows with PowerShell. Linux, macOS, and other POSIX operating systems are not supported.
- [OpenCode](https://opencode.ai) installed and on your `PATH`.
- Node.js available (the plugin and the `tools/*.js` utilities run on Node).
- At least one model provider configured that exposes the model IDs in the [Model configuration](#model-configuration) table — or change the IDs to ones your provider supports.
- No package installs or dependency changes are required.

## Roles

| Agent | Mode | Role |
| --- | --- | --- |
| `shepherd` | primary | High-judgment orchestrator. Owns architecture, product/design direction, integration, and final validation. Delegates bounded labor and reviews every result. |
| `sheep-cheap` | subagent | Trivial, repetitive, mechanical, boilerplate, copy, and small isolated edits. |
| `sheep-fast` | subagent | General bounded implementation: localized bug fixes, components, hooks, endpoints, medium-complexity coding. |
| `sheep-ui` | subagent | UI implementation, responsive behavior, styling, interaction states, and accessibility — after Shepherd supplies a design brief. |
| `sheep-test` | subagent | Bounded test authoring, narrow test execution, and honest failure classification. |
| `sheep-search` | subagent | Read-only local codebase exploration, discovery, dependency tracing, pattern finding. |
| `sheep-review` | subagent | Read-only patch, contract, edge-case, security, and acceptance-criteria review. |
| `sheep-docs` | subagent | Read-only external documentation, dependency, API/version research. |

## Model configuration

All runtime settings — model, variant, temperature, and steps — live in **one place**: the `agent` block of `%USERPROFILE%\.config\opencode\opencode.json` (in PowerShell, `$env:USERPROFILE\.config\opencode\opencode.json`). The agent `.md` files carry only description, mode, color, permissions, and the prompt. **Never** re-add model fields to agent `.md` frontmatter; frontmatter silently overrides the `agent` block.

| Agent | Model | Variant | Temp | Steps |
| --- | --- | ---: | ---: | ---: |
| `shepherd` | `openai/gpt-5.6-sol` | `medium` | – | – |
| `sheep-cheap` | `ollama-cloud/deepseek-v4-flash:0731` | `max` | 0.0 | 60 |
| `sheep-fast` | `opencode-go/hy3` | `max` | 0.0 | 150 |
| `sheep-ui` | `openai/gpt-5.6-luna-fast` | `max` | 0.1 | 150 |
| `sheep-test` | `ollama-cloud/deepseek-v4-flash:0731` | `max` | 0.0 | 100 |
| `sheep-review` | `openai/gpt-5.6-luna-fast` | `max` | 0.0 | 80 |
| `sheep-search` | `openai/gpt-5.6-luna-fast` | `low` | 0.0 | 50 |
| `sheep-docs` | `openai/gpt-5.6-luna-fast` | `low` | 0.0 | 50 |

These IDs are **defaults and provider-dependent** — they must exist in your OpenCode provider catalog. Change them in the `agent` block (never in the `.md` files) if your provider does not expose them. The `/sheeps-models` command edits this block and syncs the bundle.

Step limits size bounded assignments to finish in one run; a Sheep that hits its limit returns a continuation checkpoint that Shepherd resumes.

## Usage

| Command | What it does |
| --- | --- |
| `/herd [N]` | Live herd status from the plugin ledger (last `N` lines, default 60). |
| `/sheeps-models [...]` | View or edit the herd model/variant mapping using the live `opencode models` list. |
| `node "<REPO>/tools/herd-models.js" "<config>"` | Print the agent/model/variant/temp/steps table for the live config at `<config>` (e.g. `%USERPROFILE%\.config\opencode\opencode.json`). |
| `node "<REPO>/tools/herd-models.js" "<config>" --check` | Validate the model IDs configured in `<config>` against `opencode models`. |
| `node "<REPO>/tools/herd-report.js" --list` | List recent Shepherd sessions from the OpenCode database. |
| `node "<REPO>/tools/herd-report.js" --all` | One-line health summary per session. |
| `node "<REPO>/tools/herd-report.js" "<sessionId>"` | Full report (default: latest session). |

`<REPO>` is the path to your local clone of this repository. The `tools/`
scripts are **not** installed globally — they only run from a clone (or if you
fetched them). For `herd-models`, pass your live config path as `<config>` so
the table and the `--check` validation read the config you actually use.

Restart OpenCode after any change to agent or config files.

## Safety & permissions

The `shepherd` plugin (`plugin/shepherd.ts`) runs inside every OpenCode process and enforces a **fail-fast, autonomous permission policy** for subagents. This is plugin policy — it is resolved inside the plugin, not by delegating a permission request back to the parent model. It is independent of the Windows-only installation support stated elsewhere in this document.

- **Shepherd itself** uses the OpenCode allow-everything permission shorthand (`permission: allow` in its agent frontmatter), so its own tool calls never prompt.
- **Sheep subagents** never surface a permission prompt to the user. OpenCode cannot delegate a permission request to the parent model, so the plugin resolves every Sheep `permission.ask` autonomously:
  - **Bash allowlist** (strict normalized grammar): read-only git (`status`, `diff`, `log`, `show`, `ls-files`), `rg` searches, read-only PowerShell cmdlets, exact `node --check`/`--version`/allowlisted repo scripts, package-runner `test`/`lint`/`type`/`typecheck`/`check` script families, and local-only `npx --no-install` for `playwright test`, `vitest run`, `tsc --noEmit`, `jest`, `eslint` (no `--fix`) → **allow**.
  - **Hard-denied bash** (instant deny): git mutations (`push`, `commit`, `rebase`, `reset`, `merge`, `cherry-pick`, `stash`, `tag`, `clean`, `restore`, `branch -d/-D`, `checkout --`); dependency-management subcommands (`npm install/ci/uninstall/rm/i/add/remove`, `pnpm add/install/remove/update/upgrade`, `yarn add/install/remove/upgrade`, `bun add/install/remove/update/upgrade`); `rm -rf` / `rm -fr`; Docker.
  - **Everything else for an identified Sheep** — including non-bash asks, missing/empty commands, and any unresolved bash command — is **denied** by the plugin (never sent to the user as a prompt). Each such plugin-resolved denial is recorded in the ledger as `permission.denied` with a useful summary.
- **Non-Sheep agents and unresolved sessions** are left untouched: the plugin never mutates their `permission.ask` output, so they follow the normal OpenCode ask flow. If a session's identity cannot be resolved, the plugin preserves fail-safe normal behavior rather than risk affecting other agents.

Implementation Sheep (`sheep-cheap`, `sheep-fast`, `sheep-ui`) and `sheep-test` may edit files and run the scoped allowlist above. `sheep-search`, `sheep-docs`, and `sheep-review` are **read-only** and cannot delegate further (`task`/`question` denied). The plugin is exception-safe: once a session is positively identified as a Sheep, any policy-evaluation or telemetry error fails closed to `deny` so no Sheep prompt reaches the user; only an unresolved or non-Sheep identity retains the normal OpenCode ask flow.

## Telemetry & privacy

The plugin appends a live, append-only JSONL ledger of every Sheep edit, bash command, task dispatch, permission decision, and completion to:

```
%USERPROFILE%\.local\share\opencode\shepherd\ledger.jsonl
```
(in PowerShell, `$env:USERPROFILE\.local\share\opencode\shepherd\ledger.jsonl`)

- `/herd` gives a real-time feed built from the ledger.
- `tools/herd-report.js` analyzes the OpenCode session database for herd health (stall %, concurrency, re-dispatch churn).
- The ledger is local to your machine, append-only, and has no rotation. Each record stores a truncated (≤300-character) summary — the command string, file path, task description, or serialized tool arguments — plus the agent name and a timestamp. Commands and tool arguments may contain sensitive values you entered, so treat the ledger as private: protect or review it before sharing.

## Repository layout

```text
%USERPROFILE%\.config\opencode\        (install target — mirrors this repo's .config/opencode/)
├── opencode.json          # default_agent, agent block, plugin path (merged, not overwritten)
├── agents/
│   ├── shepherd.md        # primary orchestrator
│   ├── sheep-cheap.md
│   ├── sheep-fast.md
│   ├── sheep-ui.md
│   ├── sheep-test.md
│   ├── sheep-search.md
│   ├── sheep-review.md
│   └── sheep-docs.md
├── command/
│   ├── sheeps-models.md   # /sheeps-models
│   └── herd.md            # /herd
└── plugin/
    └── shepherd.ts        # ledger + fail-fast bash policy

tools/
├── herd-models.js         # print / validate the agent model table
├── herd-report.js         # post-hoc herd health from the OpenCode DB
├── plugin-harness.mjs
└── herd-report-harness.mjs
```

## Troubleshooting

- **Ledger empty / `/herd` says plugin not active** — restart OpenCode; the plugin loads at process start.
- **`node "<REPO>/tools/herd-models.js" "<config>" --check` prints "model check skipped"** — the check shells out to `opencode models`, which needs a configured provider. When no provider is reachable it exits `0` (skipped/unavailable); this is expected and NOT a failure. No action needed.
- **`node "<REPO>/tools/herd-models.js" "<config>" --check` reports UNKNOWN model IDs (exit `1`)** — one or more configured IDs are not in your provider catalog. This needs action: edit the `agent` block (not the `.md` files) or use `/sheeps-models`, then restart OpenCode.
- **High stall % (>~40%) in `herd-report.js`** — the herd waited more than it worked; review step limits and continuation latency.
- **Changes not taking effect** — running sessions keep the already-loaded config; restart OpenCode after editing agents or `opencode.json`.

## Safe uninstall

Uninstall is **state-aware**: it restores the pre-install state from the backup and baseline report produced at install time (see [`INSTALL.txt`](./INSTALL.txt), steps 3 and 7), and removes only items Shepherd newly added. If the backup or baseline report is missing or ambiguous, STOP — do not guess.

1. **Files.** For each of the 11 Shepherd-owned files, restore it from backup if it pre-existed (the baseline records whether it existed and its prior content); otherwise delete it as newly added. Never delete unrelated files.
   - `agents/shepherd.md`
   - `agents/sheep-cheap.md`
   - `agents/sheep-fast.md`
   - `agents/sheep-ui.md`
   - `agents/sheep-test.md`
   - `agents/sheep-search.md`
   - `agents/sheep-review.md`
   - `agents/sheep-docs.md`
   - `command/sheeps-models.md`
   - `command/herd.md`
   - `plugin/shepherd.ts`
2. **`opencode.json` agent keys.** For each of the eight Shepherd agent keys — `shepherd`, `sheep-cheap`, `sheep-fast`, `sheep-ui`, `sheep-test`, `sheep-search`, `sheep-review`, `sheep-docs` — restore the prior value from the baseline if that key pre-existed; otherwise remove it as newly added. Leave unrelated agents untouched.
3. **`default_agent`.** Restore its prior presence and value from the baseline (re-add it if it was present before, or remove it if it was absent). Do not leave it as `"shepherd"` unless that was the prior value.
4. **`plugin`.** Restore the `plugin` key exactly to its prior presence, shape, and values from the baseline: if the plugin was absent before install, remove the plugin key; if it was a string, restore that exact string; if it was an array, restore that exact array. Never remove a `"./plugin/shepherd.ts"` path that predated installation — if the baseline shows the path was already present, keep it.
5. Optionally delete the ledger at `%USERPROFILE%\.local\share\opencode\shepherd\ledger.jsonl`.
6. Do **not** delete unrelated agents, commands, plugins, or other config keys.

## Known limitations

- **Model IDs are provider-dependent.** They must exist in your OpenCode provider catalog; change them in the `agent` block if needed.
- **Windows-only support.** Shepherd installs and runs on Windows with PowerShell. Linux, macOS, and other POSIX operating systems are not supported; do not attempt installation on them.
- **`herd-models.js --check` is best-effort.** It requires `opencode models` and a reachable provider; it reports "skipped" rather than failing when unavailable.
- **Ledger is append-only** with no rotation (a known limitation of the plugin).
- **Scheduling figures are heuristics, not exact metrics.** Ready-state timestamps are not persisted, so true ready-to-dispatch latency is not reported as an exact value.
- This bundle ships **no license file** and no versioned support policy.
