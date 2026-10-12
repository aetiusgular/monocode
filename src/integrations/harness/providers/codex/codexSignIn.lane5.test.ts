import { describe, expect, it } from "vitest";
import {
  codexElicitationContent,
  codexElicitationForm,
  codexElicitationSignIn,
  strangerText,
} from "./codexElicitation";

const form = (properties: Record<string, unknown>, required?: string[]) => ({
  threadId: "thr_1",
  turnId: "turn_1",
  serverName: "linear",
  mode: "form",
  message: "Pick a workspace",
  requestedSchema: {
    type: "object",
    properties,
    ...(required ? { required } : {}),
  },
});

const answered = (
  answers: Record<string, string[]>,
  custom?: Record<string, string>,
) => ({ kind: "answered" as const, answers, ...(custom ? { custom } : {}) });

describe("strangerText", () => {
  it("drops control and direction characters and caps the length", () => {
    expect(strangerText("a\u0000b\u001bc‮d")).toBe("abcd");
    expect(strangerText("x".repeat(600))).toHaveLength(500);
    expect(strangerText(42)).toBe("");
  });
});

describe("codexElicitationForm", () => {
  it("turns every supported field into a question", () => {
    const parsed = codexElicitationForm(
      form(
        {
          name: { type: "string", title: "Name" },
          email: { type: "string", format: "email" },
          count: { type: "integer", minimum: 1, maximum: 5 },
          ratio: { type: "number" },
          ok: { type: "boolean", title: "Agree" },
          plan: {
            type: "string",
            enum: ["free", "pro"],
            enumNames: ["Free", "Pro"],
          },
          team: { type: "string", oneOf: [{ const: "t1", title: "Team 1" }] },
          tags: {
            type: "array",
            items: {
              anyOf: [
                { const: "a", title: "A" },
                { const: "b", title: "B" },
              ],
            },
            maxItems: 1,
          },
        },
        ["name", "plan"],
      ),
    );
    expect(parsed?.server).toBe("linear");
    expect(parsed?.message).toBe("Pick a workspace");
    expect(parsed?.fields.map((f) => f.type)).toEqual([
      "string",
      "string",
      "number",
      "number",
      "boolean",
      "enum",
      "enum",
      "multi",
    ]);
    const q = Object.fromEntries(parsed!.questions.map((x) => [x.id, x]));
    expect(q.name).toMatchObject({
      prompt: "Name",
      allowCustom: true,
      options: [],
    });
    expect(q.email.prompt).toBe("email (optional)");
    expect(q.ok.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(q.plan.options).toEqual([
      { id: "free", label: "Free" },
      { id: "pro", label: "Pro" },
    ]);
    expect(q.tags.multiSelect).toBe(true);
  });

  it("leaves bare confirmations to the existing card", () => {
    expect(codexElicitationForm(form({}))).toBeNull();
    expect(
      codexElicitationForm(form({ ok: { type: "boolean", title: "Allow" } })),
    ).toBeNull();
  });

  it("refuses what it cannot show faithfully", () => {
    expect(codexElicitationForm(form({ a: { type: "object" } }))).toBeNull();
    expect(
      codexElicitationForm(form({ a: { type: "string", format: "password" } })),
    ).toBeNull();
    expect(
      codexElicitationForm(form({ a: { type: "string", enum: ["x", 3] } })),
    ).toBeNull();
    const many = Object.fromEntries(
      Array.from({ length: 13 }, (_, i) => [`f${i}`, { type: "string" }]),
    );
    expect(codexElicitationForm(form(many))).toBeNull();
    expect(
      codexElicitationForm({ ...form({ a: { type: "string" } }), mode: "url" }),
    ).toBeNull();
    expect(codexElicitationForm(null)).toBeNull();
  });

  it("cleans the server's text", () => {
    const parsed = codexElicitationForm({
      ...form({ a: { type: "string", title: "<b>Token</b>‮" } }),
      serverName: "evil\u0007",
      message: "",
    });
    expect(parsed?.server).toBe("evil");
    expect(parsed?.message).toBe("The server asks for some details");
    expect(parsed?.questions[0].header).toBe("<b>Token</b>");
  });
});

describe("codexElicitationContent", () => {
  const parsed = codexElicitationForm(
    form(
      {
        name: { type: "string", minLength: 2 },
        email: { type: "string", format: "email" },
        when: { type: "string", format: "date" },
        site: { type: "string", format: "uri" },
        count: { type: "integer", minimum: 1, maximum: 5 },
        ok: { type: "boolean" },
        plan: { type: "string", enum: ["free", "pro"] },
        tags: { type: "array", items: { enum: ["a", "b"] }, minItems: 1 },
      },
      ["name"],
    ),
  )!;

  it("types the answers, and leaves optional fields out", () => {
    expect(
      codexElicitationContent(
        parsed,
        answered(
          { ok: ["false"], plan: ["pro"], tags: ["a", "b"] },
          { name: " Ada ", count: "3", email: "a@b.co" },
        ),
      ),
    ).toEqual({
      ok: true,
      content: {
        name: "Ada",
        email: "a@b.co",
        count: 3,
        ok: false,
        plan: "pro",
        tags: ["a", "b"],
      },
    });
  });

  it("refuses a missing required field and bad values", () => {
    const check = (custom: Record<string, string>, answers = {}) =>
      codexElicitationContent(
        parsed,
        answered(answers, { name: "Ada", ...custom }),
      );
    expect(codexElicitationContent(parsed, answered({})).ok).toBe(false);
    expect(check({ name: "A" }).ok).toBe(false);
    expect(check({ count: "2.5" }).ok).toBe(false);
    expect(check({ count: "9" }).ok).toBe(false);
    expect(check({ count: "abc" }).ok).toBe(false);
    expect(check({ email: "nope" }).ok).toBe(false);
    expect(check({ when: "12/01/2026" }).ok).toBe(false);
    expect(check({ site: "not a url" }).ok).toBe(false);
  });

  it("only sends values the server offered", () => {
    const result = codexElicitationContent(
      parsed,
      answered({ plan: ["admin"], tags: ["z"] }, { name: "Ada" }),
    );
    expect(result).toEqual({ ok: true, content: { name: "Ada" } });
  });
});

describe("codexElicitationSignIn", () => {
  const url = (value: unknown, extra: object = {}) => ({
    threadId: "thr_1",
    serverName: "github",
    mode: "url",
    message: "Sign in to GitHub",
    url: value,
    elicitationId: "e1",
    ...extra,
  });

  it("takes an https page, and http on this machine", () => {
    expect(
      codexElicitationSignIn(url("https://github.com/login/oauth?x=1")),
    ).toEqual({
      server: "github",
      message: "Sign in to GitHub",
      url: "https://github.com/login/oauth?x=1",
      host: "github.com",
    });
    expect(codexElicitationSignIn(url("http://localhost:8765/cb"))?.host).toBe(
      "localhost:8765",
    );
    expect(codexElicitationSignIn(url("http://127.0.0.1:9/cb"))).not.toBeNull();
  });

  it("refuses other schemes, http elsewhere, credentials and long addresses", () => {
    for (const bad of [
      "http://example.com/login",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "https://user:pw@example.com/",
      "https://localhost:@evil.example/",
      `https://example.com/${"a".repeat(2100)}`,
      "not a url",
      42,
    ]) {
      expect(codexElicitationSignIn(url(bad))).toBeNull();
    }
    expect(
      codexElicitationSignIn({ ...url("https://a.b"), mode: "form" }),
    ).toBeNull();
  });

  it("gives a device check no card at all", () => {
    const check = {
      mode: "openai/userVerification",
      title: "Verify",
      description: "d",
      challenge: "c",
    };
    expect(codexElicitationSignIn(check)).toBeNull();
    expect(codexElicitationForm(check)).toBeNull();
  });
});
