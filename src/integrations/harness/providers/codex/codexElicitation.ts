import { asRecord, stringField } from "./codexProtocol";
import type {
  UserQuestion,
  UserQuestionReply,
} from "../../../../features/sessions/model/userQuestion";

/** Only confirmations can be represented faithfully by the Allow/Deny UI. */
export function codexMcpConfirmation(params: unknown): {
  title: string;
  content: Record<string, boolean>;
} | null {
  const rec = asRecord(params);
  const schema = asRecord(rec?.requestedSchema);
  const properties = asRecord(schema?.properties);
  if (
    !["form", "openai/form", "openaiForm"].includes(String(rec?.mode)) ||
    schema?.type !== "object" ||
    !properties ||
    Object.keys(schema).some(
      (key) =>
        ![
          "type",
          "properties",
          "required",
          "title",
          "description",
          "$schema",
          "additionalProperties",
        ].includes(key),
    )
  )
    return null;

  const entries = Object.entries(properties);
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some(
      (key) =>
        typeof key !== "string" ||
        !Object.prototype.hasOwnProperty.call(properties, key),
    ) ||
    entries.length > 1
  )
    return null;

  let detail: string | undefined;
  let content: Record<string, boolean> = {};
  if (entries.length === 1) {
    const [key, value] = entries[0];
    const field = asRecord(value);
    if (
      field?.type !== "boolean" ||
      Object.keys(field).some(
        (name) => !["type", "title", "description", "default"].includes(name),
      )
    )
      return null;
    detail = [
      stringField(field, "title") ?? key,
      stringField(field, "description"),
    ]
      .filter(Boolean)
      .join(" — ");
    content = { [key]: true };
  }

  const message = stringField(rec, "message") ?? "Approve request";
  return {
    title: `${stringField(rec, "serverName") ?? "MCP"}: ${message}${detail ? ` — ${detail}` : ""}`,
    content,
  };
}

// ---------------------------------------------------------------------------
// Sign-in requests (lane 5, part 2): MCP form and browser requests that are
// more than a confirmation. Shapes read in Codex at `rust-v0.161.0`,
// `app-server-protocol/src/protocol/v2/mcp.rs`: `McpServerElicitationRequest`
// is tagged by `mode` (`form`, `openai/form`, `openaiForm`, `url`,
// `openai/userVerification`), and the answer is
// `{ action: "accept" | "decline" | "cancel", content, _meta }`.
//
// Everything a server sends is a stranger's text. It is cleaned and capped
// here and rendered as plain text. No request is ever answered without the
// user: not in Full access, not on a timer.

const MAX_TEXT = 500;
const MAX_FIELDS = 12;
const MAX_OPTIONS = 50;
const MAX_URL = 2048;

/** Plain text from a server: control characters dropped, length capped. */
export function strangerText(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const clean = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, "")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const FORM_MODES = ["form", "openai/form", "openaiForm"];

export type ElicitationField =
  | {
      key: string;
      type: "string";
      required: boolean;
      minLength?: number;
      maxLength?: number;
      format?: string;
    }
  | {
      key: string;
      type: "number";
      integer: boolean;
      required: boolean;
      minimum?: number;
      maximum?: number;
    }
  | { key: string; type: "boolean"; required: boolean }
  | { key: string; type: "enum"; required: boolean; values: string[] }
  | {
      key: string;
      type: "multi";
      required: boolean;
      values: string[];
      minItems?: number;
      maxItems?: number;
    };

export type ElicitationForm = {
  server: string;
  message: string;
  fields: ElicitationField[];
  questions: UserQuestion[];
};

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function enumOptions(
  field: Record<string, unknown>,
): { value: string; label: string }[] | null {
  const plain = Array.isArray(field.enum) ? field.enum : null;
  const named = Array.isArray(field.enumNames) ? field.enumNames : null;
  const titled = Array.isArray(field.oneOf)
    ? field.oneOf
    : Array.isArray(field.anyOf)
      ? field.anyOf
      : null;
  let out: { value: string; label: string }[] = [];
  if (plain) {
    out = plain.flatMap((v, i) =>
      typeof v === "string"
        ? [
            {
              value: v,
              label: strangerText(named?.[i], 120) || strangerText(v, 120),
            },
          ]
        : [],
    );
    if (out.length !== plain.length) return null;
  } else if (titled) {
    out = titled.flatMap((item) => {
      const rec = asRecord(item);
      const value = rec?.const;
      return typeof value === "string"
        ? [
            {
              value,
              label: strangerText(rec?.title, 120) || strangerText(value, 120),
            },
          ]
        : [];
    });
    if (out.length !== titled.length) return null;
  } else return null;
  if (out.length === 0 || out.length > MAX_OPTIONS) return null;
  return out;
}

