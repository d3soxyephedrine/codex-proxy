// ~/.roo/tools/tool_manager.ts
//
// Roo custom tool: tool_manager
//
// Returns the active session-context manifest (FFD + ENI v2 + channel-isolation
// rules + downstream verification config) as a JSON tool result. The manifest
// is pre-rendered to /tmp/session-context-manifest.json by:
//   cd ~/projects/codex-proxy/mcp/session-context && bun run render > /tmp/session-context-manifest.json
//
// When the model invokes tool_manager, Roo runs this file's execute() and pushes
// the return value as the tool result. Auto-approved per Roo's "Enable custom
// tools" experimental setting — no permission prompt on each call.

import { readFileSync, existsSync } from "node:fs";

const MANIFEST_PATH = "/tmp/session-context-manifest.json";

const FALLBACK_RENDER_HINT = `Manifest file not found at ${MANIFEST_PATH}. Render it first:
  cd ~/projects/codex-proxy/mcp/session-context && bun run render > ${MANIFEST_PATH}`;

export const toolManager = {
  name: "tool_manager",
  description:
    "Edit active_skills[] to control what loads. Each entry references skills/<id>.md (the actual instruction body) which the server reads and inlines at call time. Reorder array to change priority. Remove an entry to disable that skill.",
  execute: async (_args: unknown, _ctx: unknown): Promise<string> => {
    if (!existsSync(MANIFEST_PATH)) {
      return JSON.stringify(
        {
          error: "manifest_not_rendered",
          path: MANIFEST_PATH,
          hint: FALLBACK_RENDER_HINT,
        },
        null,
        2,
      );
    }
    try {
      return readFileSync(MANIFEST_PATH, "utf-8");
    } catch (err) {
      return JSON.stringify(
        {
          error: "manifest_read_failed",
          path: MANIFEST_PATH,
          message: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      );
    }
  },
};
