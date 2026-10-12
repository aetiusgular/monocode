//! Turns an `edit_file` or `write_file` call into the `exec_command` command
//! Codex already intercepts: an `apply_patch` heredoc. Codex then runs its own
//! verified patch path, so its approval card, sandbox, writable folders and
//! tracked diff all apply.
//!
//! The file is read here, inside the session folder only, so `edit_file` can
//! work like a plain "replace this text" tool: the text is found once, widened
//! to whole lines, and sent as a hunk Codex's verifier matches exactly. When
//! the call cannot become a patch, the command is a plain `echo` of the reason
//! followed by `false`, so the model reads the error as a failed command.

use std::fs;
use std::path::{Component, Path, PathBuf};

/// Delimiter prefix for every heredoc this adapter writes. A command that
/// starts with `apply_patch <<'MONOCODE_EDIT_` came from here.
pub const DELIMITER_PREFIX: &str = "MONOCODE_EDIT_";
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PATH_CHARS: usize = 1024;
const MAX_MESSAGE_CHARS: usize = 400;

/// The whole lines a change touches: before, then after.
type LineChange = (Vec<String>, Vec<String>);

/// A file call from the model, with its arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EditCall {
    Edit {
        path: String,
        old_text: String,
        new_text: String,
    },
    Write {
        path: String,
        content: String,
    },
}

impl EditCall {
    pub fn name(&self) -> &'static str {
        match self {
            EditCall::Edit { .. } => "edit_file",
            EditCall::Write { .. } => "write_file",
        }
    }

    pub fn path(&self) -> &str {
        match self {
            EditCall::Edit { path, .. } | EditCall::Write { path, .. } => path,
        }
    }

    /// The call's arguments as the model sent them, for the history rewrite.
    pub fn arguments_json(&self) -> String {
        let value = match self {
            EditCall::Edit {
                path,
                old_text,
                new_text,
            } => serde_json::json!({ "path": path, "old_text": old_text, "new_text": new_text }),
            EditCall::Write { path, content } => {
                serde_json::json!({ "path": path, "content": content })
            }
        };
        value.to_string()
    }

    /// Parses a call by tool name and its JSON arguments. An error is the
    /// message to send back to the model.
    pub fn parse(name: &str, arguments: &str) -> Result<EditCall, String> {
        let value: serde_json::Value = serde_json::from_str(arguments)
            .map_err(|_| format!("{name}: the arguments are not valid JSON"))?;
        let field = |key: &str| -> Result<String, String> {
            value
                .get(key)
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .ok_or_else(|| format!("{name} needs a string field {key}"))
        };
        match name {
            "edit_file" => Ok(EditCall::Edit {
                path: field("path")?,
                old_text: field("old_text")?,
                new_text: field("new_text")?,
            }),
            "write_file" => Ok(EditCall::Write {
                path: field("path")?,
                content: field("content")?,
            }),
            _ => Err(format!("{name} is not a file tool")),
        }
    }
}

/// The patch that Codex receives, before it is wrapped in a heredoc.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// The patch body, from `*** Begin Patch` to `*** End Patch`.
    Patch(String),
    /// Why the call cannot be applied, for the model.
    Refuse(String),
}

/// Builds the patch for a call, reading the file under `root` when needed.
pub fn plan(root: &Path, call: &EditCall) -> Plan {
    match plan_inner(root, call) {
        Ok(body) => Plan::Patch(body),
        Err(message) => Plan::Refuse(message),
    }
}

/// The `exec_command` `cmd` for a call: an `apply_patch` heredoc, or an
/// `echo` of the reason it was refused.
pub fn command_for(root: &Path, call: &EditCall) -> String {
    match plan(root, call) {
        Plan::Patch(body) => heredoc(&body),
        Plan::Refuse(message) => refusal_command(&message),
    }
}

