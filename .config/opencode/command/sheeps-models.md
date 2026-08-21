---
description: View and edit the model mapping for the Shepherd sheep agents, using the live opencode model list
argument-hint: "[all=<provider/model>[@variant] | <sheep>=<provider/model>[@variant] ...]"
tools:
  read: true
  write: true
  edit: true
  bash: true
  question: true
---

<objective>
Manage the `model:` (and optionally `variant:`) frontmatter of the Shepherd herd agents. Show the live model list straight from opencode, show the current mapping, apply changes, and keep the Shepherd bundle repo in sync.
</objective>

<agents>
Files live in `<user-profile>\.config\opencode\agents\` (the installed, live copy):

- `shepherd.md`
- `sheep-cheap.md`, `sheep-fast.md`, `sheep-ui.md`, `sheep-test.md`, `sheep-review.md`, `sheep-search.md`, `sheep-docs.md`

Bundle source (mirror here if it exists): `<bundle-root>\.config\opencode\agents\`
</agents>

<procedure>

1. **Get the live model list.** Run `opencode models` with Bash and include the output (grouped by provider) in your reply so the user can pick from real IDs. If the command fails, say so and fall back to `opencode models list` or the provider catalog in `opencode.json`.

2. **Show current mapping.** Read the `model:` and `variant:` lines from each agent file above and print a table:

   | Agent | Model | Variant |

3. **Parse arguments.** Arguments: $ARGUMENTS

   - No arguments: interactive — after showing the table and model list, ask the user with the question tool which agents to change and to which model (offer a few sensible models from the list plus custom input).
   - `all=<provider/model>` — apply to all seven sheep (not `shepherd` unless explicitly given).
   - `<name>=<provider/model>` pairs, space or comma separated — e.g. `sheep-fast=opencode-go/glm-5.3 sheep-ui=opencode-go/glm-5.3`. `shepherd` is also a valid name.
   - Optional `@variant` suffix — e.g. `all=openai/gpt-5.6-luna-fast@max` also rewrites the `variant:` line. Without the suffix, leave `variant:` untouched.

4. **Validate.** Every requested model ID must appear in the `opencode models` output. If one does not, warn the user and ask before writing it.

5. **Edit.** Change only the `model:` (and `variant:` when requested) frontmatter lines in the matching files. Do not touch any other frontmatter fields or prompt bodies.

6. **Sync the bundle.** If `<bundle-root>\.config\opencode\agents\` exists, apply the identical edits there so the repo bundle stays the source of truth. Also update the Models table in `<bundle-root>\README.md` if it lists different values.

7. **Report.** Print the new mapping table and remind the user: **restart opencode** — running sessions keep the already-loaded config.
</procedure>
