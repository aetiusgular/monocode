use super::*;

struct Fixture {
    dir: PathBuf,
    repo: PathBuf,
    store: CheckpointStore,
}

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("monocode-turn-test-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]).unwrap();
        run_git(&repo, &["config", "user.name", "Test"]).unwrap();
        run_git(&repo, &["config", "user.email", "test@example.invalid"]).unwrap();
        run_git(&repo, &["config", "core.autocrlf", "false"]).unwrap();
        std::fs::write(repo.join("a.txt"), "original\n").unwrap();
        std::fs::write(repo.join("delete.txt"), "remove me\n").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["commit", "-m", "initial"]).unwrap();
        Self {
            store: CheckpointStore::new(dir.join("checkpoints")),
            dir,
            repo,
        }
    }
    fn cwd(&self) -> &str {
        self.repo.to_str().unwrap()
    }
    fn write(&self, path: &str, text: &str) {
        let path = self.repo.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn records_shell_changes_and_preserves_the_index_head_and_saved_result() {
    let f = Fixture::new();
    f.write("a.txt", "user change\n");
    f.write("user.txt", "existing untracked work\n");
    run_git(&f.repo, &["add", "a.txt"]).unwrap();
    let index = std::fs::read(f.repo.join(".git/index")).unwrap();
    let head = run_git(&f.repo, &["rev-parse", "HEAD"]).unwrap();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    // No structured edit events: the actual file state is authoritative.
    f.write("a.txt", "user change\nagent change\n");
    f.write("new.txt", "one\ntwo\n");
    std::fs::remove_file(f.repo.join("delete.txt")).unwrap();
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(
        status
            .files
            .iter()
            .map(|file| file.relative.as_str())
            .collect::<Vec<_>>(),
        ["a.txt", "delete.txt", "new.txt"]
    );
    assert_eq!(
        (status.files[0].additions, status.files[0].deletions),
        (1, 0)
    );
    assert!(status.files.iter().all(|file| file.exact && file.undoable));
    assert_eq!(std::fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert_eq!(run_git(&f.repo, &["rev-parse", "HEAD"]).unwrap(), head);

    f.write("a.txt", "a later editor change\n");
    // Reopening the store proves the review survives a restart and never reads
    // later contents as though they were this turn's result.
    let reopened = CheckpointStore::new(f.dir.join("checkpoints"));
    let diff = reopened.file_diff("session", f.cwd(), "a.txt").unwrap();
    assert_eq!(diff.original, "user change\n");
    assert_eq!(diff.current, "user change\nagent change\n");
    let status = reopened.status("session", f.cwd()).unwrap();
    assert!(status.files[0].exact);
    assert!(!status.files[0].undoable);
    assert!(reopened.undo("session", f.cwd(), None).is_err());
    assert!(f.repo.join("new.txt").exists());
    assert!(!f.repo.join("delete.txt").exists());
}

#[test]
fn each_turn_has_a_fresh_baseline_and_noop_turns_clear_the_old_card() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "first turn\n");
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "external edit between turns\n");
    f.store.begin_turn("session", f.cwd(), "second").unwrap();
    f.write("a.txt", "external edit between turns\nsecond turn\n");
    f.store.finish_turn("session", f.cwd(), "second").unwrap();
    let diff = f.store.file_diff("session", f.cwd(), "a.txt").unwrap();
    assert_eq!(diff.original, "external edit between turns\n");
    assert_eq!(diff.current, "external edit between turns\nsecond turn\n");
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(
        (status.files[0].additions, status.files[0].deletions),
        (1, 0)
    );
    f.store.begin_turn("session", f.cwd(), "third").unwrap();
    f.store.finish_turn("session", f.cwd(), "third").unwrap();
    assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());
    assert!(f.dir.join("checkpoints/session/turns/first.json").exists());
    assert!(run_git(
        &f.repo,
        &["rev-parse", &turn_ref("session", "first", "after")]
    )
    .is_ok());
}

#[test]
fn continuing_an_unfinished_turn_preserves_its_baseline_and_edit_evidence() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.store.begin_turn("other", f.cwd(), "other").unwrap();
    f.write("a.txt", "session edit\n");
    f.store
        .capture("session", f.cwd(), &["a.txt".into()])
        .unwrap();
    f.write("foreign.txt", "other session\n");
    // The UI reloads before it can finish the first checkpoint, then continues.
    let reopened = CheckpointStore::new(f.dir.join("checkpoints"));
    reopened.begin_turn("session", f.cwd(), "continue").unwrap();
    reopened
        .finish_turn("session", f.cwd(), "continue")
        .unwrap();
    let status = reopened.status("session", f.cwd()).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].relative, "a.txt");
    assert!(!status.files[0].undoable);
    let diff = reopened.file_diff("session", f.cwd(), "a.txt").unwrap();
    assert_eq!(diff.original, "original\n");
    assert_eq!(diff.current, "session edit\n");
}

#[test]
fn recovers_edits_when_an_older_version_replaced_an_unfinished_baseline() {
    for committed in [false, true] {
        let f = Fixture::new();
        f.store.begin_turn("session", f.cwd(), "first").unwrap();
        f.write("a.txt", "session edit\n");
        f.write("foreign.txt", "other session\n");
        // Simulate the old Continue path losing the active metadata, but
        // leaving its original Git-backed baseline reference intact.
        let mut review = read_review(&f.store.session_dir("session"))
            .unwrap()
            .unwrap();
        review.active = None;
        write_review(&f.store.session_dir("session"), &review).unwrap();
        if committed {
            run_git(&f.repo, &["add", "a.txt"]).unwrap();
            run_git(&f.repo, &["commit", "-m", "accept edit"]).unwrap();
        }
        f.store.begin_turn("session", f.cwd(), "continue").unwrap();
        f.store.finish_turn("session", f.cwd(), "continue").unwrap();
        assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());
        f.store
            .recover_orphaned_turn("session", f.cwd(), &["removed-fixture.txt".into()])
            .unwrap();
        assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());
        f.store
            .recover_orphaned_turn("session", f.cwd(), &["a.txt".into()])
            .unwrap();
        let reopened = CheckpointStore::new(f.dir.join("checkpoints"));
        let status = reopened.status("session", f.cwd()).unwrap();
        if committed {
            assert!(status.files.is_empty());
        } else {
            assert_eq!(status.files.len(), 1);
            assert_eq!(status.files[0].relative, "a.txt");
            assert!(!status.files[0].undoable);
            let diff = reopened.file_diff("session", f.cwd(), "a.txt").unwrap();
            assert_eq!(diff.original, "original\n");
            assert_eq!(diff.current, "session edit\n");
        }
    }
}

