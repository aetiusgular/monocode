//! The two rewrites the adapter makes on a Responses API exchange.
//!
//! Request: when Codex offers `exec_command`, add `edit_file` and
//! `write_file` and one line of instructions, and show the model its own
//! file calls in the history instead of the `exec_command` they became.
//!
//! Response (streamed Server-Sent Events): hold an `edit_file` or
//! `write_file` call until its arguments are complete, then send Codex an
//! `exec_command` call with the same call id, carrying the patch. Every other
//! event passes through as it arrives.

use std::collections::{HashMap, VecDeque};

use serde_json::{json, Value};

use super::patch::{parse_adapter_command, EditCall};

pub const FILE_TOOLS: [&str; 2] = ["edit_file", "write_file"];
const INSTRUCTION: &str = "To change a file, call edit_file with text copied exactly from the file. To create or replace a whole file, call write_file. Do not write apply_patch commands yourself.";
const MAX_REMEMBERED_CALLS: usize = 2_000;
/// First line of the `apply_patch` how-to in the instructions file the
/// Models page writes (`DEFAULT_INSTRUCTIONS` in `modelSetup.ts`). With the
/// adapter on, that block is swapped for `INSTRUCTION`, so the model is not
/// told both ways. The block ends at its heredoc's `EOF` line.
const APPLY_PATCH_HOWTO: &str = "Edit files by running apply_patch through exec_command:";

/// The calls this adapter rewrote in one session, by call id, so the history
/// can show the model what it sent.
#[derive(Default)]
pub struct CallMap {
    calls: HashMap<String, EditCall>,
    order: VecDeque<String>,
}

impl CallMap {
    pub fn insert(&mut self, call_id: String, call: EditCall) {
        if self.calls.insert(call_id.clone(), call).is_none() {
            self.order.push_back(call_id);
        }
        while self.order.len() > MAX_REMEMBERED_CALLS {
            if let Some(old) = self.order.pop_front() {
                self.calls.remove(&old);
            }
        }
    }

    pub fn get(&self, call_id: &str) -> Option<&EditCall> {
        self.calls.get(call_id)
    }
}

fn tool_definitions() -> [Value; 2] {
    [
        json!({
            "type": "function",
            "name": "edit_file",
            "description": "Replace one piece of text in a file. old_text must appear exactly once in the file, spaces and indentation included.",
            "strict": false,
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path relative to the project folder" },
                    "old_text": { "type": "string", "description": "Exact text to replace" },
                    "new_text": { "type": "string", "description": "Text to put in its place" }
                },
                "required": ["path", "old_text", "new_text"],
                "additionalProperties": false
            }
        }),
        json!({
            "type": "function",
            "name": "write_file",
            "description": "Create a file, or replace a whole file, with this content.",
            "strict": false,
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path relative to the project folder" },
                    "content": { "type": "string", "description": "The whole file" }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }
        }),
    ]
}

fn tool_name(tool: &Value) -> Option<&str> {
    tool.get("name").and_then(Value::as_str)
}

/// Rewrites a `/responses` request body. Returns `None` when the body is left
/// as it was: not JSON, or no `exec_command` offered (Codex's side requests,
/// such as titles and compaction, carry no tools).
pub fn rewrite_request(body: &[u8], calls: &CallMap) -> Option<Vec<u8>> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    let object = value.as_object_mut()?;
    let tools = object.get_mut("tools")?.as_array_mut()?;
    if !tools.iter().any(|t| tool_name(t) == Some("exec_command")) {
        return None;
    }
    for definition in tool_definitions() {
        let name = tool_name(&definition).map(str::to_owned);
        if !tools
            .iter()
            .any(|t| tool_name(t).map(str::to_owned) == name)
        {
            tools.push(definition);
        }
    }
    match object.get_mut("instructions") {
        Some(Value::String(text)) => {
            if !text.contains(INSTRUCTION) {
                *text = with_instruction(text);
            }
        }
        _ => {
            object.insert("instructions".into(), Value::String(INSTRUCTION.into()));
        }
    }
    if let Some(Value::Array(items)) = object.get_mut("input") {
        for item in items.iter_mut() {
            restore_history_call(item, calls);
        }
    }
    serde_json::to_vec(&value).ok()
}

