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
        └── command/
            └── sheeps-models.md
```

`/sheeps-models` shows the live model list from `opencode models` and the current herd mapping, then edits `model:`/`variant:` across the sheep and syncs this bundle.

`shepherd` is a `primary` agent, so it appears in the same Tab-cycle as Build and Plan.

The Sheep are `subagent` workers. Shepherd routes bounded work to them and reviews the result.

## Install

Copy the bundled `.config/opencode/` directory into your home directory.

If you already have `~/.config/opencode/opencode.json`, **do not overwrite it**. Merge this key into your existing config instead:

```json
"default_agent": "shepherd"
```

That key is optional. Remove it if you want Build (or another primary agent) to remain the startup default while still keeping Shepherd in the Tab-cycle.

Restart OpenCode after changing agent/config files.

## Models

This bundle pins each installed agent to its current provider-neutral model configuration:

| Agent | Model | Variant |
| --- | --- | --- |
| `shepherd` | `openai/gpt-5.6-sol` | `medium` |
| `sheep-cheap` | `ollama-cloud/deepseek-v4-flash:0731` | `max` |
| `sheep-fast` | `openai/gpt-5.3-codex-spark` | `max` |
| `sheep-ui` | `openai/gpt-5.6-luna-fast` | `max` |
| `sheep-test` | `ollama-cloud/deepseek-v4-flash:0731` | `max` |
| `sheep-review` | `openai/gpt-5.6-luna-fast` | `max` |
| `sheep-search` | `openai/gpt-5.6-luna-fast` | `low` |
| `sheep-docs` | `openai/gpt-5.6-luna-fast` | `max` |

Shepherd uses the neutral gray color `#808080` in the agent selector.

These model IDs must exist in your OpenCode provider catalog. Change or remove the `model:` and `variant:` fields before installation if your provider does not expose them.

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

Step limits are sized so bounded assignments finish in one run. When a Sheep does reach its limit, it reports a continuation checkpoint. Shepherd resumes or redispatches that same role with only the remaining work instead of completing the labor itself.

## Execution behavior

Shepherd is instructed to:

- keep architecture, contracts, product judgment, integration decisions, and final validation for itself,
- delegate project exploration to `sheep-search`,
- delegate bounded implementation to `sheep-cheap`, `sheep-fast`, or `sheep-ui`,
- delegate external research to `sheep-docs` and independent patch review to `sheep-review`,
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