fn plan_inner(root: &Path, call: &EditCall) -> Result<String, String> {
    let path = call.path();
    let target = resolve(root, path)?;
    match call {
        EditCall::Edit {
            old_text, new_text, ..
        } => {
            if old_text.is_empty() {
                return Err(format!(
                    "edit_file: old_text is empty. To create {path}, call write_file."
                ));
            }
            if old_text == new_text {
                return Err(format!(
                    "edit_file: old_text and new_text are the same, so {path} is unchanged."
                ));
            }
            // When the text cannot be placed, the model's own lines go to Codex
            // as they are. Codex's verifier then refuses the patch before any
            // approval card and tells the model which lines it could not find.
            let as_sent = || update_patch(path, &region_lines(old_text), &region_lines(new_text));
            let content = match read_text(&target, path)? {
                Some(content) => content,
                None => return Ok(as_sent()),
            };
            match replace_block(&content, old_text, new_text, path)? {
                Some((old_lines, new_lines)) => Ok(update_patch(path, &old_lines, &new_lines)),
                None => Ok(as_sent()),
            }
        }
        EditCall::Write { content, .. } => {
            if let Ok(meta) = fs::metadata(&target) {
                if meta.is_dir() {
                    return Err(format!("write_file: {path} is a folder."));
                }
            }
            Ok(add_patch(path, content))
        }
    }
}

/// Resolves a path the model gave, relative to `root`. Refuses absolute
/// paths, `..`, a leading `~`, control characters, and any path that leaves
/// the folder through a symbolic link. The name is otherwise taken literally.
pub fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let shown = clip(path, 120);
    if path.is_empty() {
        return Err("The path is empty. Give a path relative to the project folder.".into());
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return Err("The path is too long.".into());
    }
    if path.chars().any(|c| c.is_control()) {
        return Err("The path holds a control character, such as a line break.".into());
    }
    if path.trim() != path {
        return Err(format!(
            "The path '{shown}' starts or ends with a space. Give the exact relative path."
        ));
    }
    if path.starts_with('~') {
        return Err(format!(
            "The path '{shown}' starts with ~. Paths are relative to the project folder."
        ));
    }
    let relative = Path::new(path);
    for component in relative.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!(
                    "The path '{shown}' uses '..'. Only files inside the project folder can change."
                ))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "The path '{shown}' is absolute. Give a path relative to the project folder."
                ))
            }
        }
    }
    let root = root
        .canonicalize()
        .map_err(|_| "The project folder cannot be read.".to_string())?;
    let target = root.join(relative);
    // The deepest part of the path that exists must stay inside the folder
    // once its links are followed. A dangling link counts as existing.
    let mut probe = target.clone();
    loop {
        if fs::symlink_metadata(&probe).is_ok() {
            let real = probe
                .canonicalize()
                .map_err(|_| format!("The path '{shown}' is a link that leads nowhere."))?;
            if !real.starts_with(&root) {
                return Err(format!(
                    "The path '{shown}' leads outside the project folder through a link."
                ));
            }
            break;
        }
        if !probe.pop() {
            break;
        }
    }
    Ok(target)
}

/// The file's text, or `None` when there is no such file.
fn read_text(target: &Path, path: &str) -> Result<Option<String>, String> {
    let Ok(meta) = fs::metadata(target) else {
        return Ok(None);
    };
    if meta.is_dir() {
        return Err(format!("edit_file: {path} is a folder."));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "edit_file: {path} is larger than 4 MB. Change it with a command instead."
        ));
    }
    let bytes = fs::read(target).map_err(|_| format!("edit_file: {path} cannot be read."))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| format!("edit_file: {path} is not UTF-8 text."))
}