#[test]
fn overlapping_turns_keep_exact_diffs_but_cannot_restore_shared_work() {
    let f = Fixture::new();
    f.write("a.txt", "top\n\nbottom\n");
    f.store.begin_turn("a", f.cwd(), "first").unwrap();
    f.store.begin_turn("b", f.cwd(), "second").unwrap();
    f.write("a.txt", "top edited by a\n\nbottom edited by b\n");
    for id in ["a", "b"] {
        f.store.capture(id, f.cwd(), &["a.txt".into()]).unwrap();
    }
    f.store.finish_turn("a", f.cwd(), "first").unwrap();
    f.store.finish_turn("b", f.cwd(), "second").unwrap();
    for id in ["a", "b"] {
        let status = f.store.status(id, f.cwd()).unwrap();
        assert_eq!(
            (status.files[0].additions, status.files[0].deletions),
            (2, 2)
        );
        assert!(status.files[0].exact);
        assert!(!status.files[0].undoable);
        assert!(f.store.undo(id, f.cwd(), None).is_err());
        assert_eq!(
            f.store.file_diff(id, f.cwd(), "a.txt").unwrap().current,
            "top edited by a\n\nbottom edited by b\n"
        );
    }
}

#[test]
fn shared_turns_only_review_files_with_their_own_successful_edit_events() {
    let f = Fixture::new();
    f.store.begin_turn("reader", f.cwd(), "first").unwrap();
    f.store.begin_turn("writer", f.cwd(), "second").unwrap();
    f.write("a.txt", "edited by the writer\n");
    f.store
        .capture("writer", f.cwd(), &["a.txt".into()])
        .unwrap();
    // A prepared/failed edit is not evidence that the reader changed a file.
    f.store
        .prepare("reader", f.cwd(), &["a.txt".into()])
        .unwrap();
    // The reader's temporary test fixture is removed before it finishes.
    f.write("temporary.txt", "temporary test\n");
    f.store
        .capture("reader", f.cwd(), &["temporary.txt".into()])
        .unwrap();
    std::fs::remove_file(f.repo.join("temporary.txt")).unwrap();
    f.store.finish_turn("reader", f.cwd(), "first").unwrap();
    f.store.finish_turn("writer", f.cwd(), "second").unwrap();

    let reopened = CheckpointStore::new(f.dir.join("checkpoints"));
    assert!(reopened.status("reader", f.cwd()).unwrap().files.is_empty());
    let status = reopened.status("writer", f.cwd()).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].relative, "a.txt");
    assert!(!status.files[0].undoable);
    // The complete workspace recording is retained separately from attribution.
    assert_eq!(
        reopened
            .file_diff("reader", f.cwd(), "a.txt")
            .unwrap()
            .current,
        "edited by the writer\n"
    );
}

#[test]
fn shared_turns_with_different_edits_do_not_claim_each_others_files() {
    let f = Fixture::new();
    f.store.begin_turn("a", f.cwd(), "first").unwrap();
    f.store.begin_turn("b", f.cwd(), "second").unwrap();
    f.write("a.txt", "edited by a\n");
    // Windows strips trailing spaces from file names, so only the leading
    // space can be exercised there.
    let literal = if cfg!(windows) {
        " literal name .txt"
    } else {
        " literal name .txt "
    };
    f.write(literal, "edited by b\n");
    f.store.capture("a", f.cwd(), &["a.txt".into()]).unwrap();
    f.store
        .capture(
            "b",
            f.cwd(),
            &[f.repo.join(literal).to_string_lossy().into()],
        )
        .unwrap();
    f.store.finish_turn("a", f.cwd(), "first").unwrap();
    f.store.finish_turn("b", f.cwd(), "second").unwrap();
    for (id, relative) in [("a", "a.txt"), ("b", literal)] {
        let status = f.store.status(id, f.cwd()).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].relative, relative);
    }
}

#[test]
fn old_shared_recordings_without_edit_evidence_do_not_claim_workspace_changes() {
    let f = Fixture::new();
    f.store.begin_turn("reader", f.cwd(), "first").unwrap();
    f.store.begin_turn("writer", f.cwd(), "second").unwrap();
    f.write("a.txt", "foreign change\n");
    f.store.finish_turn("reader", f.cwd(), "first").unwrap();
    let path = f.dir.join("checkpoints/reader/turn-review.json");
    let mut review: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    review["latest"].as_object_mut().unwrap().remove("edited");
    std::fs::write(path, serde_json::to_vec(&review).unwrap()).unwrap();
    let reopened = CheckpointStore::new(f.dir.join("checkpoints"));
    assert!(reopened.status("reader", f.cwd()).unwrap().files.is_empty());
}

#[test]
fn nested_turns_share_work_but_sibling_path_prefixes_do_not() {
    let f = Fixture::new();
    f.write("nested/a.txt", "child baseline\n");
    f.write("nested-other/a.txt", "sibling baseline\n");
    let child = f.repo.join("nested");
    let sibling = f.repo.join("nested-other");
    let child_cwd = child.to_str().unwrap();
    let sibling_cwd = sibling.to_str().unwrap();

    f.store.begin_turn("child", child_cwd, "first").unwrap();
    f.store.begin_turn("sibling", sibling_cwd, "first").unwrap();
    f.write("nested/a.txt", "independent child change\n");
    f.store.finish_turn("child", child_cwd, "first").unwrap();
    let status = f.store.status("child", child_cwd).unwrap();
    assert_eq!(status.files.len(), 1);
    assert!(status.files[0].undoable);
    f.store
        .finish_turn("sibling", sibling_cwd, "first")
        .unwrap();

    f.store.begin_turn("parent", f.cwd(), "second").unwrap();
    f.store.begin_turn("child", child_cwd, "second").unwrap();
    f.write("nested/a.txt", "shared parent and child change\n");
    f.store
        .capture("parent", f.cwd(), &["nested/a.txt".into()])
        .unwrap();
    f.store
        .capture("child", child_cwd, &["a.txt".into()])
        .unwrap();
    f.store.finish_turn("parent", f.cwd(), "second").unwrap();
    f.store.finish_turn("child", child_cwd, "second").unwrap();
    for (id, cwd) in [("parent", f.cwd()), ("child", child_cwd)] {
        let status = f.store.status(id, cwd).unwrap();
        assert_eq!(status.files.len(), 1);
        assert!(status.files[0].exact);
        assert!(!status.files[0].undoable);
        assert!(f.store.undo(id, cwd, None).is_err());
    }
}