/// The instructions with the adapter's line: in place of MonoCode's own
/// `apply_patch` how-to when it is there, else at the end.
fn with_instruction(text: &str) -> String {
    if let Some(start) = text.find(APPLY_PATCH_HOWTO) {
        let after = &text[start..];
        let end = after
            .split_inclusive('\n')
            .scan(0, |at, line| {
                *at += line.len();
                Some((*at, line))
            })
            .skip(1)
            .find(|(_, line)| line.trim_end() == "EOF")
            .map(|(at, _)| start + at);
        if let Some(end) = end {
            return format!("{}{}\n{}", &text[..start], INSTRUCTION, &text[end..]);
        }
    }
    format!("{text}\n\n{INSTRUCTION}")
}

/// An `exec_command` call in the history that this adapter made is shown
/// again as the model's own file call.
fn restore_history_call(item: &mut Value, calls: &CallMap) {
    if item.get("type").and_then(Value::as_str) != Some("function_call")
        || item.get("name").and_then(Value::as_str) != Some("exec_command")
    {
        return;
    }
    let call_id = item.get("call_id").and_then(Value::as_str).unwrap_or("");
    let original = calls.get(call_id).cloned().or_else(|| {
        let arguments = item.get("arguments").and_then(Value::as_str)?;
        let parsed: Value = serde_json::from_str(arguments).ok()?;
        parse_adapter_command(parsed.get("cmd")?.as_str()?)
    });
    if let (Some(call), Some(object)) = (original, item.as_object_mut()) {
        object.insert("name".into(), Value::String(call.name().into()));
        object.insert("arguments".into(), Value::String(call.arguments_json()));
    }
}

/// A file call in the model's output, turned into the `exec_command` call
/// Codex runs. `command` builds the `cmd` from the parsed call, or from the
/// error text when the arguments did not parse.
fn rewrite_item(
    item: &Value,
    command: &mut dyn FnMut(Result<&EditCall, &str>) -> String,
    calls: &mut Vec<(String, EditCall)>,
) -> Value {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = item.get("arguments").and_then(Value::as_str).unwrap_or("");
    let cmd = match EditCall::parse(name, arguments) {
        Ok(call) => {
            let cmd = command(Ok(&call));
            if let Some(call_id) = item.get("call_id").and_then(Value::as_str) {
                calls.push((call_id.to_string(), call));
            }
            cmd
        }
        Err(message) => command(Err(&message)),
    };
    let mut out = item.clone();
    if let Some(object) = out.as_object_mut() {
        object.insert("name".into(), Value::String("exec_command".into()));
        object.insert(
            "arguments".into(),
            Value::String(json!({ "cmd": cmd }).to_string()),
        );
    }
    out
}

fn is_file_call(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("function_call")
        && item
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|n| FILE_TOOLS.contains(&n))
}

/// Builds the `exec_command` `cmd` for a parsed call, or for a parse error.
type CommandFn<'a> = Box<dyn FnMut(Result<&EditCall, &str>) -> String + 'a>;

/// A file call being held while its arguments stream in.
struct Held {
    item: Value,
    arguments: String,
    sent: bool,
}

/// Rewrites a Server-Sent Events stream from the model server, event by
/// event. Feed it bytes as they arrive; it returns the bytes to send on.
pub struct StreamRewriter<'a> {
    buffer: Vec<u8>,
    held: HashMap<i64, Held>,
    /// Rewritten items by call id, for `response.completed`.
    rewritten: HashMap<String, Value>,
    command: CommandFn<'a>,
    /// File calls rewritten since the last `take_calls`, by call id.
    calls: Vec<(String, EditCall)>,
}

