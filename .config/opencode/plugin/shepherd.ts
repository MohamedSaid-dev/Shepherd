// Shepherd herd governance: live ledger, fail-fast bash policy, and sheep completion signals.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

type LedgerKind = "tool.after" | "permission.denied" | "sheep.event";

type LedgerRecord = {
  ts: string;
  kind: LedgerKind;
  tool: string;
  sessionID: string;
  agent: string | null;
  ok: boolean;
  summary: string;
};

type SessionInfo = {
  agent: string | null;
  parentID: string | null;
  title: string;
};

const DENY_PREFIXES = [
  "git push",
  "git commit",
  "git rebase",
  "git reset",
  "git merge",
  "git cherry-pick",
  "git stash",
  "git tag",
  "git clean",
  "git checkout --",
  "git restore",
  "git branch -D",
  "git branch -d",
  "npm install",
  "npm ci",
  "npm uninstall",
  "npm rm",
  "pnpm install",
  "pnpm add",
  "pnpm remove",
  "yarn add",
  "yarn install",
  "bun add",
  "bun install",
  "rm -rf",
  "rm -fr",
  "docker ",
  "docker-compose ",
] as const;

const ALLOW_RUN_PREFIXES = [
  "npm run ",
  "pnpm run ",
  "bun run ",
  "yarn run ",
  "yarn ",
] as const;

const ALLOW_SCRIPT_PARTS = ["test", "lint", "type", "check"] as const;
const TOOL_NAMES = ["edit", "write", "patch", "bash", "task"] as const;

function prefixValue(pattern: string): string {
  return pattern.endsWith(" ") ? pattern.slice(0, -1) : pattern;
}

function prefixMatches(command: string, pattern: string): boolean {
  const prefix = prefixValue(pattern);
  return command.startsWith(prefix) &&
    (command.length === prefix.length || command[prefix.length] === " ");
}

export function isSheepAgent(agent: string | null | undefined): boolean {
  return typeof agent === "string" && agent.length > 0 && agent.startsWith("sheep-");
}

export function bashDecision(agent: string | null | undefined, command: string): "allow" | "deny" | "ask" {
  const trimmed = command.trim();

  if (!trimmed || !isSheepAgent(agent)) {
    return "ask";
  }

  for (const prefix of DENY_PREFIXES) {
    if (prefixMatches(trimmed, prefix)) {
      return "deny";
    }
  }

  if (prefixMatches(trimmed, "npm i")) {
    return "deny";
  }

  if (prefixMatches(trimmed, "npx playwright test")) {
    return "allow";
  }

  for (const prefix of ALLOW_RUN_PREFIXES) {
    const normalizedPrefix = prefixValue(prefix);
    if (!prefixMatches(trimmed, prefix)) {
      continue;
    }

    const token = trimmed.slice(normalizedPrefix.length).trimStart().split(/\s+/)[0] ?? "";
    if (ALLOW_SCRIPT_PARTS.some((part) => token.toLowerCase().includes(part))) {
      return "allow";
    }
  }

  return "ask";
}

function ledgerPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "shepherd", "ledger.jsonl");
}

function oneLine(value: string): string {
  return value.replace(/\r/g, " ").replace(/\n/g, " ");
}

function summaryText(value: string): string {
  return oneLine(value).slice(0, 300);
}