#[test]
fn undo_restores_only_recorded_files_and_keep_retains_history() {
    let f = Fixture::new();
    f.write("user.txt", "user baseline\n");
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "agent\n");
    f.write("user.txt", "user baseline\nagent addition\n");
    f.write("new.txt", "created\n");
    std::fs::remove_file(f.repo.join("delete.txt")).unwrap();
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    f.write("unrelated.txt", "later work\n");
    let index = std::fs::read(f.repo.join(".git/index")).unwrap();
    f.store.keep("session", f.cwd(), Some("a.txt")).unwrap();
    f.store.undo("session", f.cwd(), None).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
        "agent\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repo.join("user.txt")).unwrap(),
        "user baseline\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repo.join("delete.txt")).unwrap(),
        "remove me\n"
    );
    assert!(f.repo.join("unrelated.txt").exists());
    assert!(!f.repo.join("new.txt").exists());
    assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());
    assert_eq!(std::fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert!(f.dir.join("checkpoints/session/turns/first.json").exists());
    f.store.forget("session").unwrap();
    assert!(run_git(
        &f.repo,
        &["for-each-ref", "refs/monocode/checkpoints/session/"]
    )
    .unwrap()
    .is_empty());
}

#[test]
fn failures_and_incomplete_turns_never_fall_back_to_the_previous_result() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "first\n");
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    f.store.begin_turn("session", f.cwd(), "second").unwrap();
    assert!(f
        .store
        .status("session", f.cwd())
        .unwrap_err()
        .contains("without a final"));
    // Stale completion from a cancelled turn must not settle a newer turn.
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    assert!(f.store.status("session", f.cwd()).is_err());
    run_git(&f.repo, &["config", "core.sparseCheckout", "true"]).unwrap();
    assert!(f.store.finish_turn("session", f.cwd(), "second").is_err());
    assert!(f
        .store
        .status("session", f.cwd())
        .unwrap_err()
        .contains("sparse"));
    run_git(&f.repo, &["config", "core.sparseCheckout", "false"]).unwrap();
    f.store.begin_turn("session", f.cwd(), "third").unwrap();
    f.store.finish_turn("session", f.cwd(), "third").unwrap();
    assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());
}

#[test]
fn records_empty_binary_and_unusual_paths_without_the_old_file_limit() {
    let f = Fixture::new();
    f.write(".gitignore", "ignored/\n");
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("ignored/file.txt", "ignored\n");
    for index in 0..501 {
        f.write(&format!("new/{index}.txt"), "");
    }
    f.write("binary.bin", "\0binary");
    let path = if cfg!(windows) {
        "café name.txt"
    } else {
        "café\tname\n.txt"
    };
    f.write(path, "new\n");
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(status.files.len(), 503);
    assert!(status
        .files
        .iter()
        .any(|file| file.relative == path && file.additions == 1));
    assert!(
        f.store
            .file_diff("session", f.cwd(), "binary.bin")
            .unwrap()
            .binary
    );
    assert_eq!(
        f.store.file_diff("session", f.cwd(), path).unwrap().current,
        "new\n"
    );
}

#[test]
fn commits_during_the_turn_clear_review_but_preserve_the_recorded_diff() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "committed during the turn\n");
    run_git(&f.repo, &["add", "."]).unwrap();
    run_git(&f.repo, &["commit", "-m", "agent changes"]).unwrap();
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    assert!(run_git(&f.repo, &["status", "--porcelain"])
        .unwrap()
        .is_empty());
    assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());
    let diff = f.store.file_diff("session", f.cwd(), "a.txt").unwrap();
    assert_eq!(diff.original, "original\n");
    assert_eq!(diff.current, "committed during the turn\n");
}

#[test]
fn commits_after_the_turn_clear_modified_created_and_deleted_files() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "agent change\n");
    f.write("new.txt", "new file\n");
    std::fs::remove_file(f.repo.join("delete.txt")).unwrap();
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    assert_eq!(f.store.status("session", f.cwd()).unwrap().files.len(), 3);

    // The commit can include further edits made after the recorded turn.
    f.write("a.txt", "agent change\nuser addition\n");
    run_git(&f.repo, &["add", "-A"]).unwrap();
    run_git(&f.repo, &["commit", "-m", "accept changes"]).unwrap();
    assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());
    assert_eq!(
        f.store
            .file_diff("session", f.cwd(), "a.txt")
            .unwrap()
            .current,
        "agent change\n"
    );
    assert!(f.dir.join("checkpoints/session/turns/first.json").exists());
}

#[test]
fn unrelated_and_partial_commits_preserve_pending_files_and_exact_counts() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "agent change\n");
    f.write("new.txt", "new file\n");
    f.store.finish_turn("session", f.cwd(), "first").unwrap();

    f.write("unrelated.txt", "other work\n");
    run_git(&f.repo, &["add", "unrelated.txt"]).unwrap();
    run_git(&f.repo, &["commit", "-m", "unrelated work"]).unwrap();
    assert_eq!(f.store.status("session", f.cwd()).unwrap().files.len(), 2);

    run_git(&f.repo, &["add", "a.txt"]).unwrap();
    run_git(&f.repo, &["commit", "-m", "accept one file"]).unwrap();
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].relative, "new.txt");
    assert_eq!(
        (status.files[0].additions, status.files[0].deletions),
        (1, 0)
    );
    assert!(status.files[0].exact);
    assert!(!status.files[0].undoable);
}

#[test]
fn committing_only_part_of_a_files_changes_keeps_it_pending() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "first change\nsecond change\n");
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "first change\n");
    run_git(&f.repo, &["add", "a.txt"]).unwrap();
    run_git(&f.repo, &["commit", "-m", "accept part of the file"]).unwrap();
    f.write("a.txt", "first change\nsecond change\n");
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].relative, "a.txt");
    assert_eq!(
        (status.files[0].additions, status.files[0].deletions),
        (2, 1)
    );
}

#[test]
fn committed_results_do_not_reappear_after_later_edits_or_restarts() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write("a.txt", "agent change\n");
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    run_git(&f.repo, &["add", "a.txt"]).unwrap();
    run_git(&f.repo, &["commit", "-m", "accept changes"]).unwrap();
    // A later edit must not keep the already committed turn's card alive.
    f.write("a.txt", "later editor change\n");
    assert!(f.store.status("session", f.cwd()).unwrap().files.is_empty());

    run_git(&f.repo, &["add", "a.txt"]).unwrap();
    run_git(&f.repo, &["commit", "-m", "later work"]).unwrap();
    f.write("a.txt", "another editor change\n");
    let reopened = CheckpointStore::new(f.dir.join("checkpoints"));
    assert!(reopened
        .status("session", f.cwd())
        .unwrap()
        .files
        .is_empty());
    assert_eq!(
        reopened
            .file_diff("session", f.cwd(), "a.txt")
            .unwrap()
            .current,
        "agent change\n"
    );
}

