use super::*;

struct Fixture {
    dir: PathBuf,
    repo: PathBuf,
    store: CheckpointStore,
}

impl Fixture {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("monocode-rewind-test-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]).unwrap();
        run_git(&repo, &["config", "user.name", "Test"]).unwrap();
        run_git(&repo, &["config", "user.email", "test@example.invalid"]).unwrap();
        run_git(&repo, &["config", "core.autocrlf", "false"]).unwrap();
        std::fs::write(repo.join("a.txt"), "original\n").unwrap();
        std::fs::write(repo.join("keep.txt"), "kept\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "ignored.log\n").unwrap();
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
    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.repo.join(path)).ok()
    }
    fn turn(&self, session: &str, id: &str, work: impl FnOnce(&Self)) {
        self.store.begin_turn(session, self.cwd(), id).unwrap();
        work(self);
        self.store.finish_turn(session, self.cwd(), id).unwrap();
    }
    fn refs(&self) -> usize {
        String::from_utf8(run_git(&self.repo, &["for-each-ref", "refs/monocode/"]).unwrap())
            .unwrap()
            .lines()
            .count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Three turns: edit, then add a file and a subfolder, then delete one.
fn three_turns(f: &Fixture) {
    f.turn("s", "t1", |f| f.write("a.txt", "turn one\n"));
    f.turn("s", "t2", |f| {
        f.write("a.txt", "turn two\n");
        f.write("new/added.txt", "added\n");
    });
    f.turn("s", "t3", |f| {
        std::fs::remove_file(f.repo.join("keep.txt")).unwrap();
    });
}

#[test]
fn restores_every_file_to_before_an_earlier_turn() {
    let f = Fixture::new();
    three_turns(&f);
    f.write("ignored.log", "local log\n");
    let index = std::fs::read(f.repo.join(".git/index")).unwrap();
    let head = run_git(&f.repo, &["rev-parse", "HEAD"]).unwrap();

    let result = f.store.restore_to_turn("s", f.cwd(), "t2").unwrap();
    let mut restored = result.restored.clone();
    restored.sort();
    assert_eq!(restored, ["a.txt", "keep.txt", "new/added.txt"]);
    assert!(result.skipped.is_empty());
    assert_eq!(f.read("a.txt").as_deref(), Some("turn one\n"));
    assert_eq!(f.read("keep.txt").as_deref(), Some("kept\n"));
    assert_eq!(f.read("new/added.txt"), None);
    // Gitignored files are never captured, so never touched.
    assert_eq!(f.read("ignored.log").as_deref(), Some("local log\n"));
    // The index and HEAD stay as they were.
    assert_eq!(std::fs::read(f.repo.join(".git/index")).unwrap(), index);
    assert_eq!(run_git(&f.repo, &["rev-parse", "HEAD"]).unwrap(), head);
    // The backup holds the folder as it was, for an undo by hand.
    let backed_up = run_git(
        &f.repo,
        &["show", &format!("{}:new/added.txt", result.backup)],
    )
    .unwrap();
    assert_eq!(String::from_utf8(backed_up).unwrap(), "added\n");
    assert!(result
        .backup_ref
        .starts_with("refs/monocode/checkpoints/s/restore-"));
}

#[test]
fn restores_to_before_the_first_turn() {
    let f = Fixture::new();
    three_turns(&f);
    f.store.restore_to_turn("s", f.cwd(), "t1").unwrap();
    assert_eq!(f.read("a.txt").as_deref(), Some("original\n"));
    assert_eq!(f.read("keep.txt").as_deref(), Some("kept\n"));
    assert_eq!(f.read("new/added.txt"), None);
}

#[test]
fn preview_lists_each_change_and_leaves_nothing_behind() {
    let f = Fixture::new();
    three_turns(&f);
    let refs = f.refs();
    let preview = f.store.restore_preview("s", f.cwd(), "t2").unwrap();
    assert_eq!(f.refs(), refs);
    assert_eq!(preview.blocked, None);
    let actions: Vec<_> = preview
        .files
        .iter()
        .map(|file| {
            (
                file.relative.as_str(),
                file.action.as_str(),
                file.restorable,
            )
        })
        .collect();
    assert_eq!(
        actions,
        [
            ("a.txt", "restore", true),
            ("keep.txt", "recreate", true),
            ("new/added.txt", "delete", true),
        ]
    );
    // A preview changes no file.
    assert_eq!(f.read("a.txt").as_deref(), Some("turn two\n"));
}

#[test]
fn refuses_when_the_branch_moved_since_the_turn() {
    let f = Fixture::new();
    three_turns(&f);
    run_git(&f.repo, &["add", "-A"]).unwrap();
    run_git(&f.repo, &["commit", "-m", "user commit"]).unwrap();
    let preview = f.store.restore_preview("s", f.cwd(), "t1").unwrap();
    assert!(preview.blocked.unwrap().contains("branch has moved"));
    let error = f.store.restore_to_turn("s", f.cwd(), "t1").unwrap_err();
    assert!(error.contains("branch has moved"));
    assert_eq!(f.read("a.txt").as_deref(), Some("turn two\n"));
}

#[test]
fn refuses_while_another_chat_works_in_the_folder() {
    let f = Fixture::new();
    three_turns(&f);
    f.store.begin_turn("other", f.cwd(), "o1").unwrap();
    let error = f.store.restore_to_turn("s", f.cwd(), "t1").unwrap_err();
    assert!(error.contains("Another chat"));
    f.store.finish_turn("other", f.cwd(), "o1").unwrap();
    assert!(f.store.restore_to_turn("s", f.cwd(), "t1").is_ok());
}

#[test]
fn refuses_while_this_chat_has_a_turn_running() {
    let f = Fixture::new();
    three_turns(&f);
    f.store.begin_turn("s", f.cwd(), "t4").unwrap();
    let error = f.store.restore_to_turn("s", f.cwd(), "t1").unwrap_err();
    assert!(error.contains("still running"));
}

#[test]
fn refuses_unknown_and_malformed_turns_and_other_folders() {
    let f = Fixture::new();
    three_turns(&f);
    assert!(f
        .store
        .restore_to_turn("s", f.cwd(), "missing")
        .unwrap_err()
        .contains("No checkpoint"));
    for bad in ["../t1", "t1/x", "", "t 1"] {
        assert!(f.store.restore_to_turn("s", f.cwd(), bad).is_err());
    }
    let other = f.dir.join("other");
    std::fs::create_dir_all(&other).unwrap();
    run_git(&other, &["init"]).unwrap();
    assert!(f
        .store
        .restore_preview("s", other.to_str().unwrap(), "t1")
        .unwrap_err()
        .contains("another folder"));
}

#[cfg(unix)]
#[test]
fn never_writes_through_a_symbolic_link() {
    let f = Fixture::new();
    let outside = f.dir.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "outside\n").unwrap();
    f.turn("s", "t1", |f| f.write("linked/secret.txt", "inside\n"));
    // After the turn, the folder is swapped for a link to somewhere else.
    std::fs::remove_dir_all(f.repo.join("linked")).unwrap();
    std::os::unix::fs::symlink(&outside, f.repo.join("linked")).unwrap();
    let result = f.store.restore_to_turn("s", f.cwd(), "t1").unwrap();
    assert!(!result
        .restored
        .iter()
        .any(|path| path.starts_with("linked")));
    assert_eq!(
        std::fs::read_to_string(outside.join("secret.txt")).unwrap(),
        "outside\n"
    );
}