impl<'a> StreamRewriter<'a> {
    pub fn new(command: impl FnMut(Result<&EditCall, &str>) -> String + 'a) -> Self {
        StreamRewriter {
            buffer: Vec::new(),
            held: HashMap::new(),
            rewritten: HashMap::new(),
            command: Box::new(command),
            calls: Vec::new(),
        }
    }

    /// The file calls rewritten so far, for the session's call map. The
    /// caller merges them under its own short lock.
    pub fn take_calls(&mut self) -> Vec<(String, EditCall)> {
        std::mem::take(&mut self.calls)
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some((end, skip)) = event_end(&self.buffer) {
            let block: Vec<u8> = self.buffer.drain(..end + skip).collect();
            self.event(&block[..end], &block[end..], &mut out);
        }
        out
    }

    /// Anything left when the stream ends, as it came.
    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buffer)
    }

    fn event(&mut self, raw: &[u8], separator: &[u8], out: &mut Vec<u8>) {
        let pass = |out: &mut Vec<u8>| {
            out.extend_from_slice(raw);
            out.extend_from_slice(separator);
        };
        let Some(mut data) = event_data(raw) else {
            return pass(out);
        };
        let kind = data
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let index = data.get("output_index").and_then(Value::as_i64);
        match kind.as_str() {
            "response.output_item.added" => {
                let item = data.get("item").cloned().unwrap_or(Value::Null);
                if is_file_call(&item) {
                    let arguments = item
                        .get("arguments")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    self.held.insert(
                        index.unwrap_or(-1),
                        Held {
                            item,
                            arguments,
                            sent: false,
                        },
                    );
                    return;
                }
                pass(out)
            }
            "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
                if let Some(held) = index.and_then(|i| self.held.get_mut(&i)) {
                    if kind.ends_with(".delta") {
                        if let Some(delta) = data.get("delta").and_then(Value::as_str) {
                            held.arguments.push_str(delta);
                        }
                    } else if let Some(full) = data.get("arguments").and_then(Value::as_str) {
                        held.arguments = full.to_string();
                    }
                    return;
                }
                pass(out)
            }
            "response.output_item.done" => {
                let item = data.get("item").cloned().unwrap_or(Value::Null);
                if !is_file_call(&item) {
                    return pass(out);
                }
                let index = index.unwrap_or(-1);
                if let Some(held) = self.held.get_mut(&index) {
                    held.sent = true;
                }
                let rewritten = rewrite_item(&item, &mut *self.command, &mut self.calls);
                self.emit_call(index, &rewritten, out);
            }
            "response.completed" | "response.incomplete" => {
                // A held call the stream never finished with an item is sent
                // from its streamed arguments, before the response ends.
                let mut pending: Vec<(i64, Value)> = self
                    .held
                    .iter()
                    .filter(|(_, h)| !h.sent)
                    .map(|(i, h)| {
                        let mut item = h.item.clone();
                        if let Some(o) = item.as_object_mut() {
                            o.insert("arguments".into(), Value::String(h.arguments.clone()));
                            o.insert("status".into(), Value::String("completed".into()));
                        }
                        (*i, item)
                    })
                    .collect();
                pending.sort_by_key(|(i, _)| *i);
                for (index, item) in pending {
                    if let Some(held) = self.held.get_mut(&index) {
                        held.sent = true;
                    }
                    let rewritten = rewrite_item(&item, &mut *self.command, &mut self.calls);
                    self.emit_call(index, &rewritten, out);
                }
                if let Some(Value::Array(items)) =
                    data.get_mut("response").and_then(|r| r.get_mut("output"))
                {
                    for item in items.iter_mut() {
                        if !is_file_call(item) {
                            continue;
                        }
                        let call_id = item.get("call_id").and_then(Value::as_str).unwrap_or("");
                        *item = match self.rewritten.get(call_id) {
                            Some(done) => done.clone(),
                            None => rewrite_item(item, &mut *self.command, &mut self.calls),
                        };
                    }
                }
                write_event(out, &kind, &data);
            }
            _ => pass(out),
        }
    }

    fn emit_call(&mut self, index: i64, item: &Value, out: &mut Vec<u8>) {
        if let Some(call_id) = item.get("call_id").and_then(Value::as_str) {
            self.rewritten.insert(call_id.to_string(), item.clone());
        }
        let mut added = item.clone();
        if let Some(o) = added.as_object_mut() {
            o.insert("status".into(), Value::String("in_progress".into()));
        }
        write_event(
            out,
            "response.output_item.added",
            &json!({ "type": "response.output_item.added", "output_index": index, "item": added }),
        );
        write_event(
            out,
            "response.output_item.done",
            &json!({ "type": "response.output_item.done", "output_index": index, "item": item }),
        );
    }
}