#[test]
fn commits_clear_review_in_nested_workspaces_and_repositories_without_head() {
    let f = Fixture::new();
    let nested = f.repo.join("nested");
    let unborn = f.dir.join("unborn");
    std::fs::create_dir(&nested).unwrap();
    std::fs::create_dir(&unborn).unwrap();
    run_git(&unborn, &["init"]).unwrap();
    run_git(&unborn, &["config", "user.name", "Test"]).unwrap();
    run_git(&unborn, &["config", "user.email", "test@example.invalid"]).unwrap();

    for (session, root) in [("nested", nested), ("unborn", unborn)] {
        let cwd = root.to_str().unwrap();
        let pending = "café pending.txt";
        f.store.begin_turn(session, cwd, "first").unwrap();
        std::fs::write(root.join("committed.txt"), "accepted\n").unwrap();
        std::fs::write(root.join(pending), "pending\n").unwrap();
        f.store.finish_turn(session, cwd, "first").unwrap();
        run_git(&root, &["add", "committed.txt"]).unwrap();
        run_git(&root, &["commit", "-m", "accept one file"]).unwrap();
        let status = f.store.status(session, cwd).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].relative, pending);
        run_git(&root, &["add", pending]).unwrap();
        run_git(&root, &["commit", "-m", "accept remaining work"]).unwrap();
        assert!(f.store.status(session, cwd).unwrap().files.is_empty());
    }
}

#[test]
fn linked_worktrees_have_independent_recordings_and_indexes() {
    let f = Fixture::new();
    let linked = f.dir.join("linked");
    run_git(
        &f.repo,
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    )
    .unwrap();
    let cwd = linked.to_str().unwrap();
    let git_dir = run_git(&linked, &["rev-parse", "--absolute-git-dir"]).unwrap();
    let index_path = PathBuf::from(String::from_utf8(git_dir).unwrap().trim()).join("index");
    let index = std::fs::read(&index_path).unwrap();
    f.store.begin_turn("main", f.cwd(), "first").unwrap();
    f.store.begin_turn("linked", cwd, "second").unwrap();
    f.write("a.txt", "main change\n");
    std::fs::write(linked.join("delete.txt"), "linked change\n").unwrap();
    f.store.finish_turn("main", f.cwd(), "first").unwrap();
    f.store.finish_turn("linked", cwd, "second").unwrap();
    assert_eq!(
        f.store.status("main", f.cwd()).unwrap().files[0].relative,
        "a.txt"
    );
    let status = f.store.status("linked", cwd).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].relative, "delete.txt");
    assert!(status.files[0].undoable);
    assert_eq!(std::fs::read(&index_path).unwrap(), index);
    f.store.undo("linked", cwd, None).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
        "main change\n"
    );
}

#[cfg(unix)]
#[test]
fn preserves_literal_paths_and_records_modes_and_symlinks_safely() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let f = Fixture::new();
    run_git(&f.repo, &["config", "core.fileMode", "true"]).unwrap();
    let path = " literal => name .txt ";
    f.write(path, "baseline\n");
    f.store.begin_turn("session", f.cwd(), "first").unwrap();
    f.write(path, "changed\n");
    std::fs::set_permissions(f.repo.join("a.txt"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::rename(f.repo.join("delete.txt"), f.repo.join("renamed.txt")).unwrap();
    symlink("a.txt", f.repo.join("link.txt")).unwrap();
    f.store.finish_turn("session", f.cwd(), "first").unwrap();
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(status.files.len(), 5);
    let link = status
        .files
        .iter()
        .find(|file| file.relative == "link.txt")
        .unwrap();
    assert!(link.exact);
    assert!(!link.undoable);
    let diff = f.store.file_diff("session", f.cwd(), path).unwrap();
    assert_eq!(diff.original, "baseline\n");
    assert_eq!(diff.current, "changed\n");
    f.store.undo("session", f.cwd(), Some(path)).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join(path)).unwrap(),
        "baseline\n"
    );
    f.store.undo("session", f.cwd(), Some("a.txt")).unwrap();
    assert_eq!(file_mode(&f.repo.join("a.txt")).unwrap() & 0o111, 0);
    for path in ["../a.txt", "/a.txt", "a/../a.txt", "./a.txt", ".git/config"] {
        assert!(f.store.file_diff("session", f.cwd(), path).is_err());
    }
}

#[test]
fn checkpoints_scope_nested_workspaces_and_repositories_without_head() {
    let f = Fixture::new();
    f.write("nested/a.txt", "nested\n");
    let cwd = f.repo.join("nested");
    let cwd = cwd.to_str().unwrap();
    f.store.begin_turn("nested", cwd, "first").unwrap();
    f.write("nested/a.txt", "nested\nchanged\n");
    f.write("a.txt", "outside scope\n");
    f.store.finish_turn("nested", cwd, "first").unwrap();
    let status = f.store.status("nested", cwd).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].relative, "a.txt");
    assert_eq!(
        f.store.file_diff("nested", cwd, "a.txt").unwrap().current,
        "nested\nchanged\n"
    );
    f.store.undo("nested", cwd, None).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
        "outside scope\n"
    );

    let unborn = f.dir.join("unborn");
    std::fs::create_dir(&unborn).unwrap();
    run_git(&unborn, &["init"]).unwrap();
    let cwd = unborn.to_str().unwrap();
    f.store.begin_turn("unborn", cwd, "first").unwrap();
    std::fs::write(unborn.join("new.txt"), "new\n").unwrap();
    f.store.finish_turn("unborn", cwd, "first").unwrap();
    assert_eq!(f.store.status("unborn", cwd).unwrap().files[0].additions, 1);
    f.store.undo("unborn", cwd, None).unwrap();
    assert!(!unborn.join("new.txt").exists());
}

/// Mac finding 11.16: a home folder that is a git repository.
mod home_repository {
    use super::*;

