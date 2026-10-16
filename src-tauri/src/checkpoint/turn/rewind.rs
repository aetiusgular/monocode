//! Restore the workspace to how it was before an earlier turn of this
//! session, not only the latest one. The saved turn's `before` snapshot is
//! compared with the folder as it is now, and every regular file that differs
//! is put back. The folder is captured first, so the restore can be undone.
//!
//! Limits, as for every checkpoint: Git repositories only, gitignored files
//! are never captured and never touched, and the user's index is never reset.
use super::*;

#[cfg(test)]
mod tests;

/// Saved turns are kept under these names, so a backup sorts beside them.
fn backup_ref(session_id: &str, label: &str) -> String {
    format!("refs/monocode/checkpoints/{session_id}/{label}/backup")
}

impl CheckpointStore {
    fn saved_turn(&self, session_id: &str, cwd: &str, turn_id: &str) -> Result<SavedTurn, String> {
        validate_id(turn_id, "turn")?;
        self.refuse_home(cwd)?;
        let path = self
            .session_dir(session_id)
            .join("turns")
            .join(format!("{turn_id}.json"));
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("No checkpoint was saved for this turn".into())
            }
            Err(error) => return Err(error.to_string()),
        };
        let saved: SavedTurn = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let root = std::fs::canonicalize(project_root(cwd)?).map_err(|e| e.to_string())?;
        if saved.cwd != path_to_js(&root) {
            return Err("This turn ran in another folder".into());
        }
        if let Some(error) = &saved.turn.error {
            return Err(format!("This turn's checkpoint failed: {error}"));
        }
        if saved.turn.before.is_none() {
            return Err("This turn has no checkpoint from before it".into());
        }
        Ok(saved)
    }

    /// Why a restore must not run now, if it must not.
    fn restore_blocker(
        &self,
        session_id: &str,
        saved: &SavedTurn,
    ) -> Result<Option<String>, String> {
        let root = Path::new(&saved.cwd);
        if read_review(&self.session_dir(session_id))?.is_some_and(|review| review.active.is_some())
        {
            return Ok(Some("A turn is still running in this chat".into()));
        }
        if !self.active_turns(root, session_id)?.is_empty() {
            return Ok(Some("Another chat is working in this folder".into()));
        }
        let head = run_git(root, &["rev-parse", "--verify", "HEAD"])
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string());
        if head != saved.turn.head {
            return Ok(Some(
                "The branch has moved since this turn. Commits are never undone here".into(),
            ));
        }
        Ok(None)
    }

    /// What the folder holds now against what it held before the turn.
    fn changes_since(&self, root: &Path, before: &str, now: &str) -> Result<Vec<Change>, String> {
        changes(
            root,
            &RecordedTurn {
                id: String::new(),
                before: Some(before.into()),
                after: Some(now.into()),
                head: None,
                shared: false,
                error: None,
                dismissed: BTreeSet::new(),
                edited: BTreeSet::new(),
                started_ms: None,
            },
        )
    }

    pub(in crate::checkpoint) fn restore_preview(
        &self,
        session_id: &str,
        cwd: &str,
        turn_id: &str,
    ) -> Result<RestorePreview, String> {
        let saved = self.saved_turn(session_id, cwd, turn_id)?;
        let blocked = self.restore_blocker(session_id, &saved)?;
        let root = Path::new(&saved.cwd);
        // A throwaway capture, removed again: a preview leaves nothing behind.
        let reference = backup_ref(session_id, &format!("preview-{}", uuid::Uuid::new_v4()));
        let now = capture_workspace(root, &reference)?;
        let compared = self.changes_since(root, saved.turn.before.as_deref().unwrap(), &now);
        let _ = run_git(root, &["update-ref", "-d", &reference]);
        let files = compared?
            .iter()
            .map(|change| restore_file(root, change))
            .collect();
        Ok(RestorePreview {
            turn_id: turn_id.into(),
            files,
            blocked,
        })
    }

    pub(in crate::checkpoint) fn restore_to_turn(
        &self,
        session_id: &str,
        cwd: &str,
        turn_id: &str,
    ) -> Result<RestoreResult, String> {
        let saved = self.saved_turn(session_id, cwd, turn_id)?;
        if let Some(reason) = self.restore_blocker(session_id, &saved)? {
            return Err(reason);
        }
        let root = Path::new(&saved.cwd);
        let before = saved.turn.before.clone().unwrap();
        let label = format!("restore-{}", uuid::Uuid::new_v4());
        let reference = backup_ref(session_id, &label);
        let backup = capture_workspace(root, &reference)?;
        let mut restored = Vec::new();
        let mut skipped = Vec::new();
        for change in self.changes_since(root, &before, &backup)? {
            if !restorable(root, &change) {
                skipped.push(change.relative);
                continue;
            }
            if change.before.is_some() {
                run_git(
                    root,
                    &[
                        "restore",
                        "--source",
                        &before,
                        "--worktree",
                        "--",
                        &change.relative,
                    ],
                )?;
            } else {
                std::fs::remove_file(root.join(&change.relative)).map_err(|e| e.to_string())?;
            }
            restored.push(change.relative);
        }
        Ok(RestoreResult {
            restored,
            skipped,
            backup,
            backup_ref: reference,
        })
    }
}

fn restore_file(root: &Path, change: &Change) -> RestoreFile {
    let action = match (&change.before, &change.after) {
        (Some(_), Some(_)) => "restore",
        (Some(_), None) => "recreate",
        _ => "delete",
    };
    let restorable = restorable(root, change);
    RestoreFile {
        path: path_to_js(&root.join(&change.relative)),
        relative: change.relative.clone(),
        action: action.into(),
        restorable,
        reason: (!restorable).then(|| {
            if path_contains_symlink(root, &change.relative) {
                "It sits behind a symbolic link".into()
            } else {
                "Not a regular file, or it changed while this was checked".into()
            }
        }),
    }
}