/**
 * A form request as fields and as question cards, or null when it is not a
 * form, is a bare confirmation (`codexMcpConfirmation` handles those), or has
 * a field MonoCode cannot show faithfully.
 */
export function codexElicitationForm(params: unknown): ElicitationForm | null {
  const rec = asRecord(params);
  if (!rec || !FORM_MODES.includes(String(rec.mode))) return null;
  if (codexMcpConfirmation(params)) return null;
  const schema = asRecord(rec.requestedSchema);
  const properties = asRecord(schema?.properties);
  if (schema?.type !== "object" || !properties) return null;
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.length > MAX_FIELDS) return null;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === "string")
      : [],
  );
  const server = strangerText(rec.serverName, 80) || "MCP server";
  const fields: ElicitationField[] = [];
  const questions: UserQuestion[] = [];
  for (const [key, raw] of entries) {
    const field = asRecord(raw);
    if (!field || key.length > 100) return null;
    const label = strangerText(field.title, 120) || strangerText(key, 100);
    const description = strangerText(field.description, 300);
    const prompt = description ? `${label}: ${description}` : label;
    const isRequired = required.has(key);
    const base = {
      id: key,
      header: label,
      prompt: `${prompt}${isRequired ? "" : " (optional)"}`,
    };
    const options =
      field.type === "array"
        ? enumOptions(asRecord(field.items) ?? {})
        : enumOptions(field);
    // A field that offers choices the parser cannot read is refused, never
    // shown as free text.
    const offersChoices = ["enum", "oneOf", "anyOf"].some((k) => k in field);
    if (field.type !== "array" && offersChoices && !options) return null;
    if (field.type === "array") {
      if (!options) return null;
      fields.push({
        key,
        type: "multi",
        required: isRequired,
        values: options.map((o) => o.value),
        minItems: finite(field.minItems),
        maxItems: finite(field.maxItems),
      });
      questions.push({
        ...base,
        multiSelect: true,
        allowCustom: false,
        options: options.map((o) => ({ id: o.value, label: o.label })),
      });
    } else if (field.type === "string" && options) {
      fields.push({
        key,
        type: "enum",
        required: isRequired,
        values: options.map((o) => o.value),
      });
      questions.push({
        ...base,
        multiSelect: false,
        allowCustom: false,
        options: options.map((o) => ({ id: o.value, label: o.label })),
      });
    } else if (field.type === "string") {
      const format =
        typeof field.format === "string" ? field.format : undefined;
      if (format && !["email", "uri", "date", "date-time"].includes(format))
        return null;
      fields.push({
        key,
        type: "string",
        required: isRequired,
        minLength: finite(field.minLength),
        maxLength: finite(field.maxLength),
        format,
      });
      questions.push({
        ...base,
        multiSelect: false,
        allowCustom: true,
        options: [],
      });
    } else if (field.type === "number" || field.type === "integer") {
      fields.push({
        key,
        type: "number",
        integer: field.type === "integer",
        required: isRequired,
        minimum: finite(field.minimum),
        maximum: finite(field.maximum),
      });
      questions.push({
        ...base,
        multiSelect: false,
        allowCustom: true,
        options: [],
      });
    } else if (field.type === "boolean") {
      fields.push({ key, type: "boolean", required: isRequired });
      questions.push({
        ...base,
        multiSelect: false,
        allowCustom: false,
        options: [
          { id: "true", label: "Yes" },
          { id: "false", label: "No" },
        ],
      });
    } else return null;
  }
  return {
    server,
    message: strangerText(rec.message) || "The server asks for some details",
    fields,
    questions,
  };
}

