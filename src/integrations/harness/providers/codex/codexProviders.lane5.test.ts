import { describe, expect, it } from "vitest";
import { buildThreadStartParams, buildTurnStartParams } from "./codexProtocol";
import {
  codexNetworkAmendmentDecision,
  codexThreadIdentity,
  codexThreadIdentityKey,
  pickCodexNetworkAmendment,
} from "./codexProviders";

const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("Codex thread/start with provider and profile", () => {
  it("sends the provider, and the profile in place of the sandbox", () => {
    const params = wire(
      buildThreadStartParams({
        cwd: "/repo",
        runtimeMode: "supervised",
        modelProvider: "ollama",
        permissionsProfile: "net-npm",
        extraDirs: ["/other"],
      }),
    );
    expect(params.modelProvider).toBe("ollama");
    expect(params.permissions).toBe("net-npm");
    expect(params).not.toHaveProperty("sandbox");
    expect(params).not.toHaveProperty("sandboxPolicy");
    expect(params.approvalPolicy).toBeDefined();
  });

  it("keeps the sandbox without a profile, and in full access", () => {
    const plain = wire(
      buildThreadStartParams({ cwd: "/repo", runtimeMode: "supervised" }),
    );
    expect(plain).toHaveProperty("sandbox");
    expect(plain).not.toHaveProperty("permissions");
    expect(plain).not.toHaveProperty("modelProvider");
    const full = wire(
      buildThreadStartParams({
        cwd: "/repo",
        runtimeMode: "full-access",
        permissionsProfile: "net-npm",
      }),
    );
    expect(full.sandbox).toBe("danger-full-access");
    expect(full).not.toHaveProperty("permissions");
  });

  it("never sends ids that fail the charset check", () => {
    const params = wire(
      buildThreadStartParams({
        cwd: "/repo",
        runtimeMode: "supervised",
        modelProvider: "a b",
        permissionsProfile: "-c x",
      }),
    );
    expect(params).not.toHaveProperty("modelProvider");
    expect(params).not.toHaveProperty("permissions");
    expect(params).toHaveProperty("sandbox");
  });
});

describe("Codex turn/start with a profile", () => {
  const turn = (extra: Record<string, unknown>) =>
    wire(
      buildTurnStartParams({
        threadId: "t",
        runtimeMode: "supervised",
        prompt: "hi",
        permissionsProfile: "net-npm",
        ...extra,
      }),
    );

  it("sends the profile and no sandbox policy", () => {
    const params = turn({});
    expect(params.permissions).toBe("net-npm");
    expect(params).not.toHaveProperty("sandboxPolicy");
    expect(params).not.toHaveProperty("modelProvider");
  });

  it("keeps a plan turn read only with no profile", () => {
    const params = turn({ intent: "plan" });
    expect(params.sandboxPolicy).toEqual({ type: "readOnly" });
    expect(params).not.toHaveProperty("permissions");
  });

  it("keeps full access as MonoCode sets it", () => {
    const params = turn({ runtimeMode: "full-access" });
    expect(params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(params).not.toHaveProperty("permissions");
  });
});

describe("Codex thread identity", () => {
  it("cleans the ids and keys on both", () => {
    expect(
      codexThreadIdentity({
        modelProvider: "ollama",
        permissionsProfile: "../x",
      }),
    // Ollama is not OpenAI, so Auto's auto-review is off for it.
    ).toEqual({ modelProvider: "ollama", autoReviewOff: true });
    const a = codexThreadIdentityKey({ modelProvider: "ollama" });
    expect(codexThreadIdentityKey({ modelProvider: "ollama" })).toBe(a);
    expect(codexThreadIdentityKey({ modelProvider: "lmstudio" })).not.toBe(a);
    expect(
      codexThreadIdentityKey({
        modelProvider: "ollama",
        permissionsProfile: "p",
      }),
    ).not.toBe(a);
    // The separator keeps the two fields apart.
    expect(codexThreadIdentityKey({ modelProvider: "p" })).not.toBe(
      codexThreadIdentityKey({ permissionsProfile: "p" }),
    );
  });
});

describe("Codex network amendment", () => {
  const proposed = [
    { host: "a.example", action: "allow" as const },
    { host: "b.example", action: "deny" as const },
  ];
  it("picks only a proposed allow for the exact host", () => {
    expect(
      pickCodexNetworkAmendment(proposed, {
        host: "a.example",
        action: "allow",
      }),
    ).toEqual({ host: "a.example", action: "allow" });
    expect(
      pickCodexNetworkAmendment(proposed, {
        host: "b.example",
        action: "allow",
      }),
    ).toBeNull();
    expect(
      pickCodexNetworkAmendment(proposed, {
        host: "A.example",
        action: "allow",
      }),
    ).toBeNull();
    expect(
      pickCodexNetworkAmendment(proposed, {
        host: "b.example",
        action: "deny",
      }),
    ).toBeNull();
    expect(
      pickCodexNetworkAmendment(undefined, {
        host: "a.example",
        action: "allow",
      }),
    ).toBeNull();
    expect(pickCodexNetworkAmendment(proposed, undefined)).toBeNull();
  });

  it("has the wire shape of ApplyNetworkPolicyAmendment", () => {
    expect(
      codexNetworkAmendmentDecision({ host: "a.example", action: "allow" }),
    ).toEqual({
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: "a.example", action: "allow" },
      },
    });
  });
});