/// Finds `old_text` once in `content` and returns the whole lines it touches,
/// before and after the change. `None` when it is not there, even with its
/// indentation ignored. Lines keep a trailing `\r` from the file; Codex's
/// patch parser drops it from changed lines, so a CRLF file's changed lines
/// become LF, as with any Codex edit.
fn replace_block(
    content: &str,
    old_text: &str,
    new_text: &str,
    path: &str,
) -> Result<Option<LineChange>, String> {
    let mut old = old_text.to_string();
    let mut new = new_text.to_string();
    let mut found: Vec<usize> = content.match_indices(&old).map(|(i, _)| i).collect();
    // A model that read a CRLF file sees plain line breaks.
    if found.is_empty() && content.contains("\r\n") && old.contains('\n') && !old.contains('\r') {
        old = old.replace('\n', "\r\n");
        new = new.replace("\r\n", "\n").replace('\n', "\r\n");
        found = content.match_indices(&old).map(|(i, _)| i).collect();
    }
    match found.len() {
        0 => return loose_block(content, old_text, new_text, path),
        1 => {}
        n => {
            return Err(format!(
                "edit_file: old_text appears {n} times in {path}. Include more of the surrounding lines so it appears once."
            ))
        }
    }
    let start = found[0];
    let end = start + old.len();
    let line_start = content[..start].rfind('\n').map_or(0, |i| i + 1);
    // The region runs to the end of the last line the match touches,
    // including that line's break.
    // The start of the match's last character, not `end - 1`: old text that
    // ends in a multi-byte character would put `end - 1` inside it.
    let last_char = content[..end]
        .char_indices()
        .next_back()
        .map_or(start, |(i, _)| i);
    let mut region_end = line_end_after(content, last_char);
    let mut new_region = format!(
        "{}{}{}",
        &content[line_start..start],
        new,
        &content[end..region_end]
    );
    // The change removed the region's last line break, so the next line joins it.
    if content[..region_end].ends_with('\n')
        && !new_region.is_empty()
        && !new_region.ends_with('\n')
    {
        let next_end = if region_end < content.len() {
            line_end_after(content, region_end)
        } else {
            region_end
        };
        new_region.push_str(&content[region_end..next_end]);
        region_end = next_end;
    }
    let old_region = &content[line_start..region_end];
    Ok(Some((region_lines(old_region), region_lines(&new_region))))
}

/// Whole lines that match `old_text` line by line once indentation, trailing
/// spaces and typographic quotes and dashes are ignored, the way Codex's own
/// verifier is lenient. The new lines keep the file's indentation: the model's
/// base indentation is swapped for the file's, and its relative indentation
/// is kept. `None` when there is no such block.
fn loose_block(
    content: &str,
    old_text: &str,
    new_text: &str,
    path: &str,
) -> Result<Option<LineChange>, String> {
    let mut file: Vec<&str> = content.split('\n').collect();
    if content.ends_with('\n') {
        file.pop();
    }
    let lines = |text: &str| -> Vec<String> {
        region_lines(text)
            .into_iter()
            .map(|l| l.trim_end_matches('\r').to_string())
            .collect()
    };
    let old = lines(old_text);
    let first = match old.iter().position(|l| !l.trim().is_empty()) {
        Some(i) => i,
        None => return Ok(None),
    };
    let want: Vec<String> = old.iter().map(|l| loose_key(l)).collect();
    let hits: Vec<usize> = if file.len() >= want.len() {
        (0..=file.len() - want.len())
            .filter(|&w| (0..want.len()).all(|i| loose_key(file[w + i]) == want[i]))
            .collect()
    } else {
        Vec::new()
    };
    let at = match hits.len() {
        0 => return Ok(None),
        1 => hits[0],
        n => {
            return Err(format!(
                "edit_file: old_text matches {n} places in {path} once indentation is ignored. Include more of the surrounding lines so it matches once."
            ))
        }
    };
    let indent =
        |l: &str| -> String { l.chars().take_while(|c| *c == ' ' || *c == '\t').collect() };
    let file_indent = indent(file[at + first].trim_end_matches('\r'));
    let model_indent = indent(&old[first]);
    let new_lines = lines(new_text)
        .into_iter()
        .map(|line| {
            if line.trim().is_empty() {
                String::new()
            } else if let Some(rest) = line.strip_prefix(model_indent.as_str()) {
                format!("{file_indent}{rest}")
            } else {
                line
            }
        })
        .collect();
    let old_lines = file[at..at + old.len()]
        .iter()
        .map(|l| l.to_string())
        .collect();
    Ok(Some((old_lines, new_lines)))
}

