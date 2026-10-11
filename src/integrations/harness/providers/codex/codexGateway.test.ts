import { describe, expect, it } from "vitest";
import { codexGatewayConfigArgs } from "./codexProtocol";

const docker = "/usr/local/bin/docker";

describe("codexGatewayConfigArgs", () => {
  it("adds one stdio server per connector as -c overrides", () => {
    expect(
      codexGatewayConfigArgs([
        {
          name: "hugging-face",
          command: docker,
          args: ["mcp", "gateway", "run", "--profile", "monocode_hugging_face"],
        },
      ]),
    ).toEqual([
      "-c",
      'mcp_servers.hugging-face.command="/usr/local/bin/docker"',
      "-c",
      'mcp_servers.hugging-face.args=["mcp","gateway","run","--profile","monocode_hugging_face"]',
    ]);
  });

  it("quotes values as TOML strings", () => {
    const [, command] = codexGatewayConfigArgs([
      {
        name: "x",
        command: 'C:\\Program Files\\Docker\\"docker".exe',
        args: [],
      },
    ]);
    expect(command).toBe(
      'mcp_servers.x.command="C:\\\\Program Files\\\\Docker\\\\\\"docker\\".exe"',
    );
  });

  it("skips names that cannot be a dotted key, duplicates and empty commands", () => {
    expect(
      codexGatewayConfigArgs([
        { name: "a.b", command: docker, args: [] },
        { name: "a b", command: docker, args: [] },
        { name: "ok", command: "", args: [] },
        { name: "ok", command: docker, args: [] },
        { name: "ok", command: "/other", args: [] },
      ]),
    ).toEqual([
      "-c",
      'mcp_servers.ok.command="/usr/local/bin/docker"',
      "-c",
      "mcp_servers.ok.args=[]",
    ]);
    expect(codexGatewayConfigArgs(undefined)).toEqual([]);
  });
});