fn write_event(out: &mut Vec<u8>, kind: &str, data: &Value) {
    out.extend_from_slice(format!("event: {kind}\ndata: {data}\n\n").as_bytes());
}

/// The end of the first complete event in `buffer` and the length of the
/// blank-line separator after it.
fn event_end(buffer: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i + 1 < buffer.len() {
        if buffer[i] == b'\n' {
            if buffer[i + 1] == b'\n' {
                return Some((i, 2));
            }
            if buffer[i + 1] == b'\r' && buffer.get(i + 2) == Some(&b'\n') {
                return Some((i, 3));
            }
        }
        i += 1;
    }
    None
}

/// The JSON in an event's `data:` lines, joined, when there is any.
fn event_data(raw: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(raw).ok()?;
    let mut data = String::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(&data).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sse(kind: &str, data: Value) -> String {
        let mut data = data;
        data["type"] = Value::String(kind.into());
        format!("event: {kind}\ndata: {data}\n\n")
    }

    fn file_call(index: i64, name: &str, args: &str) -> Vec<String> {
        let item = json!({ "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": name, "arguments": "", "status": "in_progress" });
        let mut done = item.clone();
        done["arguments"] = Value::String(args.into());
        done["status"] = Value::String("completed".into());
        vec![
            sse(
                "response.output_item.added",
                json!({ "output_index": index, "item": item }),
            ),
            sse(
                "response.function_call_arguments.delta",
                json!({ "output_index": index, "item_id": "fc_1", "delta": &args[..args.len() / 2] }),
            ),
            sse(
                "response.function_call_arguments.delta",
                json!({ "output_index": index, "item_id": "fc_1", "delta": &args[args.len() / 2..] }),
            ),
            sse(
                "response.function_call_arguments.done",
                json!({ "output_index": index, "item_id": "fc_1", "arguments": args }),
            ),
            sse(
                "response.output_item.done",
                json!({ "output_index": index, "item": done }),
            ),
        ]
    }

    fn events(bytes: &[u8]) -> Vec<Value> {
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        text.split("\n\n")
            .filter_map(|e| event_data(e.as_bytes()))
            .collect()
    }

    fn fake_command(call: Result<&EditCall, &str>) -> String {
        match call {
            Ok(c) => format!("PATCH {}", c.path()),
            Err(e) => format!("ERROR {e}"),
        }
    }

    const ARGS: &str = r#"{"path":"a.txt","old_text":"one","new_text":"two"}"#;

    #[test]
    fn a_file_call_reaches_codex_as_one_exec_command_with_the_same_call_id() {
        let mut calls = CallMap::default();
        let mut stream = String::new();
        stream.push_str(&sse(
            "response.created",
            json!({ "response": { "id": "r" } }),
        ));
        stream.push_str(&sse(
            "response.output_text.delta",
            json!({ "output_index": 0, "delta": "Editing." }),
        ));
        for e in file_call(1, "edit_file", ARGS) {
            stream.push_str(&e);
        }
        stream.push_str(&sse(
            "response.completed",
            json!({ "response": { "id": "r", "output": [
            { "type": "message", "role": "assistant", "content": [] },
            { "type": "function_call", "call_id": "call_1", "name": "edit_file", "arguments": ARGS }
        ] } }),
        ));
        // Delivered in small, uneven pieces, as a network would.
        let mut out = Vec::new();
        let mut rewriter = StreamRewriter::new(fake_command);
        for piece in stream.as_bytes().chunks(7) {
            out.extend(rewriter.push(piece));
        }
        out.extend(rewriter.finish());
        for (id, call) in rewriter.take_calls() {
            calls.insert(id, call);
        }
        let seen = events(&out);
        let kinds: Vec<&str> = seen.iter().map(|e| e["type"].as_str().unwrap()).collect();
        assert_eq!(
            kinds,
            [
                "response.created",
                "response.output_text.delta",
                "response.output_item.added",
                "response.output_item.done",
                "response.completed"
            ]
        );
        let done = &seen[3]["item"];
        assert_eq!(done["name"], "exec_command");
        assert_eq!(done["call_id"], "call_1");
        let args: Value = serde_json::from_str(done["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args, json!({ "cmd": "PATCH a.txt" }));
        assert_eq!(seen[4]["response"]["output"][1], *done);
        assert!(calls.get("call_1").is_some());
        assert!(!String::from_utf8(out).unwrap().contains("edit_file"));
    }

    #[test]
    fn a_call_without_an_item_done_is_sent_from_its_streamed_arguments() {
        let parts = file_call(0, "write_file", r#"{"path":"n.md","content":"hi\n"}"#);
        let mut stream: String = parts[..4].concat();
        stream.push_str(&sse(
            "response.completed",
            json!({ "response": { "output": [] } }),
        ));
        let out = StreamRewriter::new(fake_command).push(stream.as_bytes());
        let seen = events(&out);
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[1]["item"]["name"], "exec_command");
        assert!(seen[1]["item"]["arguments"]
            .as_str()
            .unwrap()
            .contains("PATCH n.md"));
        assert_eq!(seen[2]["type"], "response.completed");
    }

    #[test]
    fn bad_arguments_still_become_a_command_that_reports_the_error() {
        let stream = file_call(0, "edit_file", r#"{"path":"a.txt"}"#).concat();
        let mut rewriter = StreamRewriter::new(fake_command);
        let out = rewriter.push(stream.as_bytes());
        let seen = events(&out);
        let args = seen[1]["item"]["arguments"].as_str().unwrap();
        assert!(
            args.contains("ERROR edit_file needs a string field old_text"),
            "{args}"
        );
        assert!(rewriter.take_calls().is_empty());
    }

    #[test]
    fn other_tool_calls_and_crlf_events_pass_through_unchanged() {
        let stream = file_call(0, "exec_command", r#"{"cmd":"ls"}"#)
            .concat()
            .replace('\n', "\r\n");
        let out = StreamRewriter::new(fake_command).push(stream.as_bytes());
        assert_eq!(out, stream.as_bytes());
    }

    #[test]
    fn request_gains_the_tools_and_instruction_once() {
        let calls = CallMap::default();
        let body = json!({
            "instructions": "Base.",
            "tools": [{ "type": "function", "name": "exec_command" }],
            "input": []
        });
        let once = rewrite_request(body.to_string().as_bytes(), &calls).unwrap();
        let twice = rewrite_request(&once, &calls).unwrap();
        let value: Value = serde_json::from_slice(&twice).unwrap();
        let names: Vec<&str> = value["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["exec_command", "edit_file", "write_file"]);
        assert_eq!(
            value["instructions"]
                .as_str()
                .unwrap()
                .matches(INSTRUCTION)
                .count(),
            1
        );
    }

    #[test]
    fn the_added_prompt_text_fits_a_small_context() {
        // Rules corner case 1: a 16,384 token window, about 4,100 used by
        // Codex's opening request. The two tools and the instruction add
        // under 1,400 bytes, about 350 tokens at 4 bytes a token.
        let calls = CallMap::default();
        let body = json!({ "instructions": "", "tools": [{ "type": "function", "name": "exec_command" }], "input": [] });
        let before = body.to_string().len();
        let after = rewrite_request(body.to_string().as_bytes(), &calls)
            .unwrap()
            .len();
        let added = after - before;
        assert!(added < 1_400, "added {added} bytes");
        eprintln!("edit adapter adds {added} bytes per request");
    }

    #[test]
    fn monocodes_own_apply_patch_howto_is_replaced_not_contradicted() {
        // The text the Models page writes (modelSetup.ts, DEFAULT_INSTRUCTIONS).
        let written = "You are a coding agent working in the user's repository.\n\nRun commands with the exec_command tool. There is no tool named shell.\nRead a file before you change it.\nEdit files by running apply_patch through exec_command:\n\napply_patch <<'EOF'\n*** Begin Patch\n*** Update File: path/to/file\n@@ context line\n-old line\n+new line\n*** End Patch\nEOF\n\nKeep answers short. Say what you changed.\n";
        let out = with_instruction(written);
        assert!(!out.contains("apply_patch <<"), "{out}");
        assert!(
            out.contains("Read a file before you change it.\nTo change a file, call edit_file"),
            "{out}"
        );
        assert!(
            out.ends_with("\n\nKeep answers short. Say what you changed.\n"),
            "{out}"
        );
        // Someone else's instructions keep every word, with the line added.
        assert_eq!(
            with_instruction("Be brief."),
            format!("Be brief.\n\n{INSTRUCTION}")
        );
        // A how-to with no closing EOF is left whole.
        let open = format!("{APPLY_PATCH_HOWTO}\napply_patch <<'X'");
        assert!(with_instruction(&open).starts_with(&open));
    }

    #[test]
    fn requests_without_exec_command_are_left_alone() {
        let calls = CallMap::default();
        assert!(rewrite_request(br#"{"input":[]}"#, &calls).is_none());
        assert!(rewrite_request(br#"{"tools":[{"name":"view_image"}]}"#, &calls).is_none());
        assert!(rewrite_request(b"not json", &calls).is_none());
    }

    #[test]
    fn history_shows_the_model_its_own_file_calls() {
        let mut calls = CallMap::default();
        calls.insert(
            "call_1".into(),
            EditCall::Edit {
                path: "a.txt".into(),
                old_text: "one".into(),
                new_text: "two".into(),
            },
        );
        let after_restart = crate::edit_adapter::patch::heredoc(
            "*** Begin Patch\n*** Add File: b.txt\n+x\n*** End Patch",
        );
        let body = json!({
            "tools": [{ "type": "function", "name": "exec_command" }],
            "input": [
                { "type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"anything\"}" },
                { "type": "function_call_output", "call_id": "call_1", "output": "Success." },
                { "type": "function_call", "call_id": "call_2", "name": "exec_command", "arguments": json!({ "cmd": after_restart }).to_string() },
                { "type": "function_call", "call_id": "call_3", "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}" }
            ]
        });
        let out: Value =
            serde_json::from_slice(&rewrite_request(body.to_string().as_bytes(), &calls).unwrap())
                .unwrap();
        let input = out["input"].as_array().unwrap();
        assert_eq!(input[0]["name"], "edit_file");
        assert_eq!(
            serde_json::from_str::<Value>(input[0]["arguments"].as_str().unwrap()).unwrap(),
            json!({ "path": "a.txt", "old_text": "one", "new_text": "two" })
        );
        assert_eq!(input[1]["output"], "Success.");
        assert_eq!(input[2]["name"], "write_file");
        assert_eq!(input[3]["name"], "exec_command");
    }

    #[test]
    fn the_call_map_forgets_the_oldest_beyond_its_limit() {
        let mut calls = CallMap::default();
        for i in 0..MAX_REMEMBERED_CALLS + 5 {
            calls.insert(
                format!("c{i}"),
                EditCall::Write {
                    path: "a".into(),
                    content: String::new(),
                },
            );
        }
        assert!(calls.get("c0").is_none());
        assert!(calls
            .get(&format!("c{}", MAX_REMEMBERED_CALLS + 4))
            .is_some());
    }
}
