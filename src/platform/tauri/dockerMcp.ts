import { invoke } from "@tauri-apps/api/core";

/**
 * What one `docker mcp` call printed, and the docker binary that ran it.
 * `stderr` is bounded. Only a gateway dry run comes back with `success`
 * false; every other failing call rejects with the error text.
 */
export type DockerMcpOutput = {
  stdout: string;
  stderr: string;
  success: boolean;
  docker: string;
};

/**
 * Runs one `docker mcp` command through the app. The app runs only a fixed
 * set of argument shapes (see `src-tauri/src/docker_mcp.rs` and the builders
 * in `features/gateway-connectors/model/dockerArgs.ts`). `stdin` is accepted
 * only by `secret set`, and carries the secret's value.
 */
export function runDockerMcp(
  args: readonly string[],
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<DockerMcpOutput> {
  return invoke<DockerMcpOutput>("docker_mcp", {
    args: [...args],
    stdin: options.stdin ?? null,
    timeoutMs: options.timeoutMs ?? null,
  });
}