    struct Home {
        dir: PathBuf,
        store: CheckpointStore,
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn init(repo: &Path) {
        std::fs::create_dir_all(repo).unwrap();
        run_git(repo, &["init"]).unwrap();
        run_git(repo, &["config", "user.name", "Test"]).unwrap();
        run_git(repo, &["config", "user.email", "test@example.invalid"]).unwrap();
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("monocode-home-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn monocode_refs(repo: &Path) -> String {
        String::from_utf8(
            run_git(
                repo,
                &["for-each-ref", "--format=%(refname)", "refs/monocode"],
            )
            .unwrap(),
        )
        .unwrap()
    }

    fn object_count(repo: &Path) -> usize {
        fn walk(dir: &Path) -> usize {
            std::fs::read_dir(dir)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| {
                            let path = entry.path();
                            if path.is_dir() {
                                walk(&path)
                            } else {
                                1
                            }
                        })
                        .sum()
                })
                .unwrap_or(0)
        }
        walk(&repo.join(".git/objects"))
    }

    fn assert_skipped(store: &CheckpointStore, repo: &Path, cwd: &Path) {
        let objects = object_count(repo);
        let skip = store
            .begin_turn_or_skip("session", cwd.to_str().unwrap(), "first", None)
            .unwrap()
            .expect("the checkpoint is skipped");
        assert_eq!(skip.reason, "homeRepository");
        assert_eq!(
            skip.repository,
            path_to_js(&std::fs::canonicalize(repo).unwrap())
        );
        store
            .finish_turn("session", cwd.to_str().unwrap(), "first")
            .unwrap();
        let cwd = cwd.to_str().unwrap();
        assert!(store.status("session", cwd).unwrap().files.is_empty());
        store.ensure("session", cwd).unwrap();
        store.capture("session", cwd, &["x.txt".into()]).unwrap();
        assert!(store
            .undo("session", cwd, None)
            .unwrap_err()
            .contains("covers your home folder"));
        assert!(store
            .restore_preview("session", cwd, "first")
            .unwrap_err()
            .contains("covers your home folder"));
        assert_eq!(monocode_refs(repo), "");
        assert_eq!(object_count(repo), objects, "no object was written");
        assert!(!store.session_dir("session").exists());
    }

    #[test]
    fn a_project_inside_a_home_folder_repository_is_skipped() {
        let dir = scratch();
        let home = dir.join("tonyg");
        init(&home);
        let project = home.join("code project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("big.bin"), vec![7u8; 4096]).unwrap();
        let fixture = Home {
            store: CheckpointStore::with_home(dir.join("checkpoints"), Some(home.clone())),
            dir,
        };
        assert_skipped(&fixture.store, &home, &project);
        // The home folder itself as the chat folder: a Mono conversation.
        assert_skipped(&fixture.store, &home, &home);
    }

    #[test]
    fn a_repository_above_the_home_folder_is_skipped() {
        let dir = scratch();
        let top = dir.join("Users");
        init(&top);
        let home = top.join("tonyg");
        std::fs::create_dir_all(&home).unwrap();
        let fixture = Home {
            store: CheckpointStore::with_home(dir.join("checkpoints"), Some(home.clone())),
            dir,
        };
        assert_skipped(&fixture.store, &top, &home);
    }

    #[cfg(unix)]
    #[test]
    fn a_home_folder_reached_through_a_symbolic_link_is_still_skipped() {
        let dir = scratch();
        let real = dir.join("real-home");
        init(&real);
        let link = dir.join("home-link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let fixture = Home {
            store: CheckpointStore::with_home(dir.join("checkpoints"), Some(link.clone())),
            dir,
        };
        assert_skipped(&fixture.store, &real, &real);
        assert_skipped(&fixture.store, &real, &link);
    }

    #[test]
    fn a_repository_inside_the_home_folder_still_records_turns() {
        let dir = scratch();
        let home = dir.join("tonyg");
        init(&home);
        let repo = home.join("monocode");
        init(&repo);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["commit", "-m", "initial"]).unwrap();
        let fixture = Home {
            store: CheckpointStore::with_home(dir.join("checkpoints"), Some(home.clone())),
            dir,
        };
        let cwd = repo.to_str().unwrap();
        assert_eq!(
            fixture
                .store
                .begin_turn_or_skip("session", cwd, "first", None)
                .unwrap(),
            None
        );
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        fixture.store.finish_turn("session", cwd, "first").unwrap();
        let status = fixture.store.status("session", cwd).unwrap();
        assert_eq!(status.files.len(), 1);
        assert!(monocode_refs(&repo).contains("refs/monocode/checkpoints/session/first"));
        assert_eq!(monocode_refs(&home), "");
    }

    #[test]
    fn a_folder_that_is_not_a_repository_is_not_reported_as_skipped() {
        let dir = scratch();
        let home = dir.join("tonyg");
        let plain = home.join("notes");
        std::fs::create_dir_all(&plain).unwrap();
        let fixture = Home {
            store: CheckpointStore::with_home(dir.join("checkpoints"), Some(home.clone())),
            dir,
        };
        assert!(fixture.store.home_skip(plain.to_str().unwrap()).is_none());
        assert_eq!(
            fixture
                .store
                .begin_turn_or_skip("session", plain.to_str().unwrap(), "first", None)
                .unwrap(),
            None
        );
    }

    // Security fix F7: a top folder that cannot be resolved inside a
    // repository is a skip, not a checkpoint.
    #[test]
    fn a_folder_whose_repository_top_cannot_be_resolved_is_skipped() {
        let dir = scratch();
        let home = dir.join("tonyg");
        init(&home);
        let project = home.join("broken checkout");
        std::fs::create_dir_all(&project).unwrap();
        // A `.git` file pointing nowhere: git fails with "not a git
        // repository: /nowhere", not the "parent directories" wording.
        std::fs::write(project.join(".git"), "gitdir: /nonexistent-monocode-test\n").unwrap();
        std::fs::write(project.join("a.txt"), "one\n").unwrap();
        let fixture = Home {
            store: CheckpointStore::with_home(dir.join("checkpoints"), Some(home.clone())),
            dir,
        };
        let cwd = project.to_str().unwrap();
        let objects = object_count(&home);
        let skip = fixture
            .store
            .begin_turn_or_skip("session", cwd, "first", Some(&["a.txt".into()]))
            .unwrap()
            .expect("the checkpoint is skipped");
        assert_eq!(skip.reason, "unresolvedRepository");
        assert_eq!(
            skip.repository,
            path_to_js(&std::fs::canonicalize(&project).unwrap())
        );
        fixture.store.begin_turn("session", cwd, "first").unwrap();
        fixture.store.finish_turn("session", cwd, "first").unwrap();
        fixture.store.ensure("session", cwd).unwrap();
        assert!(fixture
            .store
            .undo("session", cwd, None)
            .unwrap_err()
            .contains("could not be found"));
        assert!(!fixture.store.session_dir("session").exists());
        assert_eq!(monocode_refs(&home), "");
        assert_eq!(object_count(&home), objects, "no object was written");
    }

    #[test]
    fn a_missing_folder_is_skipped_without_running_git() {
        let dir = scratch();
        let home = dir.join("tonyg");
        let fixture = Home {
            store: CheckpointStore::with_home(dir.join("checkpoints"), Some(home.clone())),
            dir: dir.clone(),
        };
        let gone = dir.join("gone");
        let skip = fixture
            .store
            .begin_turn_or_skip("session", gone.to_str().unwrap(), "first", None)
            .unwrap()
            .expect("the checkpoint is skipped");
        assert_eq!(skip.reason, "unresolvedRepository");
        assert!(!fixture.store.session_dir("session").exists());
    }

    #[test]
    fn the_top_is_looked_up_once_and_read_by_kind() {
        let dir = scratch();
        let plain = dir.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(matches!(show_toplevel(&plain), TopLookup::NotRepository(_)));
        let repo = dir.join("repo with space");
        init(&repo);
        match show_toplevel(&repo) {
            TopLookup::Top(text) => assert_eq!(
                std::fs::canonicalize(text).unwrap(),
                std::fs::canonicalize(&repo).unwrap()
            ),
            _ => panic!("a repository has a top"),
        }
        let broken = dir.join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join(".git"), "gitdir: /nonexistent-monocode-test\n").unwrap();
        assert!(matches!(show_toplevel(&broken), TopLookup::Failed));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_system_root_always_counts_as_covering_home() {
        assert!(covers_home(Path::new("/"), None));
        assert!(covers_home(Path::new("/"), Some(Path::new("/Users/tonyg"))));
        assert!(!covers_home(
            Path::new("/Users/tonyg/code"),
            Some(Path::new("/Users/tonyg"))
        ));
        assert!(covers_home(
            Path::new("/Users/tonyg"),
            Some(Path::new("/Users/tonyg"))
        ));
        // A sibling whose name starts the same is not a parent.
        assert!(!covers_home(
            Path::new("/Users/tony"),
            Some(Path::new("/Users/tonyg"))
        ));
    }
}

