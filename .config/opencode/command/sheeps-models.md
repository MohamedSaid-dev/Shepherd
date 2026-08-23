---
description: View and edit the herd model mapping in the agent block of opencode.json, using the live opencode model list
argument-hint: "[all=<provider/model>[@variant] | <sheep>=<provider/model>[@variant] ...]"
tools:
  read: true
  write: true
  edit: true
  bash: true
  question: true
---

<objective>
Manage the herd's model/variant settings (the table also shows temperature and steps). All of them live ONLY in the `agent` block of opencode.json - never in agent .md frontmatter (frontmatter silently overrides JSON, and the .md files no longer carry these fields). One JSON file, two copies: live and bundle.
</objective>

<files>
- Live config: `<live-config>/opencode.json` (`agent` block), where `<live-config>` is the absolute path `path.resolve(process.env.OPENCODE_CONFIG_DIR)` when that env var is non-empty, otherwise `path.join(os.homedir(), '.config', 'opencode')`
- Bundle config (sync target): `<bundle-root>/.config/opencode/opencode.json`
- Bundle README (Models table): `<bundle-root>/README.md`
- Quick view: `node "<bundle-root>/tools/herd-models.js"` (add a config path argument to inspect another opencode.json)

Angle-bracket names (`<live-config>`, `<bundle-root>`) are resolved values to substitute into the commands below - never literal command arguments. Resolve `<bundle-root>` with `git rev-parse --show-toplevel` from the current worktree and verify it contains `.config/opencode/opencode.json`, `README.md`, and `tools/herd-models.js`. If resolution or validation fails, ask the user for the correct Shepherd checkout path - do not guess.

Agent .md files contain NO model settings - never edit them for model changes.
</files>

<procedure>

1. **Show current mapping.** Run `node "<bundle-root>/tools/herd-models.js" "<live-config>/opencode.json"` (the live config) and include its table in your reply.

2. **Get the live model list.** Run `opencode models` with Bash and include the output (grouped by provider) so the user can pick from real IDs. If it fails, fall back to `opencode models list`.

3. **Parse arguments.** Arguments: $ARGUMENTS

   - No arguments: interactive - after showing the table and model list, ask the user with the question tool which agents to change and to which model (offer a few sensible models from the list plus custom input).
   - `all=<provider/model>` - apply to all seven sheep (not `shepherd` unless explicitly given).
   - `<name>=<provider/model>` pairs, space or comma separated - e.g. `sheep-fast=opencode-go/glm-5.3 sheep-ui=opencode-go/glm-5.3`. `shepherd` is also a valid name.
   - Optional `@variant` suffix - e.g. `all=openai/gpt-5.6-luna-fast@max` also rewrites `variant`. Without the suffix, leave `variant` untouched.

4. **Validate.** Every requested model ID must appear in the `opencode models` output. If one does not, warn the user and ask before writing it.

5. **Edit.** Change ONLY the matching entries inside the `agent` block - first in the live config, then apply the identical change to the bundle config, and update the Models table in `<bundle-root>/README.md` if the values there now differ. Both copies and the README must stay synchronized. If `<bundle-root>` cannot be resolved or validated, stop and ask the user before any edit. Do not touch any other JSON keys (`mcp`, `provider`, `permission`, `plugin`, `default_agent`) and never touch agent .md files for model changes.

6. **Report.** Print the new mapping table and remind the user: **restart opencode** - running sessions keep the already-loaded config.
</procedure>
