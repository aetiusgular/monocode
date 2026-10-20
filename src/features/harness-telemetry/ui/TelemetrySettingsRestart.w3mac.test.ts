import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { expect, it } from "vitest";
import {
  TELEMETRY_SWITCH_DESCRIPTION,
  TelemetrySettings,
} from "./TelemetrySettings";

// Mac test 2.10: the first turn after the switch took minutes. The switch
// restarts each Claude Code and Codex chat, and the restarted harness
// reconnects every MCP server before the turn runs. Say so beside it.

it("the switch says it restarts chats and the next turn waits on MCP servers", () => {
  expect(TELEMETRY_SWITCH_DESCRIPTION).toMatch(
    /restarts.*Claude Code and Codex chats/,
  );
  expect(TELEMETRY_SWITCH_DESCRIPTION).toMatch(/first turn after.*MCP servers/);
  const html = renderToStaticMarkup(
    createElement(TelemetrySettings, {
      Group: ({ children }: { children: ReactNode }) =>
        createElement("div", null, children),
      Row: ({
        description,
        children,
      }: {
        description?: string;
        children?: ReactNode;
      }) => createElement("p", null, description, children),
      Toggle: () => null,
    }),
  );
  expect(html).toContain("MCP servers");
});