// Security fix R6: the checkpoint's git calls read git's messages in English
// and stay in the repository the turn started in.
#[test]
fn checkpoint_git_reads_messages_in_english_and_pins_the_repository() {
    let f = Fixture::new();
    let env = |command: &Command, name: &str| {
        command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new(name))
            .map(|(_, value)| value.map(|v| v.to_os_string()))
    };
    let plain = git_command(&f.repo, &["status"]);
    assert_eq!(env(&plain, "LC_ALL"), Some(Some("C".into())));
    assert_eq!(env(&plain, "LANGUAGE"), Some(Some("".into())));
    assert_eq!(env(&plain, "GIT_CEILING_DIRECTORIES"), Some(None));
    let pin = PinnedRepo::find(&f.repo).unwrap();
    let pinned = git_command_in(&f.repo, Some(&pin), &["status"]);
    assert_eq!(env(&pinned, "LC_ALL"), Some(Some("C".into())));
    assert_eq!(
        env(&pinned, "GIT_WORK_TREE"),
        Some(Some(f.repo.as_os_str().to_os_string()))
    );
    assert_eq!(
        env(&pinned, "GIT_CEILING_DIRECTORIES"),
        Some(Some(f.dir.as_os_str().to_os_string()))
    );
    let git_dir = env(&pinned, "GIT_DIR").unwrap().unwrap();
    assert!(Path::new(&git_dir).ends_with(".git"), "{git_dir:?}");
}

#[test]
fn a_pinned_lookup_never_climbs_above_the_top() {
    let f = Fixture::new();
    // A folder inside the repository that is not its top: with the search
    // held to the folder itself, the repository above is not found.
    let inner = f.repo.join("inner");
    std::fs::create_dir_all(&inner).unwrap();
    assert!(PinnedRepo::find(&inner).is_err());
    assert!(PinnedRepo::find(&f.repo).is_ok());
}

#[test]
fn a_repository_made_inside_the_folder_mid_turn_is_not_used() {
    let f = Fixture::new();
    let sub = f.repo.join("sub dir");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("b.txt"), "one\n").unwrap();
    let cwd = sub.to_str().unwrap();
    f.store.begin_turn("session", cwd, "first").unwrap();
    // The agent makes a repository in the chat's folder during the turn.
    for args in [
        &["init", "-q"][..],
        &["add", "b.txt"][..],
        &[
            "-c",
            "user.name=a",
            "-c",
            "user.email=a@a",
            "commit",
            "-qm",
            "x",
        ][..],
    ] {
        let status = Command::new("git")
            .args(args)
            .current_dir(&sub)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }
    f.store.finish_turn("session", cwd, "first").unwrap();
    let after = turn_ref("session", "first", "after");
    assert!(
        run_git(&f.repo, &["rev-parse", "--verify", &after]).is_ok(),
        "the turn's result belongs in the repository it started in"
    );
    let nested = Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", &after])
        .current_dir(&sub)
        .output()
        .unwrap();
    assert!(
        !nested.status.success(),
        "nothing was written to the new repository"
    );
}

// Mac retest 7.3: a test run wrote `__pycache__/*.pyc` beside the code and
// the turn header said "Changed 3 files" for one edit.
#[test]
fn review_leaves_out_python_caches_and_ignored_files_but_undo_restores_them() {
    let f = Fixture::new();
    f.write(".gitignore", "build/\n");
    f.write("build/kept.txt", "old build\n");
    run_git(&f.repo, &["add", ".gitignore"]).unwrap();
    // A tracked file that the ignore rules also match.
    run_git(&f.repo, &["add", "-f", "build/kept.txt"]).unwrap();
    run_git(&f.repo, &["commit", "-m", "ignore"]).unwrap();
    f.store.begin_turn("session", f.cwd(), "pytest").unwrap();
    f.write("a.txt", "original\nagent change\n");
    f.write("__pycache__/a.cpython-312.pyc", "bytecode");
    f.write(
        "tests/__pycache__/test_a.cpython-312-pytest-8.pyc",
        "bytecode",
    );
    f.write("legacy.pyo", "bytecode");
    f.write("-dash/__PYCACHE__/x.py", "upper case folder\n");
    f.write("build/kept.txt", "new build\n");
    // A name git could read as an option, and one with a space: shown.
    f.write("--version", "not an option\n");
    f.write("my notes.txt", "kept in review\n");
    f.store.finish_turn("session", f.cwd(), "pytest").unwrap();
    let status = f.store.status("session", f.cwd()).unwrap();
    let shown: Vec<_> = status
        .files
        .iter()
        .map(|file| file.relative.as_str())
        .collect();
    assert_eq!(shown, vec!["--version", "a.txt", "my notes.txt"]);
    assert!(status.files.iter().all(|file| file.undoable));

    // The checkpoint itself still has every file.
    let all = f
        .store
        .turn_status_all("session", f.cwd())
        .unwrap()
        .unwrap();
    let mut recorded: Vec<_> = all
        .files
        .iter()
        .map(|file| file.relative.as_str())
        .collect();
    recorded.sort();
    assert_eq!(
        recorded,
        vec![
            "--version",
            "-dash/__PYCACHE__/x.py",
            "__pycache__/a.cpython-312.pyc",
            "a.txt",
            "build/kept.txt",
            "legacy.pyo",
            "my notes.txt",
            "tests/__pycache__/test_a.cpython-312-pytest-8.pyc",
        ]
    );

    // Undo all puts back the hidden files too.
    let after = f.store.undo("session", f.cwd(), None).unwrap();
    assert!(after.files.is_empty());
    assert_eq!(
        std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
        "original\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repo.join("build/kept.txt")).unwrap(),
        "old build\n"
    );
    assert!(!f.repo.join("__pycache__/a.cpython-312.pyc").exists());
    assert!(!f.repo.join("legacy.pyo").exists());
}

