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
- Live config: `<user-profile>\.config\opencode\opencode.json` (`agent` block)
- Bundle config (sync target): `<bundle-root>\.config\opencode\opencode.json`
- Bundle README (Models table): `<bundle-root>\README.md`
- Quick view: `node <bundle-root>\tools\herd-models.js` (add a config path argument to inspect another opencode.json)

Agent .md files contain NO model settings - never edit them for model changes.
</files>

<procedure>

1. **Show current mapping.** Run `node <bundle-root>\tools\herd-models.js "<user-profile>\.config\opencode\opencode.json"` (the live config) and include its table in your reply.

2. **Get the live model list.** Run `opencode models` with Bash and include the output (grouped by provider) so the user can pick from real IDs. If it fails, fall back to `opencode models list`.

3. **Parse arguments.** Arguments: $ARGUMENTS

   - No arguments: interactive - after showing the table and model list, ask the user with the question tool which agents to change and to which model (offer a few sensible models from the list plus custom input).
   - `all=<provider/model>` - apply to all seven sheep (not `shepherd` unless explicitly given).
   - `<name>=<provider/model>` pairs, space or comma separated - e.g. `sheep-fast=opencode-go/glm-5.3 sheep-ui=opencode-go/glm-5.3`. `shepherd` is also a valid name.
   - Optional `@variant` suffix - e.g. `all=openai/gpt-5.6-luna-fast@max` also rewrites `variant`. Without the suffix, leave `variant` untouched.

4. **Validate.** Every requested model ID must appear in the `opencode models` output. If one does not, warn the user and ask before writing it.

5. **Edit.** Change ONLY the matching entries inside the `agent` block - first in the live config, then apply the identical change to the bundle config if `<bundle-root>` exists, and update the Models table in `<bundle-root>\README.md` if the values there now differ. Do not touch any other JSON keys (`mcp`, `provider`, `permission`, `plugin`, `default_agent`) and never touch agent .md files for model changes.

6. **Report.** Print the new mapping table and remind the user: **restart opencode** - running sessions keep the already-loaded config.
</procedure>