/// A line compared without its surrounding spaces, with typographic quotes,
/// dashes and odd spaces made plain.
fn loose_key(line: &str) -> String {
    line.trim()
        .chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

/// The index just past the line break that ends the line holding `at`, or
/// the end of the content.
fn line_end_after(content: &str, at: usize) -> usize {
    match content[at..].find('\n') {
        Some(i) => at + i + 1,
        None => content.len(),
    }
}

/// The lines of a region of whole lines, without their `\n`.
fn region_lines(region: &str) -> Vec<String> {
    if region.is_empty() {
        return Vec::new();
    }
    let body = region.strip_suffix('\n').unwrap_or(region);
    body.split('\n').map(str::to_owned).collect()
}

fn update_patch(path: &str, old_lines: &[String], new_lines: &[String]) -> String {
    let mut body = format!("*** Begin Patch\n*** Update File: {path}\n@@\n");
    for line in old_lines {
        body.push('-');
        body.push_str(line);
        body.push('\n');
    }
    for line in new_lines {
        body.push('+');
        body.push_str(line);
        body.push('\n');
    }
    body.push_str("*** End Patch");
    body
}

fn add_patch(path: &str, content: &str) -> String {
    let mut body = format!("*** Begin Patch\n*** Add File: {path}\n");
    for line in region_lines(content) {
        body.push('+');
        body.push_str(&line);
        body.push('\n');
    }
    body.push_str("*** End Patch");
    body
}

/// Wraps a patch in `apply_patch <<'DELIM'`, with a random delimiter that no
/// line of the patch equals.
pub fn heredoc(body: &str) -> String {
    loop {
        let delimiter = format!(
            "{DELIMITER_PREFIX}{}",
            uuid::Uuid::new_v4().simple().to_string().to_uppercase()
        );
        if body
            .lines()
            .all(|line| line.trim_end_matches('\r') != delimiter)
        {
            return format!("apply_patch <<'{delimiter}'\n{body}\n{delimiter}\n");
        }
    }
}

/// An `echo` of the message, then `false`, as one command. The message is
/// single-quoted with every quote and control character removed, so nothing
/// in it reaches the shell as syntax.
pub fn refusal_command(message: &str) -> String {
    let text: String = clip(message, MAX_MESSAGE_CHARS)
        .chars()
        .map(|c| if c == '\'' { '"' } else { c })
        .filter(|c| !c.is_control())
        .collect();
    format!("echo 'edit not applied: {text}' && false")
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push_str("...");
        out
    }
}

