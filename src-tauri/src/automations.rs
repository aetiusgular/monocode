use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::session_store::{now_millis, validate_id, SessionStore};

pub(crate) const CHANGED: &str = "monocode:automations-changed";

const MAX_NAME: usize = 200;
const MAX_PROMPT: usize = 1_000_000;
const MAX_TRIGGERS: usize = 20;
const MAX_RUNS_PER_AUTOMATION: i64 = 100;
const MIN_INTERVAL_MINUTES: i64 = 5;
const MAX_INTERVAL_MINUTES: i64 = 43_200;
/// Year 3000, so a typo in a one-time date fails here, not in the scheduler.
const MAX_AT: i64 = 32_503_680_000_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    id: String,
    name: String,
    prompt: String,
    harness: String,
    model: String,
    #[serde(default)]
    model_settings: HashMap<String, String>,
    cwd: String,
    workspace_mode: String,
    #[serde(default)]
    worktree_cwd: String,
    #[serde(default)]
    session_folder_id: String,
    reuse_session: bool,
    runtime_mode: String,
    #[serde(default = "default_trigger_kind")]
    trigger_kind: String,
    #[serde(default)]
    trigger_event: String,
    schedule_kind: String,
    minute: i64,
    time: String,
    day_of_week: i64,
    #[serde(default)]
    triggers: Option<Vec<AutomationTrigger>>,
    missed_run_grace_minutes: i64,
    /// macOS: hold the Mac awake while a run of this automation is active.
    #[serde(default)]
    keep_awake: bool,
    enabled: bool,
    next_run_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_session_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUpsert {
    id: String,
    name: String,
    prompt: String,
    harness: String,
    model: String,
    #[serde(default)]
    model_settings: HashMap<String, String>,
    cwd: String,
    workspace_mode: String,
    #[serde(default)]
    worktree_cwd: String,
    #[serde(default)]
    session_folder_id: String,
    #[serde(default)]
    reuse_session: bool,
    runtime_mode: String,
    #[serde(default = "default_trigger_kind")]
    trigger_kind: String,
    #[serde(default)]
    trigger_event: String,
    schedule_kind: String,
    minute: i64,
    time: String,
    day_of_week: i64,
    #[serde(default)]
    triggers: Option<Vec<AutomationTrigger>>,
    missed_run_grace_minutes: i64,
    #[serde(default)]
    keep_awake: bool,
    #[serde(default = "default_true")]
    enabled: bool,
    next_run_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    id: String,
    automation_id: String,
    trigger: String,
    scheduled_for: i64,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<i64>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTrigger {
    #[serde(default)]
    id: String,
    kind: String,
    #[serde(default)]
    event: String,
    #[serde(default = "default_schedule_kind")]
    schedule_kind: String,
    #[serde(default)]
    minute: i64,
    #[serde(default = "default_time")]
    time: String,
    #[serde(default = "default_day_of_week")]
    day_of_week: i64,
    #[serde(default)]
    repos: Vec<String>,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    branch: String,
    #[serde(default = "default_actor")]
    actor: String,
    /// A one-time schedule's moment, epoch ms.
    #[serde(default)]
    at: i64,
    /// An interval schedule's period.
    #[serde(default)]
    interval_minutes: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueAutomationRun {
    automation: Automation,
    run: AutomationRun,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationEventClaim {
    event_key: String,
    event_kind: String,
    event: String,
    scheduled_for: i64,
    prompt: String,
}

fn default_true() -> bool {
    true
}

fn default_trigger_kind() -> String {
    "time".into()
}

fn default_schedule_kind() -> String {
    "weekdays".into()
}

fn default_time() -> String {
    "09:00".into()
}

fn default_day_of_week() -> i64 {
    1
}

fn default_actor() -> String {
    "anyone".into()
}

pub(crate) fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS automations (
           id TEXT PRIMARY KEY,
           definition_json TEXT NOT NULL,
           enabled INTEGER NOT NULL,
           next_run_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS automations_due_idx
           ON automations (enabled, next_run_at);
         CREATE TABLE IF NOT EXISTS automation_runs (
           id TEXT PRIMARY KEY,
           automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
           created_at INTEGER NOT NULL,
           run_json TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS automation_runs_history_idx
           ON automation_runs (automation_id, created_at DESC);
         CREATE TABLE IF NOT EXISTS automation_event_claims (
           automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
           event_key TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           PRIMARY KEY (automation_id, event_key)
         );",
    )?;

    // Backfill claims from pre-ledger run history. Invalid legacy rows should not
    // prevent the session store from opening.
    let mut statement =
        conn.prepare("SELECT automation_id, created_at, run_json FROM automation_runs")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut claims = Vec::new();
    for row in rows {
        let (automation_id, created_at, raw) = row?;
        if let Ok(run) = serde_json::from_str::<AutomationRun>(&raw) {
            if let Some(event_key) = run.event_key {
                claims.push((automation_id, event_key, created_at));
            }
        }
    }
    drop(statement);
    for (automation_id, event_key, created_at) in claims {
        conn.execute(
            "INSERT OR IGNORE INTO automation_event_claims
             (automation_id, event_key, created_at) VALUES (?1, ?2, ?3)",
            params![automation_id, event_key, created_at],
        )?;
    }
    Ok(())
}

/// A fresh worktree needs a commit to start from. An automation that would
/// make one in a repository with no commits is refused when it is saved,
/// accepted or switched on, with the reason, rather than failing at each
/// run with git's "Needed a single revision" (Mac test 2.16). It is not
/// moved to the current working copy: where a run works is the user's call.
/// Switching one off is still allowed.
fn refuse_unborn_worktree(input: &AutomationUpsert) -> Result<(), String> {
    if input.workspace_mode != "worktree" || !input.enabled {
        return Ok(());
    }
    if crate::worktrees::has_no_commits(&crate::fs::expand_home(&input.cwd)) {
        return Err(crate::worktrees::NO_COMMITS_MESSAGE.into());
    }
    Ok(())
}

fn validate_upsert(input: &AutomationUpsert, now: i64) -> Result<(), String> {
    validate_id(&input.id, "automation")?;
    if input.name.trim().is_empty() || input.name.len() > MAX_NAME {
        return Err("Automation name is required and must be under 200 characters.".into());
    }
    if input.prompt.trim().is_empty() || input.prompt.len() > MAX_PROMPT {
        return Err("Automation prompt is required.".into());
    }
    if input.cwd.trim().is_empty() {
        return Err("Choose a project for this automation.".into());
    }
    if !matches!(
        input.workspace_mode.as_str(),
        "current" | "worktree" | "existing"
    ) {
        return Err("Invalid automation workspace mode.".into());
    }
    if input.workspace_mode == "existing" {
        let path = input.worktree_cwd.trim();
        if path.is_empty() || path.len() > 1_000 {
            return Err("Choose an existing worktree for this automation.".into());
        }
    }
    if input.session_folder_id.len() > 80 {
        return Err("Invalid automation session folder.".into());
    }
    if !matches!(
        input.runtime_mode.as_str(),
        "supervised" | "auto-accept-edits" | "auto" | "full-access"
    ) {
        return Err("Invalid automation run mode.".into());
    }
    if !matches!(
        input.trigger_kind.as_str(),
        "time" | "github" | "linear" | "jira" | "gitlab" | "azuredevops"
    ) {
        return Err("Invalid automation trigger.".into());
    }
    if input.trigger_event.len() > 200 {
        return Err("Invalid automation trigger event.".into());
    }
    if !valid_schedule_kind(&input.schedule_kind) {
        return Err("Invalid automation schedule.".into());
    }
    if !(0..=59).contains(&input.minute)
        || !(0..=6).contains(&input.day_of_week)
        || !valid_time(&input.time)
    {
        return Err("Invalid automation time.".into());
    }
    if !(0..=43_200).contains(&input.missed_run_grace_minutes) {
        return Err("Invalid missed-run grace period.".into());
    }
    if input.next_run_at <= now {
        return Err("The next automation run must be in the future.".into());
    }
    if let Some(triggers) = &input.triggers {
        if triggers.len() > MAX_TRIGGERS {
            return Err("Too many automation triggers.".into());
        }
        for trigger in triggers {
            validate_trigger(trigger)?;
        }
        if input.enabled && spent_after(triggers, now) {
            return Err("Pick a time in the future for the one-time run.".into());
        }
    }
    Ok(())
}

fn validate_trigger(trigger: &AutomationTrigger) -> Result<(), String> {
    if !matches!(
        trigger.kind.as_str(),
        "time" | "github" | "linear" | "jira" | "gitlab" | "azuredevops"
    ) {
        return Err("Invalid automation trigger.".into());
    }
    if trigger.event.len() > 200
        || trigger.repo.len() > 400
        || trigger.branch.len() > 400
        || trigger.actor.len() > 200
        || trigger.repos.len() > 50
        || trigger.repos.iter().any(|repo| repo.len() > 400)
    {
        return Err("Invalid automation trigger event.".into());
    }
    if !valid_schedule_kind(&trigger.schedule_kind) {
        return Err("Invalid automation schedule.".into());
    }
    if !(0..=59).contains(&trigger.minute)
        || !(0..=6).contains(&trigger.day_of_week)
        || !valid_time(&trigger.time)
    {
        return Err("Invalid automation time.".into());
    }
    if trigger.kind == "time" {
        if trigger.schedule_kind == "once" && !(1..=MAX_AT).contains(&trigger.at) {
            return Err("Choose a date and time for the one-time run.".into());
        }
        if trigger.schedule_kind == "interval"
            && !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&trigger.interval_minutes)
        {
            return Err("An interval must be between 5 minutes and 30 days.".into());
        }
    }
    Ok(())
}

fn valid_schedule_kind(value: &str) -> bool {
    matches!(
        value,
        "hourly" | "daily" | "weekdays" | "weekly" | "once" | "interval"
    )
}

/// A time trigger that can still fire at or after `from`: every recurring
/// schedule, and a one-time schedule whose moment has not passed.
fn trigger_live_from(trigger: &AutomationTrigger, from: i64) -> bool {
    trigger.kind == "time" && (trigger.schedule_kind != "once" || trigger.at >= from)
}

fn has_live_time_trigger(automation: &Automation, from: i64) -> bool {
    match &automation.triggers {
        Some(triggers) => triggers
            .iter()
            .any(|trigger| trigger_live_from(trigger, from)),
        // Legacy rows predate one-time schedules.
        None => automation.trigger_kind == "time",
    }
}

/// Every trigger is a one-time schedule at or before `at`: nothing is left to
/// run, so the automation turns itself off rather than waiting a year.
fn spent_after(triggers: &[AutomationTrigger], at: i64) -> bool {
    !triggers.is_empty()
        && triggers.iter().all(|trigger| {
            trigger.kind == "time" && trigger.schedule_kind == "once" && trigger.at <= at
        })
}

fn hydrate_triggers(automation: &mut Automation) {
    if automation.triggers.is_some() {
        return;
    }
    automation.triggers = Some(vec![legacy_trigger(automation)]);
}

fn legacy_trigger(automation: &Automation) -> AutomationTrigger {
    trigger_from_fields(
        &automation.id,
        &automation.trigger_kind,
        &automation.trigger_event,
        &automation.schedule_kind,
        automation.minute,
        &automation.time,
        automation.day_of_week,
    )
}

fn has_time_trigger(automation: &Automation) -> bool {
    match &automation.triggers {
        Some(triggers) => triggers.iter().any(|trigger| trigger.kind == "time"),
        None => automation.trigger_kind == "time",
    }
}

fn normalize_triggers(input: &AutomationUpsert) -> Vec<AutomationTrigger> {
    let mut triggers = input.triggers.clone().unwrap_or_else(|| {
        vec![trigger_from_fields(
            &input.id,
            &input.trigger_kind,
            &input.trigger_event,
            &input.schedule_kind,
            input.minute,
            &input.time,
            input.day_of_week,
        )]
    });
    for trigger in &mut triggers {
        if trigger.id.trim().is_empty() {
            trigger.id = Uuid::new_v4().to_string();
        }
        trigger.event = trigger.event.trim().to_string();
        trigger.repo = trigger.repo.trim().to_string();
        trigger.branch = trigger.branch.trim().to_string();
        trigger.actor = trigger.actor.trim().to_string();
        if trigger.actor.is_empty() {
            trigger.actor = default_actor();
        }
        trigger.repos = trigger
            .repos
            .iter()
            .map(|repo| repo.trim().to_string())
            .filter(|repo| !repo.is_empty())
            .collect();
    }
    triggers
}

fn trigger_from_fields(
    id: &str,
    kind: &str,
    event: &str,
    schedule_kind: &str,
    minute: i64,
    time: &str,
    day_of_week: i64,
) -> AutomationTrigger {
    AutomationTrigger {
        id: format!("{id}:legacy"),
        kind: kind.to_string(),
        event: if event.is_empty() {
            schedule_kind.to_string()
        } else {
            event.to_string()
        },
        schedule_kind: schedule_kind.to_string(),
        minute,
        time: time.to_string(),
        day_of_week,
        repos: Vec::new(),
        repo: String::new(),
        branch: String::new(),
        actor: default_actor(),
        at: 0,
        interval_minutes: 0,
    }
}

fn parse_automation(value: String) -> Result<Automation, String> {
    let mut automation: Automation =
        serde_json::from_str(&value).map_err(|error| error.to_string())?;
    hydrate_triggers(&mut automation);
    Ok(automation)
}

fn valid_time(value: &str) -> bool {
    let Some((hour, minute)) = value.split_once(':') else {
        return false;
    };
    hour.len() == 2
        && minute.len() == 2
        && hour.parse::<u8>().is_ok_and(|value| value < 24)
        && minute.parse::<u8>().is_ok_and(|value| value < 60)
}

fn list(conn: &Connection) -> Result<Vec<Automation>, String> {
    let mut statement = conn
        .prepare("SELECT definition_json FROM automations ORDER BY updated_at DESC, id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let value = row.map_err(|error| error.to_string())?;
        parse_automation(value)
    })
    .collect()
}

fn get(conn: &Connection, id: &str) -> Result<Option<Automation>, String> {
    let raw = conn
        .query_row(
            "SELECT definition_json FROM automations WHERE id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    raw.map(parse_automation).transpose()
}

fn write_automation(conn: &Connection, automation: &Automation) -> Result<(), String> {
    let raw = serde_json::to_string(automation).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           definition_json = excluded.definition_json,
           enabled = excluded.enabled,
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at",
        params![
            automation.id,
            raw,
            automation.enabled,
            automation.next_run_at,
            automation.updated_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn write_run(conn: &Connection, run: &AutomationRun) -> Result<(), String> {
    let raw = serde_json::to_string(run).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO automation_runs (id, automation_id, created_at, run_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET run_json = excluded.run_json",
        params![run.id, run.automation_id, run.created_at, raw],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn new_run(
    automation_id: &str,
    trigger: &str,
    scheduled_for: i64,
    now: i64,
    prompt: &str,
) -> AutomationRun {
    AutomationRun {
        id: Uuid::new_v4().to_string(),
        automation_id: automation_id.to_string(),
        trigger: trigger.to_string(),
        scheduled_for,
        created_at: now,
        started_at: None,
        completed_at: None,
        status: "pending".into(),
        session_id: None,
        error: None,
        event_key: None,
        event_kind: None,
        event: None,
        prompt: Some(prompt.to_string()),
    }
}

fn new_event_run(
    automation_id: &str,
    event_key: &str,
    event_kind: &str,
    event: &str,
    scheduled_for: i64,
    now: i64,
    prompt: &str,
) -> AutomationRun {
    let mut run = new_run(automation_id, "event", scheduled_for, now, prompt);
    run.event_key = Some(event_key.to_string());
    run.event_kind = Some(event_kind.to_string());
    run.event = Some(event.to_string());
    run
}

fn validate_event_key(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 400
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'/' | b'.')
        })
    {
        return Err("Invalid automation event key.".into());
    }
    Ok(())
}

fn has_event_trigger(automation: &Automation, kind: &str, event: &str) -> bool {
    match &automation.triggers {
        Some(triggers) => triggers
            .iter()
            .any(|trigger| trigger.kind == kind && trigger.event == event),
        None => automation.trigger_kind == kind && automation.trigger_event == event,
    }
}

fn list_runs(conn: &Connection, automation_id: &str) -> Result<Vec<AutomationRun>, String> {
    let mut statement = conn
        .prepare(
            "SELECT run_json FROM automation_runs WHERE automation_id = ?1
             ORDER BY created_at DESC LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([automation_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let value = row.map_err(|error| error.to_string())?;
        serde_json::from_str(&value).map_err(|error| error.to_string())
    })
    .collect()
}

fn trim_history(conn: &Connection, automation_id: &str) -> Result<(), String> {
    let mut statement = conn
        .prepare(
            "SELECT id, run_json FROM automation_runs WHERE automation_id = ?1
             ORDER BY created_at DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([automation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut delete_ids = Vec::new();
    for (index, row) in rows.enumerate() {
        let (id, raw) = row.map_err(|error| error.to_string())?;
        if index < MAX_RUNS_PER_AUTOMATION as usize {
            continue;
        }
        let run: AutomationRun = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        if matches!(
            run.status.as_str(),
            "succeeded" | "failed" | "skipped" | "cancelled"
        ) {
            delete_ids.push(id);
        }
    }
    drop(statement);
    for id in delete_ids {
        conn.execute("DELETE FROM automation_runs WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn apply_run_summary(automation: &mut Automation, run: &AutomationRun) {
    if automation
        .last_run_at
        .is_none_or(|last_run_at| run.created_at >= last_run_at)
    {
        automation.last_run_at = Some(run.created_at);
        automation.last_run_status = Some(run.status.clone());
        automation.last_run_error = run.error.clone();
        if run.session_id.is_some() {
            automation.last_session_id = run.session_id.clone();
        }
    }
}

/// The error a pending run carries when its automation was switched off
/// before the run started (Mac test 2.13).
const SWITCHED_OFF: &str = "Switched off before it started.";

/// Whether a pending run may still start. A manual run is the user's own
/// click and always may. A scheduled or event run needs its automation
/// switched on, except the one run of a one-time schedule: claiming that run
/// turns the automation off by itself, so that run stays live.
fn run_still_live(automation: &Automation, run: &AutomationRun) -> bool {
    if run.trigger == "manual" || automation.enabled {
        return true;
    }
    run.trigger == "scheduled"
        && automation.triggers.as_deref().is_some_and(|triggers| {
            spent_after(triggers, run.scheduled_for)
                && triggers.iter().any(|trigger| {
                    trigger.kind == "time"
                        && trigger.schedule_kind == "once"
                        && trigger.at == run.scheduled_for
                })
        })
}

fn pending_runs(conn: &Connection, created_before: i64) -> Result<Vec<AutomationRun>, String> {
    let mut statement = conn
        .prepare(
            "SELECT run_json FROM automation_runs WHERE created_at <= ?1
             ORDER BY created_at, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([created_before], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut runs = Vec::new();
    for row in rows {
        let raw = row.map_err(|error| error.to_string())?;
        let run: AutomationRun = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        if run.status == "pending" {
            runs.push(run);
        }
    }
    Ok(runs)
}

/// Mark every pending run of an automation Skipped because it was switched
/// off. Runs already started are left to finish.
fn skip_pending_runs(
    conn: &Connection,
    automation: &mut Automation,
    now: i64,
) -> Result<bool, String> {
    let mut changed = false;
    for mut run in list_runs(conn, &automation.id)? {
        if run.status != "pending" {
            continue;
        }
        run.status = "skipped".into();
        run.completed_at = Some(now);
        run.error = Some(SWITCHED_OFF.into());
        apply_run_summary(automation, &run);
        write_run(conn, &run)?;
        changed = true;
    }
    Ok(changed)
}

/// The error a pending run carries when its automation was saved switched
/// off before the run started (security fix F8).
const CANCELLED: &str = "Cancelled before it started.";

/// Mark the pending scheduled and event runs of an automation Skipped as
/// cancelled. A manual run is the user's own click and is left alone; runs
/// already started are left to finish.
fn cancel_pending_runs(
    conn: &Connection,
    automation: &mut Automation,
    now: i64,
) -> Result<bool, String> {
    let mut changed = false;
    for mut run in list_runs(conn, &automation.id)? {
        if run.status != "pending" || run.trigger == "manual" {
            continue;
        }
        run.status = "skipped".into();
        run.completed_at = Some(now);
        run.error = Some(CANCELLED.into());
        apply_run_summary(automation, &run);
        write_run(conn, &run)?;
        changed = true;
    }
    Ok(changed)
}

/// Cancel one run the user picked in Run history (security fix R7). Only a
/// run that has not started: it reads Skipped, "Cancelled before it
/// started.", and `begin_run` then finds nothing to start. Any other run is
/// left alone and `false` comes back.
fn cancel_run(conn: &Connection, run_id: &str, now: i64) -> Result<bool, String> {
    let raw = conn
        .query_row(
            "SELECT run_json FROM automation_runs WHERE id = ?1",
            [run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else {
        return Ok(false);
    };
    let mut run: AutomationRun = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if run.status != "pending" {
        return Ok(false);
    }
    run.status = "skipped".into();
    run.completed_at = Some(now);
    run.error = Some(CANCELLED.into());
    write_run(conn, &run)?;
    if let Some(mut automation) = get(conn, &run.automation_id)? {
        apply_run_summary(&mut automation, &run);
        write_automation(conn, &automation)?;
    }
    trim_history(conn, &run.automation_id)?;
    Ok(true)
}

/// Delete an automation. Its runs go with it (`ON DELETE CASCADE`), so a
/// pending run can no longer start: `begin_run` finds nothing.
fn delete_automation(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM automations WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Move one pending run to running, once. Re-reads its automation at this
/// moment: a run whose automation is gone returns nothing, and one whose
/// automation was switched off is marked Skipped and returns nothing. A run
/// that already started returns nothing, so no run starts twice.
fn begin_run(
    conn: &Connection,
    run_id: &str,
    now: i64,
) -> Result<Option<DueAutomationRun>, String> {
    let raw = conn
        .query_row(
            "SELECT run_json FROM automation_runs WHERE id = ?1",
            [run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let mut run: AutomationRun = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if run.status != "pending" {
        return Ok(None);
    }
    let Some(mut automation) = get(conn, &run.automation_id)? else {
        return Ok(None);
    };
    if !run_still_live(&automation, &run) {
        run.status = "skipped".into();
        run.completed_at = Some(now);
        run.error = Some(SWITCHED_OFF.into());
        apply_run_summary(&mut automation, &run);
        write_run(conn, &run)?;
        write_automation(conn, &automation)?;
        trim_history(conn, &run.automation_id)?;
        return Ok(None);
    }
    run.status = "running".into();
    run.started_at = Some(now);
    apply_run_summary(&mut automation, &run);
    write_run(conn, &run)?;
    write_automation(conn, &automation)?;
    Ok(Some(DueAutomationRun { automation, run }))
}

#[tauri::command(async)]
pub fn automations_list(store: State<'_, SessionStore>) -> Result<Vec<Automation>, String> {
    let conn = store.lock_conn()?;
    list(&conn)
}

#[tauri::command(async)]
pub fn automations_upsert(
    app: AppHandle,
    store: State<'_, SessionStore>,
    automation: AutomationUpsert,
) -> Result<Automation, String> {
    let now = now_millis();
    validate_upsert(&automation, now)?;
    refuse_unborn_worktree(&automation)?;
    let triggers = Some(normalize_triggers(&automation));
    let conn = store.lock_conn()?;
    let saved = save_automation(&conn, automation, triggers, now)?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(saved)
}

/// Write one automation, already checked, and settle its pending runs:
/// switching it off skips them; saving it off while it was already off
/// cancels a claimed one-time run that has not started (security fix F8).
fn save_automation(
    conn: &Connection,
    automation: AutomationUpsert,
    triggers: Option<Vec<AutomationTrigger>>,
    now: i64,
) -> Result<Automation, String> {
    let previous = get(conn, &automation.id)?;
    let was_off = previous.as_ref().is_some_and(|value| !value.enabled);
    let was_enabled = previous.as_ref().is_some_and(|value| value.enabled);
    let created_at = previous
        .as_ref()
        .map(|value| value.created_at)
        .unwrap_or(now);
    let worktree_cwd = if automation.workspace_mode == "existing" {
        automation.worktree_cwd.trim().to_string()
    } else {
        String::new()
    };
    let saved = Automation {
        id: automation.id,
        name: automation.name.trim().to_string(),
        prompt: automation.prompt,
        harness: automation.harness,
        model: automation.model,
        model_settings: automation.model_settings,
        cwd: automation.cwd,
        workspace_mode: automation.workspace_mode,
        worktree_cwd,
        session_folder_id: automation.session_folder_id.trim().to_string(),
        reuse_session: automation.reuse_session,
        runtime_mode: automation.runtime_mode,
        trigger_kind: automation.trigger_kind,
        trigger_event: automation.trigger_event.trim().to_string(),
        schedule_kind: automation.schedule_kind,
        minute: automation.minute,
        time: automation.time,
        day_of_week: automation.day_of_week,
        triggers,
        missed_run_grace_minutes: automation.missed_run_grace_minutes,
        keep_awake: automation.keep_awake,
        enabled: automation.enabled,
        next_run_at: automation.next_run_at,
        last_run_at: previous.as_ref().and_then(|value| value.last_run_at),
        last_run_status: previous
            .as_ref()
            .and_then(|value| value.last_run_status.clone()),
        last_run_error: previous
            .as_ref()
            .and_then(|value| value.last_run_error.clone()),
        last_session_id: previous.and_then(|value| value.last_session_id),
        created_at,
        updated_at: now,
    };
    let mut saved = saved;
    if !saved.enabled && was_enabled {
        skip_pending_runs(conn, &mut saved, now)?;
    } else if !saved.enabled && was_off {
        // Claiming a one-time run switches its automation off, so the
        // switch above never fires for it. Saving it off again (or deleting
        // it) is how the user stops that run before it starts.
        cancel_pending_runs(conn, &mut saved, now)?;
    }
    write_automation(conn, &saved)?;
    Ok(saved)
}

#[tauri::command(async)]
pub fn automations_delete(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    validate_id(&id, "automation")?;
    let conn = store.lock_conn()?;
    delete_automation(&conn, &id)?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(())
}

#[tauri::command(async)]
pub fn automation_runs_list(
    store: State<'_, SessionStore>,
    automation_id: String,
) -> Result<Vec<AutomationRun>, String> {
    validate_id(&automation_id, "automation")?;
    let conn = store.lock_conn()?;
    let mut runs = list_runs(&conn, &automation_id)?;
    // Launch prompts can be large and are only needed by restart recovery, not
    // by the run-history surface.
    for run in &mut runs {
        run.prompt = None;
    }
    Ok(runs)
}

#[tauri::command(async)]
pub fn automation_runs_recover(
    app: AppHandle,
    store: State<'_, SessionStore>,
    started_before: i64,
    now: i64,
) -> Result<Vec<DueAutomationRun>, String> {
    let mut conn = store.lock_conn()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut statement = tx
        .prepare(
            "SELECT run_json FROM automation_runs WHERE created_at <= ?1
             ORDER BY created_at, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([started_before], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut runs = Vec::new();
    for row in rows {
        let raw = row.map_err(|error| error.to_string())?;
        runs.push(serde_json::from_str::<AutomationRun>(&raw).map_err(|error| error.to_string())?);
    }
    drop(statement);

    let mut due = Vec::new();
    let mut changed = false;
    let mut changed_automation_ids = Vec::new();
    for mut run in runs {
        if run.status != "pending" && run.status != "running" {
            continue;
        }
        let Some(mut automation) = get(&tx, &run.automation_id)? else {
            continue;
        };
        if run.status == "running" {
            run.status = "cancelled".into();
            run.completed_at = Some(now);
            run.error = Some("Interrupted when MonoCode last stopped.".into());
            apply_run_summary(&mut automation, &run);
            write_run(&tx, &run)?;
            write_automation(&tx, &automation)?;
            changed_automation_ids.push(run.automation_id.clone());
            changed = true;
            continue;
        }
        if run.trigger == "event"
            && run
                .prompt
                .as_deref()
                .is_none_or(|prompt| prompt.trim().is_empty())
        {
            run.status = "failed".into();
            run.completed_at = Some(now);
            run.error = Some("The Inbox event prompt was not available after restart.".into());
            apply_run_summary(&mut automation, &run);
            write_run(&tx, &run)?;
            write_automation(&tx, &automation)?;
            changed_automation_ids.push(run.automation_id.clone());
            changed = true;
            continue;
        }
        due.push(DueAutomationRun { automation, run });
    }
    changed_automation_ids.sort();
    changed_automation_ids.dedup();
    for automation_id in changed_automation_ids {
        trim_history(&tx, &automation_id)?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    if changed || !due.is_empty() {
        let _ = app.emit(CHANGED, ());
    }
    Ok(due)
}

#[tauri::command(async)]
pub fn automation_run_now(
    app: AppHandle,
    store: State<'_, SessionStore>,
    automation_id: String,
    now: i64,
) -> Result<AutomationRun, String> {
    validate_id(&automation_id, "automation")?;
    let mut conn = store.lock_conn()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut automation =
        get(&tx, &automation_id)?.ok_or_else(|| "Automation not found.".to_string())?;
    let run = new_run(&automation_id, "manual", now, now, &automation.prompt);
    automation.last_run_at = Some(now);
    automation.last_run_status = Some(run.status.clone());
    automation.last_run_error = None;
    write_run(&tx, &run)?;
    write_automation(&tx, &automation)?;
    trim_history(&tx, &automation_id)?;
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(run)
}

/// Start a pending run: the one place a run moves from Pending to Running.
#[tauri::command(async)]
pub fn automation_run_begin(
    app: AppHandle,
    store: State<'_, SessionStore>,
    run_id: String,
    now: i64,
) -> Result<Option<DueAutomationRun>, String> {
    validate_id(&run_id, "automation run")?;
    let mut conn = store.lock_conn()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let begun = begin_run(&tx, &run_id, now)?;
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(begun)
}

/// Cancel a run that has not started yet. `false` when it already started,
/// finished or is gone.
#[tauri::command(async)]
pub fn automation_run_cancel(
    app: AppHandle,
    store: State<'_, SessionStore>,
    run_id: String,
) -> Result<bool, String> {
    validate_id(&run_id, "automation run")?;
    let mut conn = store.lock_conn()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let cancelled = cancel_run(&tx, &run_id, now_millis())?;
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    if cancelled {
        let _ = app.emit(CHANGED, ());
    }
    Ok(cancelled)
}

/// Pending runs created at or before `created_before`, for the scheduler to
/// pick up a run whose launch was dropped (Mac test 2.13).
#[tauri::command(async)]
pub fn automation_runs_pending(
    store: State<'_, SessionStore>,
    created_before: i64,
) -> Result<Vec<DueAutomationRun>, String> {
    let conn = store.lock_conn()?;
    let mut due = Vec::new();
    for run in pending_runs(&conn, created_before)? {
        if let Some(automation) = get(&conn, &run.automation_id)? {
            due.push(DueAutomationRun { automation, run });
        }
    }
    Ok(due)
}

#[tauri::command(async)]
pub fn automations_claim_due(
    app: AppHandle,
    store: State<'_, SessionStore>,
    automation_id: String,
    expected_next_run_at: i64,
    next_run_at: i64,
    now: i64,
) -> Result<Option<DueAutomationRun>, String> {
    validate_id(&automation_id, "automation")?;
    if next_run_at <= expected_next_run_at {
        return Err("The following automation occurrence must advance the schedule.".into());
    }
    let mut conn = store.lock_conn()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let current = get(&tx, &automation_id)?.ok_or_else(|| "Automation not found.".to_string())?;
    if !has_time_trigger(&current) || !has_live_time_trigger(&current, expected_next_run_at) {
        tx.rollback().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let claimed = tx
        .execute(
            "UPDATE automations SET next_run_at = ?1
             WHERE id = ?2 AND enabled = 1 AND next_run_at = ?3 AND next_run_at <= ?4",
            params![next_run_at, automation_id, expected_next_run_at, now],
        )
        .map_err(|error| error.to_string())?;
    if claimed == 0 {
        tx.rollback().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let mut automation =
        get(&tx, &automation_id)?.ok_or_else(|| "Automation not found.".to_string())?;
    automation.next_run_at = next_run_at;
    let mut run = new_run(
        &automation_id,
        "scheduled",
        expected_next_run_at,
        now,
        &automation.prompt,
    );
    let grace_ms = automation.missed_run_grace_minutes.saturating_mul(60_000);
    let missed = now.saturating_sub(expected_next_run_at);
    let dispatch = missed <= grace_ms;
    if !dispatch {
        run.status = "skipped".into();
        run.completed_at = Some(now);
        run.error = Some("Missed the scheduled run beyond its grace period.".into());
    }
    automation.last_run_at = Some(now);
    automation.last_run_status = Some(run.status.clone());
    automation.last_run_error = run.error.clone();
    // A one-time run disables itself once it fires (or is skipped), instead
    // of waiting a year for the placeholder next run.
    if automation
        .triggers
        .as_deref()
        .is_some_and(|triggers| spent_after(triggers, expected_next_run_at))
    {
        automation.enabled = false;
    }
    write_run(&tx, &run)?;
    write_automation(&tx, &automation)?;
    trim_history(&tx, &automation_id)?;
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(Some(DueAutomationRun { automation, run }))
}

#[tauri::command(async)]
pub fn automations_claim_event(
    app: AppHandle,
    store: State<'_, SessionStore>,
    automation_id: String,
    claim: AutomationEventClaim,
    now: i64,
) -> Result<Option<DueAutomationRun>, String> {
    validate_id(&automation_id, "automation")?;
    validate_event_key(&claim.event_key)?;
    if !matches!(
        claim.event_kind.as_str(),
        "github" | "linear" | "jira" | "gitlab" | "azuredevops"
    ) {
        return Err("Invalid automation trigger.".into());
    }
    if claim.event.is_empty() || claim.event.len() > 200 {
        return Err("Invalid automation trigger event.".into());
    }
    if claim.prompt.trim().is_empty() || claim.prompt.len() > MAX_PROMPT + 10_000 {
        return Err("Invalid automation run prompt.".into());
    }
    let scheduled_for = if claim.scheduled_for > 0 {
        claim.scheduled_for
    } else {
        now
    };
    let mut conn = store.lock_conn()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut automation =
        get(&tx, &automation_id)?.ok_or_else(|| "Automation not found.".to_string())?;
    if !automation.enabled || !has_event_trigger(&automation, &claim.event_kind, &claim.event) {
        tx.rollback().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let claimed = tx
        .execute(
            "INSERT OR IGNORE INTO automation_event_claims
             (automation_id, event_key, created_at) VALUES (?1, ?2, ?3)",
            params![automation_id, claim.event_key, now],
        )
        .map_err(|error| error.to_string())?;
    if claimed == 0 {
        tx.rollback().map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let run = new_event_run(
        &automation_id,
        &claim.event_key,
        &claim.event_kind,
        &claim.event,
        scheduled_for,
        now,
        &claim.prompt,
    );
    automation.last_run_at = Some(now);
    automation.last_run_status = Some(run.status.clone());
    automation.last_run_error = None;
    write_run(&tx, &run)?;
    write_automation(&tx, &automation)?;
    trim_history(&tx, &automation_id)?;
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    let _ = app.emit(CHANGED, ());
    Ok(Some(DueAutomationRun { automation, run }))
}

#[tauri::command(async)]
pub fn automation_run_update(
    app: AppHandle,
    store: State<'_, SessionStore>,
    run_id: String,
    status: String,
    session_id: Option<String>,
    error: Option<String>,
    now: i64,
) -> Result<AutomationRun, String> {
    validate_id(&run_id, "automation run")?;
    if let Some(session_id) = session_id.as_deref() {
        validate_id(session_id, "session")?;
    }
    if !matches!(
        status.as_str(),
        "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled"
    ) {
        return Err("Invalid automation run status.".into());
    }
    let mut conn = store.lock_conn()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let raw = tx
        .query_row(
            "SELECT run_json FROM automation_runs WHERE id = ?1",
            [&run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Automation run not found.".to_string())?;
    let mut run: AutomationRun = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    run.status = status;
    if run.status == "running" && run.started_at.is_none() {
        run.started_at = Some(now);
    }
    if matches!(
        run.status.as_str(),
        "succeeded" | "failed" | "skipped" | "cancelled"
    ) {
        run.completed_at = Some(now);
    }
    if session_id.is_some() {
        run.session_id = session_id;
    }
    run.error = error.filter(|value| !value.trim().is_empty());
    let mut automation =
        get(&tx, &run.automation_id)?.ok_or_else(|| "Automation not found.".to_string())?;
    apply_run_summary(&mut automation, &run);
    write_run(&tx, &run)?;
    write_automation(&tx, &automation)?;
    trim_history(&tx, &run.automation_id)?;
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    if run.status == "running" && automation.keep_awake {
        awake::hold(&run.id);
    } else if run.status != "running" {
        awake::release(&run.id);
    }
    let _ = app.emit(CHANGED, ());
    Ok(run)
}

/// Keep the Mac awake while an automation run is active (#39). One
/// `caffeinate -i -w <MonoCode pid>` holds while any run that asked for it
/// is running, so it also ends if MonoCode quits. Started from an argument
/// list, never a shell. A no-op off macOS.
mod awake {
    use std::collections::HashSet;
    use std::process::Child;
    use std::sync::Mutex;

    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum Change {
        Start,
        Stop,
        Keep,
    }

    #[derive(Default)]
    pub(super) struct Holds {
        runs: HashSet<String>,
    }

    impl Holds {
        pub(super) fn hold(&mut self, run_id: &str) -> Change {
            let was_empty = self.runs.is_empty();
            self.runs.insert(run_id.to_string());
            if was_empty {
                Change::Start
            } else {
                Change::Keep
            }
        }

        pub(super) fn release(&mut self, run_id: &str) -> Change {
            if self.runs.remove(run_id) && self.runs.is_empty() {
                Change::Stop
            } else {
                Change::Keep
            }
        }
    }

    struct State {
        holds: Holds,
        child: Option<Child>,
    }

    static STATE: Mutex<Option<State>> = Mutex::new(None);

    fn with_state(apply: impl FnOnce(&mut State)) {
        let Ok(mut guard) = STATE.lock() else {
            return;
        };
        let state = guard.get_or_insert_with(|| State {
            holds: Holds::default(),
            child: None,
        });
        apply(state);
    }

    pub(super) fn hold(run_id: &str) {
        with_state(|state| {
            if state.holds.hold(run_id) == Change::Start && state.child.is_none() {
                state.child = spawn();
            }
        });
    }

    pub(super) fn release(run_id: &str) {
        with_state(|state| {
            if state.holds.release(run_id) == Change::Stop {
                if let Some(mut child) = state.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
    }

    #[cfg(target_os = "macos")]
    fn spawn() -> Option<Child> {
        std::process::Command::new("/usr/bin/caffeinate")
            .arg("-i")
            .arg("-w")
            .arg(std::process::id().to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()
    }

    #[cfg(not(target_os = "macos"))]
    fn spawn() -> Option<Child> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time_trigger(schedule_kind: &str, at: i64, interval_minutes: i64) -> AutomationTrigger {
        AutomationTrigger {
            id: "t".into(),
            kind: "time".into(),
            event: schedule_kind.into(),
            schedule_kind: schedule_kind.into(),
            minute: 0,
            time: "09:00".into(),
            day_of_week: 1,
            repos: Vec::new(),
            repo: String::new(),
            branch: String::new(),
            actor: default_actor(),
            at,
            interval_minutes,
        }
    }

    fn upsert(
        triggers: Vec<AutomationTrigger>,
        enabled: bool,
        next_run_at: i64,
    ) -> AutomationUpsert {
        serde_json::from_value(serde_json::json!({
            "id": "automation-id",
            "name": "Once",
            "prompt": "Run the tests",
            "harness": "codex",
            "model": "model",
            "cwd": "/tmp",
            "workspaceMode": "current",
            "runtimeMode": "auto",
            "scheduleKind": triggers.first().map(|t| t.schedule_kind.clone()).unwrap_or_else(|| "weekdays".into()),
            "minute": 0,
            "time": "09:00",
            "dayOfWeek": 1,
            "triggers": triggers,
            "missedRunGraceMinutes": 720,
            "enabled": enabled,
            "nextRunAt": next_run_at
        }))
        .unwrap()
    }

    #[test]
    fn accepts_one_time_and_interval_schedules() {
        let now = 1_000_000;
        assert!(validate_upsert(
            &upsert(
                vec![time_trigger("once", now + 60_000, 0)],
                true,
                now + 60_000
            ),
            now
        )
        .is_ok());
        assert!(validate_upsert(
            &upsert(vec![time_trigger("interval", 0, 30)], true, now + 1_800_000),
            now
        )
        .is_ok());
        // An interval outside 5 minutes to 30 days, and a one-time run with no moment.
        assert!(validate_upsert(
            &upsert(vec![time_trigger("interval", 0, 4)], true, now + 1),
            now
        )
        .is_err());
        assert!(validate_upsert(
            &upsert(vec![time_trigger("interval", 0, 43_201)], true, now + 1),
            now
        )
        .is_err());
        assert!(validate_upsert(
            &upsert(vec![time_trigger("once", 0, 0)], true, now + 1),
            now
        )
        .is_err());
        assert!(validate_upsert(
            &upsert(vec![time_trigger("monthly", 0, 0)], true, now + 1),
            now
        )
        .is_err());
    }

    #[test]
    fn a_spent_one_time_run_cannot_be_turned_back_on() {
        let now = 1_000_000;
        let past = vec![time_trigger("once", now - 1, 0)];
        assert!(validate_upsert(&upsert(past.clone(), true, now + 1), now).is_err());
        // Saved switched off, it is kept for its history.
        assert!(validate_upsert(&upsert(past.clone(), false, now + 1), now).is_ok());
        // Beside a recurring trigger it is just a spent line.
        let mut mixed = past;
        mixed.push(time_trigger("daily", 0, 0));
        assert!(validate_upsert(&upsert(mixed, true, now + 1), now).is_ok());
    }

    #[test]
    fn spent_and_live_one_time_triggers() {
        let once = time_trigger("once", 500, 0);
        assert!(trigger_live_from(&once, 500));
        assert!(!trigger_live_from(&once, 501));
        assert!(spent_after(std::slice::from_ref(&once), 500));
        assert!(!spent_after(std::slice::from_ref(&once), 499));
        assert!(!spent_after(
            &[once.clone(), time_trigger("hourly", 0, 0)],
            500
        ));
        let mut event = time_trigger("weekdays", 0, 0);
        event.kind = "github".into();
        assert!(!spent_after(&[once, event], 500));
        assert!(!spent_after(&[], 500));
    }

    fn claim_store(triggers: Vec<AutomationTrigger>, next_run_at: i64) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        let mut automation: Automation = serde_json::from_value(serde_json::json!({
            "id": "automation-id",
            "name": "Once",
            "prompt": "Run the tests",
            "harness": "codex",
            "model": "model",
            "cwd": "/tmp",
            "workspaceMode": "current",
            "reuseSession": false,
            "runtimeMode": "auto",
            "scheduleKind": "once",
            "minute": 0,
            "time": "09:00",
            "dayOfWeek": 1,
            "missedRunGraceMinutes": 720,
            "enabled": true,
            "nextRunAt": next_run_at,
            "createdAt": 1,
            "updatedAt": 1
        }))
        .unwrap();
        automation.triggers = Some(triggers);
        write_automation(&conn, &automation).unwrap();
        conn
    }

    #[test]
    fn live_check_refuses_a_spent_one_time_trigger_a_year_later() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("once", at, 0)], at);
        let automation = get(&conn, "automation-id").unwrap().unwrap();
        assert!(has_live_time_trigger(&automation, at));
        // The placeholder next run, a year on.
        assert!(!has_live_time_trigger(
            &automation,
            at + 365 * 24 * 3_600_000
        ));
        let interval = claim_store(vec![time_trigger("interval", 0, 30)], at);
        let automation = get(&interval, "automation-id").unwrap().unwrap();
        assert!(has_live_time_trigger(&automation, i64::MAX / 2));
    }

    #[test]
    fn refuses_a_fresh_worktree_in_a_repository_with_no_commits() {
        let dir = std::env::temp_dir().join(format!(
            "monocode-automation-unborn-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false)
        };
        if !git(&["init", "-b", "main"]) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let mut input = upsert(vec![time_trigger("weekdays", 0, 0)], true, 1);
        input.cwd = dir.to_string_lossy().into_owned();
        input.workspace_mode = "worktree".into();
        assert_eq!(
            refuse_unborn_worktree(&input).unwrap_err(),
            crate::worktrees::NO_COMMITS_MESSAGE
        );
        // The current working copy is fine, and so is switching it off.
        input.workspace_mode = "current".into();
        assert!(refuse_unborn_worktree(&input).is_ok());
        input.workspace_mode = "worktree".into();
        input.enabled = false;
        assert!(refuse_unborn_worktree(&input).is_ok());
        // After a first commit the worktree is allowed.
        input.enabled = true;
        assert!(git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "first"
        ]));
        assert!(refuse_unborn_worktree(&input).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keep_awake_holds_while_any_run_is_active() {
        let mut holds = awake::Holds::default();
        assert_eq!(holds.hold("a"), awake::Change::Start);
        assert_eq!(holds.hold("b"), awake::Change::Keep);
        assert_eq!(holds.hold("a"), awake::Change::Keep);
        assert_eq!(holds.release("a"), awake::Change::Keep);
        // Releasing a run that never held changes nothing.
        assert_eq!(holds.release("zzz"), awake::Change::Keep);
        assert_eq!(holds.release("b"), awake::Change::Stop);
        assert_eq!(holds.release("b"), awake::Change::Keep);
    }

    #[test]
    fn old_rows_read_without_the_new_fields() {
        let trigger: AutomationTrigger = serde_json::from_value(serde_json::json!({
            "kind": "time",
            "scheduleKind": "daily"
        }))
        .unwrap();
        assert_eq!(trigger.at, 0);
        assert_eq!(trigger.interval_minutes, 0);
        let automation = claim_store(vec![trigger], 1);
        let read = get(&automation, "automation-id").unwrap().unwrap();
        assert!(!read.keep_awake);
    }

    #[test]
    fn validates_time_fields() {
        assert!(valid_time("09:30"));
        assert!(valid_time("23:59"));
        assert!(!valid_time("24:00"));
        assert!(!valid_time("9:30"));
    }

    #[test]
    fn existing_automations_default_to_time_triggers() {
        let automation = Automation {
            id: "automation-id".into(),
            name: "Audit".into(),
            prompt: "Review the repository".into(),
            harness: "codex".into(),
            model: "model".into(),
            model_settings: HashMap::new(),
            cwd: "/tmp".into(),
            workspace_mode: "worktree".into(),
            worktree_cwd: String::new(),
            session_folder_id: String::new(),
            reuse_session: false,
            runtime_mode: "auto".into(),
            trigger_kind: "github".into(),
            trigger_event: "pull_request_opened".into(),
            schedule_kind: "weekdays".into(),
            minute: 0,
            time: "09:00".into(),
            day_of_week: 1,
            triggers: None,
            missed_run_grace_minutes: 720,
            keep_awake: false,
            enabled: true,
            next_run_at: 1,
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            last_session_id: None,
            created_at: 1,
            updated_at: 1,
        };
        let mut stored = serde_json::to_value(automation).unwrap();
        stored
            .as_object_mut()
            .unwrap()
            .remove("triggerKind")
            .unwrap();
        stored
            .as_object_mut()
            .unwrap()
            .remove("triggerEvent")
            .unwrap();

        let restored: Automation = serde_json::from_value(stored).unwrap();
        assert_eq!(restored.trigger_kind, "time");
        assert!(restored.trigger_event.is_empty());
    }

    #[test]
    fn missing_triggers_hydrate_from_legacy_fields() {
        let automation = Automation {
            id: "automation-id".into(),
            name: "Audit".into(),
            prompt: "Review the repository".into(),
            harness: "codex".into(),
            model: "model".into(),
            model_settings: HashMap::new(),
            cwd: "/tmp".into(),
            workspace_mode: "worktree".into(),
            worktree_cwd: String::new(),
            session_folder_id: String::new(),
            reuse_session: false,
            runtime_mode: "auto".into(),
            trigger_kind: "gitlab".into(),
            trigger_event: "merge_request_opened".into(),
            schedule_kind: "weekdays".into(),
            minute: 0,
            time: "09:00".into(),
            day_of_week: 1,
            triggers: None,
            missed_run_grace_minutes: 720,
            keep_awake: false,
            enabled: true,
            next_run_at: 1,
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            last_session_id: None,
            created_at: 1,
            updated_at: 1,
        };
        let mut stored = serde_json::to_value(&automation).unwrap();
        stored.as_object_mut().unwrap().remove("triggers");
        let mut restored: Automation = serde_json::from_value(stored).unwrap();
        assert!(restored.triggers.is_none());
        hydrate_triggers(&mut restored);
        let triggers = restored.triggers.as_ref().unwrap();
        assert_eq!(triggers.len(), 1);
        assert_eq!(triggers[0].kind, "gitlab");
        assert_eq!(triggers[0].event, "merge_request_opened");
    }

    #[test]
    fn empty_triggers_stay_empty() {
        let mut restored: Automation = serde_json::from_value(serde_json::json!({
            "id": "automation-id",
            "name": "Audit",
            "prompt": "Review the repository",
            "harness": "codex",
            "model": "model",
            "cwd": "/tmp",
            "workspaceMode": "worktree",
            "reuseSession": false,
            "runtimeMode": "auto",
            "triggerKind": "time",
            "triggerEvent": "",
            "scheduleKind": "weekdays",
            "minute": 0,
            "time": "09:00",
            "dayOfWeek": 1,
            "triggers": [],
            "missedRunGraceMinutes": 720,
            "enabled": true,
            "nextRunAt": 1,
            "createdAt": 1,
            "updatedAt": 1
        }))
        .unwrap();
        hydrate_triggers(&mut restored);
        assert!(restored.triggers.as_ref().unwrap().is_empty());
    }

    #[test]
    fn trims_run_history_to_the_configured_limit() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at)
             VALUES ('automation-id', '{}', 1, 1, 1)",
            [],
        )
        .unwrap();
        for index in 0..=MAX_RUNS_PER_AUTOMATION {
            let run = AutomationRun {
                id: format!("run-{index}"),
                automation_id: "automation-id".into(),
                trigger: "manual".into(),
                scheduled_for: index,
                created_at: index,
                started_at: None,
                completed_at: Some(index),
                status: "succeeded".into(),
                session_id: None,
                error: None,
                event_key: None,
                event_kind: None,
                event: None,
                prompt: Some("Run the automation".into()),
            };
            write_run(&conn, &run).unwrap();
        }

        trim_history(&conn, "automation-id").unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM automation_runs WHERE automation_id = 'automation-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, MAX_RUNS_PER_AUTOMATION);
    }

    #[test]
    fn trim_history_preserves_nonterminal_runs() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at)
             VALUES ('automation-id', '{}', 1, 1, 1)",
            [],
        )
        .unwrap();
        for index in 0..=MAX_RUNS_PER_AUTOMATION {
            let run = AutomationRun {
                id: format!("run-{index}"),
                automation_id: "automation-id".into(),
                trigger: "manual".into(),
                scheduled_for: index,
                created_at: index,
                started_at: None,
                completed_at: None,
                status: "pending".into(),
                session_id: None,
                error: None,
                event_key: None,
                event_kind: None,
                event: None,
                prompt: Some("Run the automation".into()),
            };
            write_run(&conn, &run).unwrap();
        }

        trim_history(&conn, "automation-id").unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM automation_runs WHERE automation_id = 'automation-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, MAX_RUNS_PER_AUTOMATION + 1);
    }

    #[test]
    fn accepts_inbox_event_keys() {
        assert!(validate_event_key("github:pr:acme/web:12").is_ok());
        assert!(validate_event_key("linear:issue:eng-12").is_ok());
        assert!(validate_event_key("jira:issue:10042").is_ok());
        assert!(validate_event_key("azuredevops:pr:acme/web:12").is_ok());
        assert!(validate_event_key("").is_err());
        assert!(validate_event_key("github:pr:acme web:12").is_err());
    }

    #[test]
    fn accepts_jira_triggers() {
        let trigger = trigger_from_fields(
            "jira-trigger",
            "jira",
            "issue_created",
            "weekdays",
            0,
            "09:00",
            1,
        );
        assert!(validate_trigger(&trigger).is_ok());
    }

    #[test]
    fn accepts_azure_devops_triggers() {
        let trigger = trigger_from_fields(
            "trigger-id",
            "azuredevops",
            "pull_request_appeared",
            "weekdays",
            0,
            "09:00",
            1,
        );
        assert!(validate_trigger(&trigger).is_ok());
    }

    #[test]
    fn claims_each_event_key_once() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO automations (id, definition_json, enabled, next_run_at, updated_at)
             VALUES ('automation-id', '{}', 1, 1, 1)",
            [],
        )
        .unwrap();
        let claim = || {
            conn.execute(
                "INSERT OR IGNORE INTO automation_event_claims
                 (automation_id, event_key, created_at) VALUES (?1, ?2, ?3)",
                params!["automation-id", "github:pr:acme/web:12", 1],
            )
            .unwrap()
        };

        assert_eq!(claim(), 1);
        assert_eq!(claim(), 0);
    }

    fn pending_run(id: &str, trigger: &str, scheduled_for: i64) -> AutomationRun {
        let mut run = new_run(
            "automation-id",
            trigger,
            scheduled_for,
            scheduled_for,
            "Run it",
        );
        run.id = id.into();
        run
    }

    fn run_status(conn: &Connection, id: &str) -> (String, Option<String>) {
        let raw: String = conn
            .query_row(
                "SELECT run_json FROM automation_runs WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        let run: AutomationRun = serde_json::from_str(&raw).unwrap();
        (run.status, run.error)
    }

    fn set_enabled(conn: &Connection, enabled: bool) {
        let mut automation = get(conn, "automation-id").unwrap().unwrap();
        automation.enabled = enabled;
        write_automation(conn, &automation).unwrap();
    }

    // Mac test 2.13: after a relaunch a claimed one-time run sat Pending, and
    // an interval catch-up ran at reload although switched off.
    #[test]
    fn a_pending_run_starts_once() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("interval", 0, 30)], at);
        write_run(&conn, &pending_run("run-1", "scheduled", at)).unwrap();
        let first = begin_run(&conn, "run-1", at + 5).unwrap();
        assert!(first.is_some());
        assert_eq!(run_status(&conn, "run-1").0, "running");
        // The startup recovery and the pending sweep both pick it up.
        assert!(begin_run(&conn, "run-1", at + 6).unwrap().is_none());
        assert!(begin_run(&conn, "no-such-run", at + 6).unwrap().is_none());
    }

    #[test]
    fn a_switched_off_automation_skips_its_pending_catch_up() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("interval", 0, 30)], at);
        write_run(&conn, &pending_run("run-1", "scheduled", at)).unwrap();
        set_enabled(&conn, false);
        assert!(begin_run(&conn, "run-1", at + 60_000).unwrap().is_none());
        let (status, error) = run_status(&conn, "run-1");
        assert_eq!(status, "skipped");
        assert_eq!(error.as_deref(), Some(SWITCHED_OFF));
        let automation = get(&conn, "automation-id").unwrap().unwrap();
        assert_eq!(automation.last_run_status.as_deref(), Some("skipped"));
    }

    #[test]
    fn switching_off_skips_every_pending_run_and_leaves_running_ones() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("interval", 0, 30)], at);
        write_run(&conn, &pending_run("run-1", "scheduled", at)).unwrap();
        write_run(&conn, &pending_run("run-2", "event", at)).unwrap();
        let mut running = pending_run("run-3", "scheduled", at);
        running.status = "running".into();
        write_run(&conn, &running).unwrap();
        let mut automation = get(&conn, "automation-id").unwrap().unwrap();
        automation.enabled = false;
        assert!(skip_pending_runs(&conn, &mut automation, at + 1).unwrap());
        assert_eq!(run_status(&conn, "run-1").0, "skipped");
        assert_eq!(run_status(&conn, "run-2").0, "skipped");
        assert_eq!(run_status(&conn, "run-3").0, "running");
        assert!(pending_runs(&conn, i64::MAX).unwrap().is_empty());
    }

    #[test]
    fn a_one_time_run_inside_its_grace_runs_once_after_turning_itself_off() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("once", at, 0)], at);
        // Claiming the one-time run turns the automation off by itself.
        set_enabled(&conn, false);
        write_run(&conn, &pending_run("run-1", "scheduled", at)).unwrap();
        assert!(begin_run(&conn, "run-1", at + 6 * 60_000)
            .unwrap()
            .is_some());
        assert_eq!(run_status(&conn, "run-1").0, "running");
        assert!(begin_run(&conn, "run-1", at + 7 * 60_000)
            .unwrap()
            .is_none());
        // A one-time run for another moment is not the self-disabled run.
        write_run(&conn, &pending_run("run-2", "scheduled", at + 5)).unwrap();
        assert!(begin_run(&conn, "run-2", at + 7 * 60_000)
            .unwrap()
            .is_none());
        assert_eq!(run_status(&conn, "run-2").0, "skipped");
    }

    // Security fix F8: a claimed one-time run could not be stopped, because
    // claiming it had already switched the automation off.
    #[test]
    fn saving_a_spent_one_time_automation_off_cancels_its_pending_run() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("once", at, 0)], at);
        set_enabled(&conn, false);
        write_run(&conn, &pending_run("run-1", "scheduled", at)).unwrap();
        write_run(&conn, &pending_run("manual", "manual", at)).unwrap();
        let input = upsert(vec![time_trigger("once", at, 0)], false, at);
        let triggers = Some(normalize_triggers(&input));
        let saved = save_automation(&conn, input, triggers, at + 1).unwrap();
        assert!(!saved.enabled);
        let (status, error) = run_status(&conn, "run-1");
        assert_eq!(status, "skipped");
        assert_eq!(error.as_deref(), Some(CANCELLED));
        assert!(begin_run(&conn, "run-1", at + 2).unwrap().is_none());
        // The user's own Run now click is not cancelled by a save.
        assert_eq!(run_status(&conn, "manual").0, "pending");
        let automation = get(&conn, "automation-id").unwrap().unwrap();
        assert_eq!(automation.last_run_error.as_deref(), Some(CANCELLED));
    }

    #[test]
    fn saving_it_on_again_leaves_the_pending_run_to_start() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("once", at, 0)], at);
        set_enabled(&conn, false);
        write_run(&conn, &pending_run("run-1", "scheduled", at)).unwrap();
        let input = upsert(
            vec![time_trigger("once", at + 600_000, 0)],
            true,
            at + 600_000,
        );
        let triggers = Some(normalize_triggers(&input));
        save_automation(&conn, input, triggers, at + 1).unwrap();
        assert_eq!(run_status(&conn, "run-1").0, "pending");
    }

    #[test]
    fn deleting_an_automation_stops_its_pending_run() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("once", at, 0)], at);
        set_enabled(&conn, false);
        write_run(&conn, &pending_run("run-1", "scheduled", at)).unwrap();
        delete_automation(&conn, "automation-id").unwrap();
        assert!(get(&conn, "automation-id").unwrap().is_none());
        assert!(begin_run(&conn, "run-1", at + 2).unwrap().is_none());
        assert!(pending_runs(&conn, i64::MAX).unwrap().is_empty());
    }

    #[test]
    fn a_manual_run_starts_while_switched_off() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("interval", 0, 30)], at);
        set_enabled(&conn, false);
        write_run(&conn, &pending_run("run-1", "manual", at)).unwrap();
        assert!(begin_run(&conn, "run-1", at + 1).unwrap().is_some());
    }

    #[test]
    fn pending_runs_lists_only_pending_runs_up_to_the_cutoff() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("interval", 0, 30)], at);
        write_run(&conn, &pending_run("old", "scheduled", at)).unwrap();
        write_run(&conn, &pending_run("new", "scheduled", at + 100)).unwrap();
        let mut done = pending_run("done", "scheduled", at);
        done.status = "succeeded".into();
        write_run(&conn, &done).unwrap();
        let ids: Vec<String> = pending_runs(&conn, at + 50)
            .unwrap()
            .into_iter()
            .map(|run| run.id)
            .collect();
        assert_eq!(ids, vec!["old".to_string()]);
    }

    // Security fix R7: a pending run can be cancelled from Run history,
    // also the one run of a one-time automation that turned itself off.
    #[test]
    fn cancelling_a_pending_run_stops_it_and_leaves_others_alone() {
        let at = 1_000;
        let conn = claim_store(vec![time_trigger("once", at, 0)], at);
        set_enabled(&conn, false);
        write_run(&conn, &pending_run("run-1", "scheduled", at)).unwrap();
        write_run(&conn, &pending_run("manual", "manual", at)).unwrap();
        let mut running = pending_run("run-2", "scheduled", at);
        running.status = "running".into();
        write_run(&conn, &running).unwrap();

        assert!(cancel_run(&conn, "run-1", at + 1).unwrap());
        let (status, error) = run_status(&conn, "run-1");
        assert_eq!(status, "skipped");
        assert_eq!(error.as_deref(), Some(CANCELLED));
        // It can no longer start, and a second cancel does nothing.
        assert!(begin_run(&conn, "run-1", at + 2).unwrap().is_none());
        assert!(!cancel_run(&conn, "run-1", at + 3).unwrap());
        assert_eq!(run_status(&conn, "run-1").0, "skipped");
        // A manual run is pending too and can be cancelled.
        assert!(cancel_run(&conn, "manual", at + 4).unwrap());
        assert_eq!(run_status(&conn, "manual").0, "skipped");
        // A started run and an unknown id are left alone.
        assert!(!cancel_run(&conn, "run-2", at + 5).unwrap());
        assert_eq!(run_status(&conn, "run-2").0, "running");
        assert!(!cancel_run(&conn, "no-such-run", at + 6).unwrap());
        let automation = get(&conn, "automation-id").unwrap().unwrap();
        assert_eq!(automation.last_run_status.as_deref(), Some("skipped"));
    }
}
