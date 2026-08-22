---
description: Live herd status from the Shepherd plugin ledger - recent edits, commands, denials, and sheep completions.
agent: shepherd
---

Read the live Shepherd ledger at `~/.local/share/opencode/shepherd/ledger.jsonl` and report herd status. `$ARGUMENTS` may contain a line count N (default 60).

Steps:

1. Read the last N lines of the ledger file. On Windows PowerShell use `Get-Content -Tail N "$HOME/.local/share/opencode/shepherd/ledger.jsonl"`; on POSIX shells use `tail -n N`. If the file does not exist, report exactly: "Ledger empty - the shepherd plugin is not active yet (restart opencode after installing it)." and stop.
2. Aggregate records from the last 24 hours per agent: edits, bash commands, denied actions, task dispatches.
3. List the 10 most recent records as one-liners: `HH:mm kind agent summary`.
4. Call out anomalies: the same command denied repeatedly, bursts of `permission.denied`, any `sheep.event` errors, and any record with `ok: false`.
5. Keep the whole report under 30 lines. Read-only: do not write, create, or delete any file.
