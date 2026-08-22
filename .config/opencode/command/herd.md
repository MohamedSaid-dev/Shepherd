---
description: Live herd status from the Shepherd plugin ledger - recent edits, commands, denials, ask bursts, and sheep completions.
agent: shepherd
---

Read the live Shepherd ledger at `~/.local/share/opencode/shepherd/ledger.jsonl` and report herd status. `$ARGUMENTS` may contain a line count N (default 60). Parse N as a decimal positive integer: if `$ARGUMENTS` is empty, is not a decimal positive integer, or contains anything else, use the default 60; clamp N to a maximum of 500 before constructing any command. Never interpolate raw `$ARGUMENTS` into a command.

Steps:

1. Read the last N lines of the ledger file. On Windows PowerShell use `Get-Content -Tail N "$HOME/.local/share/opencode/shepherd/ledger.jsonl"`; on POSIX shells use `tail -n N`. If the file does not exist, report exactly: "Ledger empty - the shepherd plugin is not active yet (restart opencode after installing it)." and stop.
2. Aggregate records from the last 24 hours per agent: edits, bash commands, denied actions, ask bursts, task dispatches. Count `permission.ask` records separately from `permission.denied` records - do not merge them into one denial figure. Cap the per-agent rows to the most active agents so the report stays within the 30-line budget.
3. List the 10 most recent records as one-liners: `HH:mm kind agent summary`.
4. Call out anomalies in at most 3 lines total: repeated denials, `permission.ask` bursts (repeated ask commands are babysitting hotspots - the Sheep is stalling on approval), `sheep.event` errors, and `ok: false` records. Show only the top items per category and summarize the rest as `+N more`; cap the listed items so the whole report stays within 30 lines.
5. Keep the whole report under 30 lines. Read-only: do not write, create, or delete any file.