function argsJson(args: any): string {
  try {
    const value = JSON.stringify(args);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

async function appendLedger(record: Omit<LedgerRecord, "ts" | "summary"> & { summary: string }): Promise<void> {
  const filePath = ledgerPath();
  const entry: LedgerRecord = {
    ts: new Date().toISOString(),
    kind: record.kind,
    tool: record.tool,
    sessionID: record.sessionID,
    agent: record.agent,
    ok: record.ok,
    summary: summaryText(record.summary),
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

function sessionInfo(value: any): SessionInfo {
  const info = value?.info && typeof value.info === "object" ? value.info : value;
  return {
    agent: typeof info?.agent === "string" && info.agent.length > 0 ? info.agent : null,
    parentID: typeof info?.parentID === "string" ? info.parentID : null,
    title: typeof info?.title === "string" ? info.title : "",
  };
}

function sessionID(value: any): string | null {
  const info = value?.info && typeof value.info === "object" ? value.info : value;
  if (typeof info?.id === "string") {
    return info.id;
  }
  if (typeof info?.sessionID === "string") {
    return info.sessionID;
  }
  return typeof value?.sessionID === "string" ? value.sessionID : null;
}

async function resolveSession(
  client: any,
  directory: string,
  id: string,
  cache: Map<string, SessionInfo>,
): Promise<SessionInfo> {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }

  try {
    const response: any = await client.session.get({
      path: { id },
      query: { directory },
    });
    const info = sessionInfo(response?.data ?? response);
    cache.set(id, info);
    return info;
  } catch {
    const info: SessionInfo = { agent: null, parentID: null, title: "" };
    cache.set(id, info);
    return info;
  }
}

function permissionCommand(input: any): string | null {
  const candidates = [input?.metadata?.command, input?.title, input?.pattern];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
}

function toolSummary(tool: string, args: any): string {
  if (tool === "bash" && typeof args?.command === "string") {
    return args.command;
  }

  if (tool === "edit" || tool === "write" || tool === "patch") {
    const filePath = typeof args?.filePath === "string"
      ? args.filePath
      : typeof args?.file_path === "string"
        ? args.file_path
        : null;
    if (filePath !== null) {
      return `edit ${filePath}`;
    }
  }

  if (tool === "task") {
    const subagentType = args?.subagent_type;
    const description = args?.description;
    if (typeof subagentType === "string" && typeof description === "string") {
      return `task ${subagentType}: ${description}`;
    }
  }

  return argsJson(args);
}

const shepherdPlugin = {
  id: "shepherd",
  server: async ({ client, directory }) => {
    try {
      const sessions = new Map<string, SessionInfo>();

      return {
        "permission.ask": async (input, output) => {
          try {
            if (input.type !== "bash") {
              return;
            }

            const command = permissionCommand(input);
            if (command === null || command.trim() === "") {
              return;
            }

            const info = await resolveSession(client, directory, input.sessionID, sessions);
            const decision = bashDecision(info.agent, command);
            if (decision === "deny") {
              output.status = "deny";
              await appendLedger({
                kind: "permission.denied",
                tool: "bash",
                sessionID: input.sessionID,
                agent: info.agent,
                ok: false,
                summary: `deny bash: ${command}`,
              });
            } else if (decision === "allow") {
              output.status = "allow";
            }
          } catch {
            return;
          }
        },

        "tool.execute.after": async (input, _output) => {
          try {
            if (
              typeof input.tool !== "string" ||
              !TOOL_NAMES.includes(input.tool as (typeof TOOL_NAMES)[number])
            ) {
              return;
            }

            const info = await resolveSession(client, directory, input.sessionID, sessions);
            await appendLedger({
              kind: "tool.after",
              tool: input.tool,
              sessionID: input.sessionID,
              agent: info.agent,
              ok: true,
              summary: toolSummary(input.tool, input.args),
            });
          } catch {
            return;
          }
        },

        event: async ({ event }) => {
          try {
            if (event.type === "session.created" || event.type === "session.updated") {
              const info = event.properties?.info;
              const id = sessionID(info) ?? sessionID(event.properties);
              if (id) {
                sessions.set(id, sessionInfo(info));
              }
              return;
            }

            if (event.type !== "session.idle" && event.type !== "session.error") {
              return;
            }

            const id = typeof event.properties?.sessionID === "string"
              ? event.properties.sessionID
              : null;
            if (!id) {
              return;
            }

            const info = await resolveSession(client, directory, id, sessions);
            if (!info.parentID) {
              return;
            }

            const state = event.type === "session.error" ? "error" : "idle";
            const agent = info.agent ?? "unknown";
            const title = oneLine(info.title);
            await appendLedger({
              kind: "sheep.event",
              tool: "",
              sessionID: id,
              agent: info.agent,
              ok: state !== "error",
              summary: `${state} ${agent} ${title}`,
            });
            console.log(`[shepherd] ${agent} ${state}: ${title}`);
          } catch {
            return;
          }
        },
      };
    } catch {
      return {};
    }
  },
} satisfies { id: string; server: Plugin };

export default shepherdPlugin;