#[test]
fn a_hidden_file_rewritten_after_the_turn_does_not_block_undo_all() {
    let f = Fixture::new();
    f.store.begin_turn("session", f.cwd(), "pytest").unwrap();
    f.write("a.txt", "original\nagent change\n");
    f.write("__pycache__/a.cpython-312.pyc", "bytecode one");
    f.store.finish_turn("session", f.cwd(), "pytest").unwrap();
    // A later test run rewrites the cache.
    f.write("__pycache__/a.cpython-312.pyc", "bytecode two");
    let status = f.store.status("session", f.cwd()).unwrap();
    assert_eq!(status.files.len(), 1);
    assert!(status.files[0].undoable);
    f.store.undo("session", f.cwd(), None).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
        "original\n"
    );
    // The cache it could not safely put back is left as it is.
    assert_eq!(
        std::fs::read_to_string(f.repo.join("__pycache__/a.cpython-312.pyc")).unwrap(),
        "bytecode two"
    );
}

#[test]
fn python_cache_paths_are_recognised() {
    assert!(is_python_cache("__pycache__/a.pyc"));
    assert!(is_python_cache("pkg/__pycache__/mod.cpython-312.pyc"));
    assert!(is_python_cache("pkg/__pycache__/notes.txt"));
    assert!(is_python_cache("old.PYC"));
    assert!(is_python_cache("x/y.pyo"));
    assert!(!is_python_cache("pycache.py"));
    assert!(!is_python_cache("my__pycache__/a.py"));
    assert!(!is_python_cache("a.pyx"));
    assert!(!is_python_cache("src/main.py"));
}

/// Mac retest 7.3 (15 Oct): after `python3 -m pytest`, Undo all removed the
/// edit and both `.pyc` files but left an empty `__pycache__` folder.
mod emptied_folders {
    use super::*;

    fn exists(f: &Fixture, path: &str) -> bool {
        f.repo.join(path).exists()
    }

    fn head(f: &Fixture) -> String {
        String::from_utf8(run_git(&f.repo, &["rev-parse", "HEAD"]).unwrap())
            .unwrap()
            .trim()
            .to_string()
    }

    /// A finished turn record whose baseline is HEAD.
    fn recorded(before: &str, started_ms: u64) -> RecordedTurn {
        RecordedTurn {
            id: "t".into(),
            before: Some(before.into()),
            after: Some(before.into()),
            head: None,
            shared: false,
            error: None,
            dismissed: BTreeSet::new(),
            edited: BTreeSet::new(),
            started_ms: Some(started_ms),
        }
    }