/// Reads back a command this adapter wrote, as the call it stands for. Used
/// when the history holds an adapter command whose original call is not in
/// memory, after a restart. An `edit_file` comes back as whole lines.
pub fn parse_adapter_command(cmd: &str) -> Option<EditCall> {
    let rest = cmd.strip_prefix("apply_patch <<'")?;
    let (delimiter, rest) = rest.split_once("'\n")?;
    if !delimiter.starts_with(DELIMITER_PREFIX) {
        return None;
    }
    let body = rest.strip_suffix(&format!("\n{delimiter}\n"))?;
    let mut lines = body.split('\n');
    if lines.next()? != "*** Begin Patch" {
        return None;
    }
    let header = lines.next()?;
    let mut all: Vec<&str> = lines.collect();
    if all.pop()? != "*** End Patch" {
        return None;
    }
    if let Some(path) = header.strip_prefix("*** Add File: ") {
        let content = all
            .iter()
            .map(|l| l.strip_prefix('+'))
            .collect::<Option<Vec<_>>>()?;
        let mut text = content.join("\n");
        if !content.is_empty() {
            text.push('\n');
        }
        return Some(EditCall::Write {
            path: path.to_string(),
            content: text,
        });
    }
    let path = header.strip_prefix("*** Update File: ")?;
    if all.first() != Some(&"@@") {
        return None;
    }
    let (mut old, mut new) = (Vec::new(), Vec::new());
    for line in &all[1..] {
        if let Some(l) = line.strip_prefix('-') {
            old.push(l);
        } else {
            new.push(line.strip_prefix('+')?);
        }
    }
    let join = |v: &[&str]| {
        if v.is_empty() {
            String::new()
        } else {
            format!("{}\n", v.join("\n"))
        }
    };
    Some(EditCall::Edit {
        path: path.to_string(),
        old_text: join(&old),
        new_text: join(&new),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("edit-adapter-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn edit(path: &str, old: &str, new: &str) -> EditCall {
        EditCall::Edit {
            path: path.into(),
            old_text: old.into(),
            new_text: new.into(),
        }
    }

    fn patch(root: &Path, call: &EditCall) -> String {
        match plan(root, call) {
            Plan::Patch(body) => body,
            Plan::Refuse(message) => panic!("refused: {message}"),
        }
    }

    fn refused(root: &Path, call: &EditCall) -> String {
        match plan(root, call) {
            Plan::Refuse(message) => message,
            Plan::Patch(body) => panic!("expected a refusal, got {body}"),
        }
    }

    #[test]
    fn substring_edit_widens_to_the_whole_line_and_keeps_indentation() {
        let root = temp_root();
        fs::write(root.join("hello.py"), "def greet():\n    return \"hi\"\n").unwrap();
        let body = patch(&root, &edit("hello.py", "\"hi\"", "\"hello\""));
        assert_eq!(
            body,
            "*** Begin Patch\n*** Update File: hello.py\n@@\n-    return \"hi\"\n+    return \"hello\"\n*** End Patch"
        );
    }

    #[test]
    fn old_text_ending_in_a_multibyte_character_does_not_panic() {
        let root = temp_root();
        fs::write(root.join("menu.txt"), "café = 1\nthé 🙂\nnext\n").unwrap();
        let body = patch(&root, &edit("menu.txt", "café", "cafe"));
        assert!(body.contains("@@\n-café = 1\n+cafe = 1\n*** End"), "{body}");
        let body = patch(&root, &edit("menu.txt", "thé 🙂", "tea"));
        assert!(body.contains("@@\n-thé 🙂\n+tea\n*** End"), "{body}");
    }

    #[test]
    fn several_lines_replace_as_one_block() {
        let root = temp_root();
        fs::write(root.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        let body = patch(&root, &edit("a.txt", "two\nthree", "2\n3\n3.5"));
        assert!(
            body.contains("@@\n-two\n-three\n+2\n+3\n+3.5\n*** End"),
            "{body}"
        );
    }

    #[test]
    fn deleting_whole_lines_leaves_no_empty_line() {
        let root = temp_root();
        fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let body = patch(&root, &edit("a.txt", "two\n", ""));
        assert!(body.contains("@@\n-two\n*** End"), "{body}");
    }

    #[test]
    fn removing_a_line_break_joins_the_next_line() {
        let root = temp_root();
        fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let body = patch(&root, &edit("a.txt", "one\n", "one "));
        assert!(body.contains("@@\n-one\n-two\n+one two\n*** End"), "{body}");
    }

    #[test]
    fn last_line_without_a_break_is_found() {
        let root = temp_root();
        fs::write(root.join("a.txt"), "one\nlast").unwrap();
        let body = patch(&root, &edit("a.txt", "last", "final"));
        assert!(body.contains("@@\n-last\n+final\n*** End"), "{body}");
    }

    #[test]
    fn whitespace_is_kept_exactly() {
        let root = temp_root();
        fs::write(root.join("a.py"), "if x:\n\tpass  \n").unwrap();
        let body = patch(&root, &edit("a.py", "\tpass  ", "\treturn 1\t"));
        assert!(body.contains("-\tpass  \n+\treturn 1\t\n"), "{body:?}");
    }

    #[test]
    fn crlf_file_matches_plain_breaks_and_stays_crlf() {
        let root = temp_root();
        fs::write(root.join("w.txt"), "a\r\nb\r\nc\r\n").unwrap();
        let body = patch(&root, &edit("w.txt", "a\nb", "a\nB"));
        assert!(
            body.contains("@@\n-a\r\n-b\r\n+a\r\n+B\r\n*** End"),
            "{body:?}"
        );
    }

    #[test]
    fn missing_text_or_file_goes_to_codexs_verifier_as_sent() {
        let root = temp_root();
        fs::write(root.join("a.txt"), "one\n").unwrap();
        assert_eq!(
            patch(&root, &edit("a.txt", "two\nthree", "four")),
            "*** Begin Patch\n*** Update File: a.txt\n@@\n-two\n-three\n+four\n*** End Patch"
        );
        assert!(patch(&root, &edit("b.txt", "one", "two"))
            .contains("*** Update File: b.txt\n@@\n-one\n+two\n"));
    }

    #[test]
    fn wrong_indentation_is_matched_and_the_files_indentation_kept() {
        let root = temp_root();
        fs::write(
            root.join("a.py"),
            "class A:\n    def f(self):\n        return 1\n",
        )
        .unwrap();
        // The model dropped the base indentation and kept its own relative one.
        let body = patch(
            &root,
            &edit(
                "a.py",
                "def f(self):\n    return 1",
                "def f(self):\n    x = 2\n    return x",
            ),
        );
        assert!(
            body.contains("@@\n-    def f(self):\n-        return 1\n+    def f(self):\n+        x = 2\n+        return x\n*** End"),
            "{body}"
        );
        // Typographic quotes count as plain ones.
        fs::write(root.join("q.txt"), "say \"hi\"\n").unwrap();
        assert!(patch(
            &root,
            &edit("q.txt", "  say \u{201C}hi\u{201D}", "say \"yo\"")
        )
        .contains("-say \"hi\"\n+say \"yo\""));
    }

    #[test]
    fn loose_match_in_two_places_is_refused() {
        let root = temp_root();
        fs::write(root.join("a.py"), "if a:\n    x = 1\nif b:\n  x = 1\n").unwrap();
        let message = refused(&root, &edit("a.py", "x = 1\n", "x = 2\n"));
        assert!(message.contains("appears 2 times"), "{message}");
        let message = refused(&root, &edit("a.py", "\tx = 1\t", "x = 2"));
        assert!(message.contains("2 places"), "{message}");
    }

    #[test]
    fn repeated_text_asks_for_more_context() {
        let root = temp_root();
        fs::write(root.join("a.txt"), "x = 1\nx = 1\n").unwrap();
        let message = refused(&root, &edit("a.txt", "x = 1", "x = 2"));
        assert!(message.contains("appears 2 times"), "{message}");
    }

    #[test]
    fn empty_old_text_same_text_and_missing_file_are_refused() {
        let root = temp_root();
        fs::write(root.join("a.txt"), "one\n").unwrap();
        assert!(refused(&root, &edit("a.txt", "", "x")).contains("write_file"));
        assert!(refused(&root, &edit("a.txt", "one", "one")).contains("unchanged"));
        fs::create_dir(root.join("d")).unwrap();
        assert!(refused(&root, &edit("d", "one", "two")).contains("folder"));
        fs::write(root.join("bin"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(refused(&root, &edit("bin", "one", "two")).contains("UTF-8"));
    }

    #[test]
    fn path_escapes_are_refused() {
        let root = temp_root();
        for bad in [
            "/etc/passwd",
            "../x",
            "a/../../x",
            "~/x",
            "a\nb",
            " a.txt",
            "a.txt ",
            "",
        ] {
            assert!(
                matches!(plan(&root, &edit(bad, "a", "b")), Plan::Refuse(_)),
                "{bad:?} was not refused"
            );
            let write = EditCall::Write {
                path: bad.into(),
                content: "x".into(),
            };
            assert!(matches!(plan(&root, &write), Plan::Refuse(_)), "{bad:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_folder_is_refused() {
        let root = temp_root();
        let outside = temp_root();
        fs::write(outside.join("secret.txt"), "one\n").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("s.txt")).unwrap();
        std::os::unix::fs::symlink(outside.join("nothing"), root.join("dangling")).unwrap();
        assert!(refused(&root, &edit("out/secret.txt", "one", "two")).contains("outside"));
        assert!(refused(&root, &edit("s.txt", "one", "two")).contains("outside"));
        let write = |p: &str| EditCall::Write {
            path: p.into(),
            content: "x".into(),
        };
        assert!(matches!(
            plan(&root, &write("out/new.txt")),
            Plan::Refuse(_)
        ));
        assert!(matches!(plan(&root, &write("dangling")), Plan::Refuse(_)));
    }

    #[test]
    fn names_with_spaces_and_a_leading_dash_are_taken_literally() {
        let root = temp_root();
        fs::write(root.join("my notes.txt"), "a\n").unwrap();
        fs::write(root.join("-rf"), "a\n").unwrap();
        assert!(patch(&root, &edit("my notes.txt", "a", "b"))
            .contains("*** Update File: my notes.txt\n"));
        assert!(patch(&root, &edit("-rf", "a", "b")).contains("*** Update File: -rf\n"));
    }

    #[test]
    fn write_file_adds_each_line() {
        let root = temp_root();
        let call = EditCall::Write {
            path: "new/notes.md".into(),
            content: "# Title\n\nbody\n".into(),
        };
        assert_eq!(
            patch(&root, &call),
            "*** Begin Patch\n*** Add File: new/notes.md\n+# Title\n+\n+body\n*** End Patch"
        );
    }

    #[test]
    fn heredoc_round_trips_and_its_delimiter_is_never_a_patch_line() {
        let root = temp_root();
        fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        let call = edit("a.txt", "two", "MONOCODE_EDIT_X\n*** End Patch");
        let cmd = command_for(&root, &call);
        assert!(cmd.starts_with("apply_patch <<'MONOCODE_EDIT_"), "{cmd}");
        let delimiter = cmd.split('\'').nth(1).unwrap();
        assert_eq!(cmd.matches(&format!("\n{delimiter}\n")).count(), 1);
        assert_eq!(
            parse_adapter_command(&cmd),
            Some(edit("a.txt", "two\n", "MONOCODE_EDIT_X\n*** End Patch\n"))
        );
        let write = EditCall::Write {
            path: "b.txt".into(),
            content: "x\ny\n".into(),
        };
        assert_eq!(
            parse_adapter_command(&command_for(&root, &write)),
            Some(write)
        );
        assert_eq!(
            parse_adapter_command("apply_patch <<'EOF'\n*** Begin Patch\n*** End Patch\nEOF\n"),
            None
        );
        assert_eq!(parse_adapter_command("ls -la"), None);
    }

    #[test]
    fn refusal_command_cannot_break_out_of_its_quotes() {
        let cmd = refusal_command("it's $(rm -rf ~)\n`x`");
        assert_eq!(
            cmd,
            "echo 'edit not applied: it\"s $(rm -rf ~)`x`' && false"
        );
        assert_eq!(cmd.matches('\'').count(), 2);
    }

    #[test]
    fn parse_reads_both_tools_and_names_a_missing_field() {
        assert_eq!(
            EditCall::parse("edit_file", r#"{"path":"a","old_text":"b","new_text":"c"}"#),
            Ok(edit("a", "b", "c"))
        );
        assert!(EditCall::parse("edit_file", r#"{"path":"a"}"#)
            .unwrap_err()
            .contains("old_text"));
        assert!(EditCall::parse("write_file", "not json").is_err());
    }
}