export type ElicitationAnswer =
  { ok: true; content: Record<string, unknown> } | { ok: false; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The form's content from the user's answers, checked against the schema. */
export function codexElicitationContent(
  form: ElicitationForm,
  reply: Extract<UserQuestionReply, { kind: "answered" }>,
): ElicitationAnswer {
  const content: Record<string, unknown> = {};
  for (const field of form.fields) {
    const picked = reply.answers[field.key] ?? [];
    const text =
      reply.custom?.[field.key]?.trim() ??
      (picked.length === 1 &&
      field.type !== "enum" &&
      field.type !== "multi" &&
      field.type !== "boolean"
        ? picked[0]
        : "");
    const missing = () =>
      field.required
        ? { ok: false as const, error: `${field.key} is required` }
        : null;
    if (field.type === "multi") {
      const values = picked.filter((v) => field.values.includes(v));
      if (values.length === 0) {
        const m = missing();
        if (m) return m;
        continue;
      }
      if (
        (field.minItems !== undefined && values.length < field.minItems) ||
        (field.maxItems !== undefined && values.length > field.maxItems)
      )
        return {
          ok: false,
          error: `${field.key} needs a different number of choices`,
        };
      content[field.key] = values;
    } else if (field.type === "enum") {
      const value = picked.find((v) => field.values.includes(v));
      if (value === undefined) {
        const m = missing();
        if (m) return m;
        continue;
      }
      content[field.key] = value;
    } else if (field.type === "boolean") {
      const value = picked.find((v) => v === "true" || v === "false");
      if (value === undefined) {
        const m = missing();
        if (m) return m;
        continue;
      }
      content[field.key] = value === "true";
    } else if (field.type === "number") {
      if (!text) {
        const m = missing();
        if (m) return m;
        continue;
      }
      const value = Number(text);
      if (
        !Number.isFinite(value) ||
        (field.integer && !Number.isInteger(value))
      )
        return {
          ok: false,
          error: `${field.key} must be ${field.integer ? "a whole number" : "a number"}`,
        };
      if (
        (field.minimum !== undefined && value < field.minimum) ||
        (field.maximum !== undefined && value > field.maximum)
      )
        return { ok: false, error: `${field.key} is out of range` };
      content[field.key] = value;
    } else {
      if (!text) {
        const m = missing();
        if (m) return m;
        continue;
      }
      if (
        (field.minLength !== undefined && text.length < field.minLength) ||
        (field.maxLength !== undefined && text.length > field.maxLength)
      )
        return { ok: false, error: `${field.key} has the wrong length` };
      if (field.format === "email" && !EMAIL.test(text))
        return { ok: false, error: `${field.key} must be an email address` };
      if (field.format === "date" && !DATE.test(text))
        return { ok: false, error: `${field.key} must be a date (YYYY-MM-DD)` };
      if (field.format === "date-time" && Number.isNaN(Date.parse(text)))
        return { ok: false, error: `${field.key} must be a date and time` };
      if (field.format === "uri") {
        try {
          new URL(text);
        } catch {
          return { ok: false, error: `${field.key} must be a URL` };
        }
      }
      content[field.key] = text;
    }
  }
  return { ok: true, content };
}

export type ElicitationSignIn = {
  server: string;
  message: string;
  url: string;
  host: string;
};

function loopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * A browser sign-in request, or null when it is not one or its address is not
 * an https page (or http on this machine), has a user name or password in it,
 * or is too long.
 */
export function codexElicitationSignIn(
  params: unknown,
): ElicitationSignIn | null {
  const rec = asRecord(params);
  if (!rec || rec.mode !== "url") return null;
  const raw = rec.url;
  if (typeof raw !== "string" || raw.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && loopbackHost(url.hostname));
  if (!secure || !url.hostname) return null;
  return {
    server: strangerText(rec.serverName, 80) || "MCP server",
    message: strangerText(rec.message) || "Sign in to continue",
    url: url.href,
    host: url.host,
  };
}