    /// File times come from the kernel's coarse clock, which can trail the
    /// clock a start is read from by a few milliseconds. A pause after the
    /// start keeps what the test makes next later than it.
    fn pause() {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    /// The time now, then a pause, so folders made next are later by the clock.
    fn start() -> u64 {
        let started = epoch_ms(std::time::SystemTime::now()).unwrap();
        pause();
        started
    }

    fn begin(f: &Fixture, session: &str, cwd: &str, id: &str) {
        f.store.begin_turn(session, cwd, id).unwrap();
        pause();
    }

    #[test]
    fn undo_all_removes_folders_the_turn_made_and_left_empty() {
        let f = Fixture::new();
        begin(&f, "session", f.cwd(), "pytest");
        f.write("a.txt", "original\nagent change\n");
        f.write("__pycache__/a.cpython-312.pyc", "bytecode");
        // Nested: `tests` and its cache are both new.
        f.write(
            "tests/__pycache__/test_a.cpython-312-pytest-8.pyc",
            "bytecode",
        );
        f.write("tests/test_a.py", "def test_a():\n    pass\n");
        // pytest's own cache ignores itself, so the checkpoint never has it.
        f.write(
            ".pytest_cache/.gitignore",
            "# Created by pytest automatically.\n*\n",
        );
        f.write(".pytest_cache/v/cache/nodeids", "[]\n");
        f.store.finish_turn("session", f.cwd(), "pytest").unwrap();

        let after = f.store.undo("session", f.cwd(), None).unwrap();
        assert!(after.files.is_empty());
        assert_eq!(
            std::fs::read_to_string(f.repo.join("a.txt")).unwrap(),
            "original\n"
        );
        assert!(!exists(&f, "__pycache__"));
        assert!(!exists(&f, "tests/__pycache__"));
        assert!(!exists(&f, "tests"));
        // Ignored files are not the checkpoint's: left as they are.
        assert!(exists(&f, ".pytest_cache/.gitignore"));
        assert!(exists(&f, ".pytest_cache/v/cache/nodeids"));
        assert!(f.repo.is_dir());
    }

    #[test]
    fn a_folder_that_existed_before_the_turn_stays_even_when_empty() {
        let f = Fixture::new();
        std::fs::create_dir(f.repo.join("logs")).unwrap();
        std::fs::create_dir_all(f.repo.join("out/empty")).unwrap();
        pause();
        begin(&f, "session", f.cwd(), "first");
        f.write("logs/run.txt", "log\n");
        f.write("out/empty/new/x.txt", "x\n");
        f.store.finish_turn("session", f.cwd(), "first").unwrap();
        f.store.undo("session", f.cwd(), None).unwrap();
        assert!(!exists(&f, "logs/run.txt"));
        assert!(f.repo.join("logs").is_dir());
        // The new folder inside goes; the empty ones that were there stay.
        assert!(!exists(&f, "out/empty/new"));
        assert!(f.repo.join("out/empty").is_dir());
    }

    #[test]
    fn a_folder_that_held_files_before_the_turn_stays_when_the_turn_made_it_again() {
        let f = Fixture::new();
        f.write("docs/readme.md", "read me\n");
        run_git(&f.repo, &["add", "docs/readme.md"]).unwrap();
        run_git(&f.repo, &["commit", "-m", "docs"]).unwrap();
        begin(&f, "session", f.cwd(), "first");
        // The folder is deleted and made again: new by the clock, but the
        // snapshot shows it held a file before the turn.
        std::fs::remove_dir_all(f.repo.join("docs")).unwrap();
        f.write("docs/new.md", "new\n");
        f.store.finish_turn("session", f.cwd(), "first").unwrap();
        f.store
            .undo("session", f.cwd(), Some("docs/new.md"))
            .unwrap();
        assert!(!exists(&f, "docs/new.md"));
        assert!(!exists(&f, "docs/readme.md"));
        assert!(f.repo.join("docs").is_dir());
    }

    #[test]
    fn a_new_folder_that_still_holds_a_file_stays() {
        let f = Fixture::new();
        f.write(".gitignore", "*.log\n");
        run_git(&f.repo, &["add", ".gitignore"]).unwrap();
        run_git(&f.repo, &["commit", "-m", "ignore logs"]).unwrap();
        begin(&f, "session", f.cwd(), "first");
        f.write("gen/a.txt", "a\n");
        f.write("gen/sub/b.txt", "b\n");
        // Ignored, so not in the checkpoint and not removed.
        f.write("gen/debug.log", "kept\n");
        f.store.finish_turn("session", f.cwd(), "first").unwrap();
        f.store.undo("session", f.cwd(), None).unwrap();
        assert!(!exists(&f, "gen/a.txt"));
        assert!(!exists(&f, "gen/sub"));
        assert!(exists(&f, "gen/debug.log"));
        assert!(f.repo.join("gen").is_dir());
    }

    #[test]
    fn a_turn_recorded_without_a_start_removes_no_folder() {
        let f = Fixture::new();
        begin(&f, "session", f.cwd(), "first");
        f.write("made/x.txt", "x\n");
        f.store.finish_turn("session", f.cwd(), "first").unwrap();
        // A review saved before turns kept their start.
        let path = f.dir.join("checkpoints/session/turn-review.json");
        let mut review: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let latest = review["latest"].as_object_mut().unwrap();
        assert!(latest.remove("startedMs").is_some());
        std::fs::write(&path, serde_json::to_vec(&review).unwrap()).unwrap();
        f.store.undo("session", f.cwd(), None).unwrap();
        assert!(!exists(&f, "made/x.txt"));
        assert!(f.repo.join("made").is_dir());
    }

    #[test]
    fn a_chat_in_a_subfolder_never_touches_folders_outside_it() {
        let f = Fixture::new();
        f.write("nested/keep.txt", "kept\n");
        let cwd = f.repo.join("nested");
        let cwd = cwd.to_str().unwrap();
        begin(&f, "nested", cwd, "first");
        f.write("nested/new/deeper/x.txt", "x\n");
        // Outside the chat's folder: not in its checkpoint.
        f.write("beside/y.txt", "y\n");
        f.store.finish_turn("nested", cwd, "first").unwrap();
        f.store.undo("nested", cwd, None).unwrap();
        assert!(!exists(&f, "nested/new"));
        assert!(exists(&f, "nested/keep.txt"));
        assert!(exists(&f, "beside/y.txt"));
    }

    #[test]
    fn never_the_checkpoint_folder_itself_or_anything_above_it() {
        let f = Fixture::new();
        let before = head(&f);
        let started = start();
        // All new and empty: only the folder inside the root may go.
        let root = f.repo.join("app");
        std::fs::create_dir_all(root.join("deep")).unwrap();
        std::fs::create_dir(f.repo.join("sibling")).unwrap();
        remove_emptied_folders(
            &root,
            &recorded(&before, started),
            &[
                "x.txt".into(),
                "deep/x.txt".into(),
                "../sibling/x.txt".into(),
                "/abs/x.txt".into(),
                ".git/x.txt".into(),
            ],
        );
        assert!(!root.join("deep").exists());
        assert!(root.is_dir());
        assert!(f.repo.join("sibling").is_dir());
        assert!(f.repo.join(".git").is_dir());
        // A folder that is not empty stays, and so do the ones above it.
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/late.txt"), "late\n").unwrap();
        remove_emptied_folders(&root, &recorded(&before, started), &["a/b/x.txt".into()]);
        assert!(root.join("a/b/late.txt").exists());
    }

    #[test]
    fn a_folder_made_before_the_turn_began_stays() {
        let f = Fixture::new();
        let before = head(&f);
        std::fs::create_dir(f.repo.join("old")).unwrap();
        pause();
        let started = start();
        remove_emptied_folders(&f.repo, &recorded(&before, started), &["old/x.txt".into()]);
        assert!(f.repo.join("old").is_dir());
        // The same folder counted against an earlier start is new, and goes.
        remove_emptied_folders(
            &f.repo,
            &recorded(&before, started - 60_000),
            &["old/x.txt".into()],
        );
        assert!(!f.repo.join("old").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_folder_is_never_followed() {
        let f = Fixture::new();
        let before = head(&f);
        let outside = f.dir.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let started = start();
        // New and empty, but reached only through a link.
        std::fs::create_dir(outside.join("inner")).unwrap();
        std::fs::create_dir(outside.join("empty")).unwrap();
        std::fs::create_dir(f.repo.join("made")).unwrap();
        std::os::unix::fs::symlink(&outside, f.repo.join("made/link")).unwrap();
        std::os::unix::fs::symlink(outside.join("empty"), f.repo.join("to-empty")).unwrap();
        remove_emptied_folders(
            &f.repo,
            &recorded(&before, started),
            &[
                "made/link/inner/gone.txt".into(),
                "made/link/gone.txt".into(),
                "to-empty/gone.txt".into(),
            ],
        );
        assert!(outside.join("inner").is_dir());
        assert!(outside.join("empty").is_dir());
        assert!(std::fs::symlink_metadata(f.repo.join("made/link"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(std::fs::symlink_metadata(f.repo.join("to-empty"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(f.repo.join("made").is_dir());
    }
}
