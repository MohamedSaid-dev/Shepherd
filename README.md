<p align="center">
  <img src="./sheep.png" alt="Shepherd" width="160" />
</p>

<h1 align="center">OpenCode Shepherd</h1>

<p align="center"><strong>One high-judgment OpenCode orchestrator backed by a focused herd of specialist agents.</strong></p>

Shepherd is an OpenCode plugin and agent bundle. It adds a primary `shepherd` agent and seven `sheep-*` subagents to your global OpenCode configuration.

Shepherd keeps ownership of architecture, product direction, integration, and final review while delegating bounded implementation, UI, test, research, and review work.

- Parallel execution for work that can be safely split.
- Independent, evidence-based review of delegated results.
- Strict, fail-closed permissions that keep Sheep inside their assigned roles.

> Shepherd appears alongside OpenCode's Build and Plan agents. The Sheep remain internal subagents.

## Install

You need [OpenCode](https://opencode.ai), Node.js, and at least one configured model provider.

### Ask your AI agent (recommended)

Copy and send this prompt to your AI coding agent:

```text
Install OpenCode Shepherd from https://github.com/MohamedSaid-dev/Shepherd.

First read and follow the authoritative instructions at:
https://raw.githubusercontent.com/MohamedSaid-dev/Shepherd/refs/heads/main/INSTALL.txt

Use the repository's dependency-free installer. Run `node tools/install.js --dry-run` first, review the result, and then run `node tools/install.js` only if there are no conflicts. Never overwrite my existing opencode.json; preserve unrelated configuration and rely on the installer's merge, backups, and reversible baseline. Do not use `--force` without asking me first. Report what changed and remind me to restart OpenCode.
```

The complete safety and conflict-handling procedure lives in [`INSTALL.txt`](./INSTALL.txt).

### Run it yourself

Clone or download this repository, open a terminal in it, and run:

```sh
node tools/install.js --dry-run
node tools/install.js
```

The installer targets `~/.config/opencode` by default. To use another global config directory, set `OPENCODE_CONFIG_DIR` or pass `--config-dir <path>`.

It copies only Shepherd's 11 owned files, merges the required entries into `opencode.json`, backs up changed files, and writes a `shepherd-baseline-*.json` file for safe reversal. A no-op reinstall writes nothing.

Restart OpenCode when installation finishes.

## The herd

| Agent | Focus |
| --- | --- |
| `shepherd` | Plans, delegates, integrates, and performs final validation. |
| `sheep-cheap` | Small mechanical edits, boilerplate, and repetitive work. |
| `sheep-fast` | Focused implementation and localized bug fixes. |
| `sheep-ui` | UI, responsive behavior, interaction states, and accessibility. |
| `sheep-test` | Test authoring, narrow test runs, and failure classification. |
| `sheep-search` | Read-only codebase exploration and dependency tracing. |
| `sheep-review` | Read-only review for defects, edge cases, security, and scope. |
| `sheep-docs` | Read-only external documentation and API research. |

Shepherd decides which agent fits each bounded task and reviews every returned artifact before accepting it.

## Everyday use

Use Shepherd as your primary OpenCode agent and describe the outcome you want. Delegation happens automatically when it is useful.

| Command | Purpose |
| --- | --- |
| `/herd [N]` | Show recent herd activity from the local ledger. |
| `/sheeps-models` | View or change the model and variant assigned to each agent. |
| `node tools/herd-report.js --list` | List recent Shepherd sessions. |
| `node tools/herd-report.js --all` | Show a one-line health summary for each session. |
| `node tools/herd-report.js <sessionId>` | Generate a detailed session report. |

The `tools/` commands run from a local clone; they are not installed globally.

## Models

The included model IDs are defaults and depend on what your OpenCode providers expose.

| Agent | Default model | Variant |
| --- | --- | --- |
| `shepherd` | `openai/gpt-5.6-sol` | `medium` |
| `sheep-cheap` | `ollama-cloud/deepseek-v4-flash:0731` | `max` |
| `sheep-fast` | `opencode-go/hy3` | `max` |
| `sheep-ui` | `openai/gpt-5.6-luna-fast` | `max` |
| `sheep-test` | `ollama-cloud/deepseek-v4-flash:0731` | `max` |
| `sheep-search` | `openai/gpt-5.6-luna-fast` | `low` |
| `sheep-review` | `openai/gpt-5.6-luna-fast` | `max` |
| `sheep-docs` | `openai/gpt-5.6-luna-fast` | `low` |

Use `/sheeps-models` to switch unsupported IDs. Runtime model settings live in the `agent` block of your global `opencode.json`; the agent Markdown files intentionally do not define models.

From a clone, you can inspect and validate the live configuration:

```sh
node tools/herd-models.js "<config-root>/opencode.json"
node tools/herd-models.js "<config-root>/opencode.json" --check
```

The check is best-effort: it reports `skipped` when `opencode models` cannot reach a provider, and reports unknown model IDs when the provider catalog does not contain them.

## Safety and privacy

Sheep do not receive blanket shell access. The Shepherd plugin auto-allows only a narrow grammar of explicitly recognized read-only inspection and validation commands. Unknown commands, shell expansion, redirection, destructive Git operations, dependency installation, recursive deletion, Docker, and out-of-role tool requests are denied rather than sent to the user as approval prompts. Search, docs, and review Sheep remain read-only.

Activity is recorded locally at:

```text
~/.local/share/opencode/shepherd/ledger.jsonl
```

The ledger is append-only and has no automatic rotation. It stores timestamps, agent names, and truncated summaries of commands or tool arguments, which may still contain sensitive values. Treat it as private and review it before sharing.

## Troubleshooting

- **Shepherd is missing after installation:** restart OpenCode; agents and plugins load at process start.
- **`/herd` says the plugin is inactive:** restart OpenCode, then confirm `./plugin/shepherd.ts` is present in the global config's `plugin` setting.
- **A model is unknown:** run `/sheeps-models` and choose an ID exposed by your provider.
- **Installation reports a conflict:** do not use `--force` unless you intend to replace customized Shepherd-owned content. Follow the conflict procedure in [`INSTALL.txt`](./INSTALL.txt).
- **Changes are not taking effect:** restart the current OpenCode session after editing agents or `opencode.json`.

## Uninstall

Uninstall is state-aware rather than destructive. Use the `shepherd-baseline-*.json` created during installation to restore prior values and remove only files Shepherd added. If the baseline is missing, or a Shepherd-owned file changed after installation, stop instead of guessing.

Copy and send this prompt to your AI coding agent:

```text
Safely uninstall OpenCode Shepherd from my global OpenCode configuration.

First read and follow the uninstall procedure in the authoritative instructions at:
https://raw.githubusercontent.com/MohamedSaid-dev/Shepherd/refs/heads/main/INSTALL.txt

Use the applicable `shepherd-baseline-*.json` created during installation. Before changing anything, check for post-install edits. Restore prior values and remove only files or configuration entries that Shepherd added. Never delete unrelated agents, commands, plugins, or config keys, and never overwrite or delete a file that has changed since installation. If the baseline is missing, ambiguous, or conflicts with the current configuration, stop and ask me instead of guessing. Report every restored or removed item and remind me to restart OpenCode.
```

Follow the authoritative uninstall procedure in [`INSTALL.txt`](./INSTALL.txt) and never delete unrelated agents, commands, plugins, or config keys.
