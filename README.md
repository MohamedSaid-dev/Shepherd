# OpenCode Shepherd — Global Agent Bundle

This bundle mirrors the global OpenCode config tree under your home directory.

## Tree

```text
~/
└── .config/
    └── opencode/
        ├── opencode.json
        └── agents/
            ├── shepherd.md
            ├── sheep-cheap.md
            ├── sheep-fast.md
            ├── sheep-ui.md
            ├── sheep-review.md
            ├── sheep-search.md
            └── sheep-docs.md
```

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

This bundle pins the installed agents to the current OpenAI model configuration:

| Agent | Model | Variant |
| --- | --- | --- |
| `shepherd` | `openai/gpt-5.6-sol` | `medium` |
| All Sheep | `openai/gpt-5.6-luna-fast` | `max` |

Shepherd uses the neutral gray color `#808080` in the agent selector.

These model IDs must exist in your OpenCode provider catalog. Change or remove the `model:` and `variant:` fields before installation if your provider does not expose them.

## Step limits

| Agent | Steps |
| --- | ---: |
| `sheep-cheap` | 18 |
| `sheep-search` | 18 |
| `sheep-docs` | 18 |
| `sheep-review` | 24 |
| `sheep-fast` | 30 |
| `sheep-ui` | 30 |

When a Sheep reaches its step limit, it reports a continuation checkpoint. Shepherd resumes or redispatches that same role with only the remaining work instead of completing the labor itself.

## Execution behavior

Shepherd is instructed to:

- keep architecture, contracts, product judgment, integration decisions, and final validation for itself,
- delegate project exploration to `sheep-search`,
- delegate bounded implementation to `sheep-cheap`, `sheep-fast`, or `sheep-ui`,
- delegate external research to `sheep-docs` and independent patch review to `sheep-review`,
- dispatch every currently unblocked independent assignment in parallel waves,
- run up to eight Sheep in parallel,
- continue partial Sheep assignments when their step limits are reached,
- avoid taking over delegable labor except when subagent tooling is unavailable or the user explicitly requests direct work,
- avoid broad tests, linting, formatting, builds, and dependency changes during worker execution,
- run risk-based validation only after integration.

## Permissions

Implementation Sheep can edit, but shell commands require approval. Search/docs/review Sheep are read-only and cannot delegate further.
