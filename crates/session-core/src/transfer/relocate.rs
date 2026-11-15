//! Move a project directory on this machine and point the AI tools at the new
//! location, so its sessions stay listed and resumable there.
//!
//! The same path rewrite as an import with path remapping ([`Remap`]), applied
//! in place:
//! - Claude: `~/.claude/projects/<encoded>` is renamed to the encoding of the
//!   new path (merged when it already exists), transcript `cwd` rows and
//!   `sessions-index.json` follow; `~/.claude.json` project settings and the
//!   prompt history (`history.jsonl`) are re-keyed.
//! - Codex: rollout `cwd` fields, `threads.cwd` in state_5.sqlite, trust
//!   entries (`[projects."<path>"]`) in config.toml and the Desktop
//!   workspace roots.
//! - Grok / OMP: session `cwd` fields; their per-project directories are
//!   renamed when the directory name is verifiably derived from the cwd.
//! - Viewer bookmarks.
//!
//! Every step is idempotent: records that already point at the new location
//! no longer match the old path, so an interrupted move can simply be run
//! again with "the folder was already moved".

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde_json::{json, Value};

use super::archive::{self, Remap};
use super::export::{claude_project_path, project_infos};
use super::import::{move_path, rewrite_jsonl, write_json_atomic};
use super::{
    walk_files, JobHandle, RelocatePreview, RelocatePreviewProject, RelocatePreviewSource,
    RelocateReport, RelocateRequest, RelocateSourceReport, CANCELLED,
};
use crate::paths::SessionSourceKind;
use crate::provider::{claude, codex, grok, omp};
use crate::provider_sync::{config as codex_config, global_state, rollout, sqlite_state};

const MAX_REPORTED_ERRORS: usize = 50;
/// `history.jsonl` rows name their project in `project`.
fn rewrite_history_project(row: &mut Value, remap: &Remap) -> bool {
    match row.get_mut("project") {
        Some(Value::String(project)) => match remap.apply(project) {
            Some(next) if next != *project => {
                *project = next;
                true
            }
            _ => false,
        },
        _ => false,
    }
}

// ── Validation ──

fn trimmed(path: &str) -> &str {
    path.trim()
}

/// Check the request and build the path rewrite. `for_run` adds the checks
/// that only matter when the folder is actually moved.
pub(super) fn validate(request: &RelocateRequest, for_run: bool) -> Result<Remap, String> {
    let from = trimmed(&request.from);
    let to = trimmed(&request.to);
    if from.is_empty() || to.is_empty() {
        return Err("请填写原目录和新位置".to_string());
    }
    for path in [from, to] {
        if !Path::new(path).is_absolute() {
            return Err(format!("必须是绝对路径：{path}"));
        }
    }
    if Path::new(from).parent().is_none() {
        return Err("不能移动磁盘根目录".to_string());
    }
    if archive::remap_path(to, from, to).is_some() {
        return Err("新位置不能是原目录本身或它的子目录".to_string());
    }
    // Moving a folder that holds the tools' own data would pull it away
    // from under them.
    let data_dirs = [
        dirs::home_dir(),
        crate::parser::path_encoder::get_claude_home(),
        codex::get_codex_home(),
        grok::get_sessions_dir(),
        omp::get_sessions_dir(),
        crate::app_dir::get_app_dir(),
    ];
    for dir in data_dirs.into_iter().flatten() {
        if archive::remap_path(&dir.to_string_lossy(), from, to).is_some() {
            return Err(format!("该目录包含用户目录或 AI 工具的数据目录（{}），不能移动", dir.display()));
        }
    }

    if for_run && request.move_folder {
        let source = Path::new(from);
        let meta = fs::symlink_metadata(source).map_err(|_| format!("原目录不存在：{from}"))?;
        if meta.file_type().is_symlink() {
            return Err("原目录是符号链接，请移动它指向的真实目录".to_string());
        }
        if !meta.is_dir() {
            return Err(format!("原路径不是目录：{from}"));
        }
        let target = Path::new(to);
        if fs::symlink_metadata(target).is_ok() {
            return Err(format!("新位置已存在：{to}。若已手动移动文件夹，请选择「文件夹已手动移动」"));
        }
        match target.parent() {
            Some(parent) if parent.is_dir() => {}
            _ => return Err(format!("新位置的上级目录不存在：{to}")),
        }
    }
    Ok(Remap {
        from: from.to_string(),
        to: to.to_string(),
    })
}

/// Like [`Remap::apply`], but keeps `/` separators for Windows paths written
/// that way (Claude's `~/.claude.json` keys), so the key style does not change.
fn remap_keep_style(remap: &Remap, value: &str) -> Option<String> {
    let next = remap.apply(value)?;
    let bytes = value.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if drive && value.contains('/') && !value.contains('\\') {
        Some(next.replace('\\', "/"))
    } else {
        Some(next)
    }
}

// ── Plan ──

struct ClaudeMove {
    name: String,
    dir: PathBuf,
    path: String,
    new_path: String,
    new_name: String,
    sessions: usize,
    /// Transcripts (incl. sub-agents) below `dir`, relative to it.
    jsonl: Vec<(PathBuf, u64)>,
}

struct CodexRollout {
    path: PathBuf,
    cwd: String,
    new_cwd: String,
    size: u64,
}

/// A Grok session directory or an OMP session file.
struct DirSession {
    /// Grok: session directory; OMP: session file.
    unit: PathBuf,
    /// The per-project directory holding `unit`, if not the source root.
    project_dir: Option<PathBuf>,
    cwd: String,
    new_cwd: String,
    /// Transcripts to rewrite and their total size (progress only).
    files: usize,
    size: u64,
}

#[derive(Default)]
struct Plan {
    claude: Vec<ClaudeMove>,
    codex: Vec<CodexRollout>,
    grok: Vec<DirSession>,
    omp: Vec<DirSession>,
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn jsonl_files(dir: &Path) -> Vec<PathBuf> {
    walk_files(dir)
        .into_iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .collect()
}

/// Whether a JSONL transcript (or a JSON document) still has a path field
/// pointing at the old location. Mentions in message bodies do not count.
fn has_stale_paths(path: &Path, remap: &Remap) -> bool {
    use std::io::BufRead;
    let needle = remap.needle();
    let stale = |text: &str| {
        text.contains(&needle)
            && serde_json::from_str::<Value>(text.trim())
                .is_ok_and(|mut row| archive::rewrite_cwd_fields(&mut row, remap))
    };
    if path.extension().is_some_and(|ext| ext == "json") {
        return fs::read_to_string(path).is_ok_and(|text| stale(&text));
    }
    let Ok(file) = File::open(path) else {
        return false;
    };
    std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .any(|line| stale(&line))
}

/// New path for a recorded project `path`: its remapped value, or — when a
/// previous run already moved it (path below `to`) but `files` still record
/// the old location — the path itself, so a re-run finishes the rewrite.
fn target_path(path: &str, remap: &Remap, files: &[PathBuf]) -> Option<String> {
    if let Some(next) = remap.apply(path) {
        return Some(next);
    }
    let leftover = archive::remap_path(path, &remap.to, &remap.to).is_some()
        && files.iter().any(|file| has_stale_paths(file, remap));
    leftover.then(|| path.to_string())
}

fn plan_claude(remap: &Remap) -> Vec<ClaudeMove> {
    let Some(root) = archive::source_root(SessionSourceKind::Claude) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let infos = project_infos(claude::get_projects());
    let mut moves = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|ty| ty.is_dir()) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let dir = entry.path();
        let mut transcripts: Vec<PathBuf> = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|child| child.file_type().is_ok_and(|ty| ty.is_file()))
            .map(|child| child.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .collect();
        transcripts.sort();
        let Some(path) = claude_project_path(&dir, &transcripts, infos.get(&name)) else {
            continue;
        };
        let files = jsonl_files(&dir);
        let Some(new_path) = target_path(&path, remap, &files) else {
            continue;
        };
        let jsonl = files
            .into_iter()
            .filter_map(|file| {
                let size = file_size(&file);
                Some((file.strip_prefix(&dir).ok()?.to_path_buf(), size))
            })
            .collect();
        moves.push(ClaudeMove {
            new_name: crate::parser::path_encoder::encode_project_path(&new_path),
            name,
            dir,
            path,
            new_path,
            sessions: transcripts.len(),
            jsonl,
        });
    }
    moves.sort_by(|a, b| a.path.cmp(&b.path));
    moves
}

fn plan_codex(remap: &Remap) -> Vec<CodexRollout> {
    let Some(home) = codex::get_codex_home() else {
        return Vec::new();
    };
    let mut files = rollout::scan_session_dir(&home.join("sessions"));
    files.extend(rollout::scan_session_dir(&home.join("archived_sessions")));
    let mut rollouts: Vec<CodexRollout> = files
        .into_par_iter()
        .filter_map(|path| {
            let meta = rollout::read_meta(&path, false)?;
            let cwd = meta.cwd?;
            let new_cwd = target_path(&cwd, remap, std::slice::from_ref(&path))?;
            Some(CodexRollout {
                size: file_size(&path),
                path,
                cwd,
                new_cwd,
            })
        })
        .collect();
    rollouts.sort_by(|a, b| a.path.cmp(&b.path));
    rollouts
}

fn omp_artifacts(file: &Path) -> PathBuf {
    file.with_extension("")
}

/// Transcripts of a Grok session directory or an OMP session file.
fn session_transcripts(source: &str, unit: &Path) -> Vec<PathBuf> {
    match source {
        "grok" => jsonl_files(unit),
        _ => {
            let mut files = vec![unit.to_path_buf()];
            files.extend(jsonl_files(&omp_artifacts(unit)));
            files
        }
    }
}

fn dir_session(source: &str, root: &Path, unit: PathBuf, cwd: String, remap: &Remap) -> Option<DirSession> {
    let mut transcripts = session_transcripts(source, &unit);
    if source == "grok" {
        transcripts.push(unit.join("summary.json"));
    }
    let new_cwd = target_path(&cwd, remap, &transcripts)?;
    transcripts.retain(|file| file.extension().is_some_and(|ext| ext == "jsonl"));
    let project_dir = unit
        .parent()
        .filter(|parent| *parent != root)
        .map(Path::to_path_buf);
    Some(DirSession {
        files: transcripts.len(),
        size: transcripts.iter().map(|file| file_size(file)).sum(),
        unit,
        project_dir,
        cwd,
        new_cwd,
    })
}

fn plan_grok(remap: &Remap) -> Vec<DirSession> {
    let Some(root) = grok::get_sessions_dir() else {
        return Vec::new();
    };
    grok::session_dirs()
        .into_iter()
        .filter_map(|dir| {
            let meta = grok::extract_session_meta(&dir.join("chat_history.jsonl"))?;
            let cwd = meta.cwd.filter(|cwd| !cwd.is_empty())?;
            dir_session("grok", &root, dir, cwd, remap)
        })
        .collect()
}

fn plan_omp(remap: &Remap) -> Vec<DirSession> {
    let Some(root) = omp::get_sessions_dir() else {
        return Vec::new();
    };
    omp::session_files()
        .into_iter()
        .filter_map(|file| {
            let meta = omp::extract_session_meta(&file)?;
            dir_session("omp", &root, file, meta.cwd, remap)
        })
        .collect()
}

fn build_plan(remap: &Remap) -> Plan {
    Plan {
        claude: plan_claude(remap),
        codex: plan_codex(remap),
        grok: plan_grok(remap),
        omp: plan_omp(remap),
    }
}

// ── Per-project directory names of Grok / OMP ──

/// Grok names project directories after the percent-encoded cwd. Two common
/// encoder flavours are tried; the one that reproduces the existing name wins.
fn grok_dir_names(path: &str) -> [String; 2] {
    let encode = |keep: &dyn Fn(u8) -> bool| {
        let mut out = String::new();
        for byte in path.bytes() {
            if byte.is_ascii_alphanumeric() || keep(byte) {
                out.push(byte as char);
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    };
    [
        encode(&|b| matches!(b, b'-' | b'_' | b'.' | b'~')),
        encode(&|b| matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')),
    ]
}

/// OMP: `--<cwd without leading separator, separators and `:` as `-`>--`.
fn omp_dir_names(path: &str) -> [String; 1] {
    [format!(
        "--{}--",
        path.trim_start_matches(['/', '\\']).replace(['/', '\\', ':'], "-")
    )]
}

/// The directory name the tool would use for `new_cwd`, provided the current
/// name is reproduced by the same rule from `cwd`.
fn renamed_dir<const N: usize>(
    current: &str,
    cwd: &str,
    new_cwd: &str,
    names: fn(&str) -> [String; N],
) -> Option<String> {
    let index = names(cwd).iter().position(|name| name == current)?;
    let next = names(new_cwd).into_iter().nth(index)?;
    (next != current && archive::split_rel(&next).is_ok_and(|parts| parts.len() == 1)).then_some(next)
}

// ── File rewriting ──

/// Apply `rewrite` to the rows of one JSONL file in place (temporary
/// sibling + rename), keeping its mtime. Files without matching lines are left
/// untouched. Returns the number of rewritten lines.
fn rewrite_file(
    path: &Path,
    remap: &Remap,
    rewrite: fn(&mut Value, &Remap) -> bool,
    job: &JobHandle,
) -> Result<usize, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("无效的文件名")?;
    let temporary = path.with_file_name(format!(".{name}.asv-relocate"));
    let mtime = fs::metadata(path).and_then(|meta| meta.modified()).ok();
    let input = File::open(path).map_err(|e| format!("打开 {} 失败：{e}", path.display()))?;
    let output = File::create(&temporary).map_err(|e| format!("创建 {} 失败：{e}", temporary.display()))?;
    let mut writer = BufWriter::new(output);
    let result = rewrite_jsonl(input, &mut writer, remap, rewrite, job).and_then(|counts| {
        writer.flush()?;
        Ok(counts)
    });
    drop(writer);
    let outcome = match result {
        Ok((_, 0)) => Ok(0),
        Ok((read, changed)) => {
            // A CLI still appending to the transcript would lose those lines.
            if file_size(path) != read {
                Err(format!("{} 在改写期间被其他程序写入，已跳过", path.display()))
            } else {
                fs::rename(&temporary, path)
                    .map(|_| changed)
                    .map_err(|e| format!("保存 {} 失败：{e}", path.display()))
            }
        }
        Err(e) if e.to_string() == CANCELLED => Err(CANCELLED.to_string()),
        Err(e) => Err(format!("改写 {} 失败：{e}", path.display())),
    };
    if !matches!(outcome, Ok(changed) if changed > 0) {
        let _ = fs::remove_file(&temporary);
    }
    if let (Ok(changed), Some(mtime)) = (&outcome, mtime) {
        if *changed > 0 {
            let _ = filetime::set_file_mtime(path, filetime::FileTime::from_system_time(mtime));
        }
    }
    job.update(|job| job.processed_files += 1);
    outcome
}

/// Rewrite the cwd fields of a whole-file JSON document (Grok `summary.json`).
fn rewrite_json_file(path: &Path, remap: &Remap) -> Result<bool, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(false);
    };
    if !archive::rewrite_cwd_fields(&mut value, remap) {
        return Ok(false);
    }
    let mtime = fs::metadata(path).and_then(|meta| meta.modified()).ok();
    write_json_atomic(path, &value)?;
    if let Some(mtime) = mtime {
        let _ = filetime::set_file_mtime(path, filetime::FileTime::from_system_time(mtime));
    }
    Ok(true)
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("{} 无法解析：{e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取 {} 失败：{e}", path.display())),
    }
}

/// Re-key the entries of a JSON object whose keys are paths; keys whose new
/// path already exists are left alone.
fn remap_object_keys(object: &mut serde_json::Map<String, Value>, remap: &Remap) -> u32 {
    let keys: Vec<String> = object.keys().cloned().collect();
    let mut moved = 0;
    for key in keys {
        let Some(next) = remap_keep_style(remap, &key).filter(|next| *next != key) else {
            continue;
        };
        if object.contains_key(&next) {
            continue;
        }
        if let Some(value) = object.remove(&key) {
            object.insert(next, value);
            moved += 1;
        }
    }
    moved
}

fn claude_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude.json"))
}

fn claude_history_path() -> Option<PathBuf> {
    crate::parser::path_encoder::get_claude_home().map(|home| home.join("history.jsonl"))
}

/// Re-key `projects` of `~/.claude.json` (per-project settings, trust,
/// MCP servers). Returns how many entries were (or would be) moved.
fn remap_claude_config(remap: &Remap, dry_run: bool) -> Result<u32, String> {
    let Some(path) = claude_config_path() else {
        return Ok(0);
    };
    let Some(mut config) = read_json(&path)? else {
        return Ok(0);
    };
    let Some(projects) = config.get_mut("projects").and_then(Value::as_object_mut) else {
        return Ok(0);
    };
    let moved = remap_object_keys(projects, remap);
    if moved > 0 && !dry_run {
        let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        let temporary = path.with_extension("json.asv-relocate");
        fs::write(&temporary, text).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
        fs::rename(&temporary, &path).map_err(|e| {
            let _ = fs::remove_file(&temporary);
            format!("保存 {} 失败：{e}", path.display())
        })?;
    }
    Ok(moved)
}

// ── Preview ──

fn grouped(items: impl IntoIterator<Item = (String, String)>) -> Vec<RelocatePreviewProject> {
    let mut by_path: HashMap<(String, String), usize> = HashMap::new();
    for key in items {
        *by_path.entry(key).or_default() += 1;
    }
    let mut projects: Vec<RelocatePreviewProject> = by_path
        .into_iter()
        .map(|((from, to), session_count)| RelocatePreviewProject {
            from,
            to,
            session_count,
        })
        .collect();
    projects.sort_by(|a, b| a.from.cmp(&b.from));
    projects
}

fn preview_source(source: &str, projects: Vec<RelocatePreviewProject>) -> Option<RelocatePreviewSource> {
    (!projects.is_empty()).then(|| RelocatePreviewSource {
        source: source.to_string(),
        session_count: projects.iter().map(|p| p.session_count).sum(),
        projects,
    })
}

fn count_bookmarks(plan: &Plan, remap: &Remap) -> Result<u32, String> {
    let claude_names: Vec<&str> = plan.claude.iter().map(|mv| mv.name.as_str()).collect();
    Ok(crate::bookmarks::load_bookmarks()?
        .bookmarks
        .iter()
        .filter(|b| match b.source.as_str() {
            "claude" => claude_names.contains(&b.project_id.as_str()),
            _ => remap.apply(&b.project_id).is_some(),
        })
        .count() as u32)
}

pub(super) fn preview(request: &RelocateRequest) -> Result<RelocatePreview, String> {
    let remap = validate(request, false)?;
    let plan = build_plan(&remap);
    let mut warnings = Vec::new();

    let claude = grouped(plan.claude.iter().flat_map(|mv| {
        std::iter::repeat_n((mv.path.clone(), mv.new_path.clone()), mv.sessions)
    }));
    let codex_rows = plan.codex.iter().map(|r| (r.cwd.clone(), r.new_cwd.clone()));
    let grok_rows = plan.grok.iter().map(|s| (s.cwd.clone(), s.new_cwd.clone()));
    let omp_rows = plan.omp.iter().map(|s| (s.cwd.clone(), s.new_cwd.clone()));
    let sources: Vec<RelocatePreviewSource> = [
        preview_source("claude", claude),
        preview_source("codex", grouped(codex_rows)),
        preview_source("grok", grouped(grok_rows)),
        preview_source("omp", grouped(omp_rows)),
    ]
    .into_iter()
    .flatten()
    .collect();

    if let Some(target) = root_conflict(&plan) {
        warnings.push(format!(
            "Claude 已有新位置的项目目录（{target}），会话会合并进去，同名文件保留原位置"
        ));
    }

    let claude_config_entries = remap_claude_config(&remap, true).unwrap_or_else(|e| {
        warnings.push(e);
        0
    });
    let (codex_trust_entries, codex_thread_rows) = match codex::get_codex_home() {
        Some(home) => (
            codex_config::remap_project_entries(&home.join("config.toml"), |v| remap.apply(v), true)
                .unwrap_or_else(|e| {
                    warnings.push(e);
                    0
                }),
            {
                let db = sqlite_state::db_path(&home);
                if db.is_file() {
                    sqlite_state::remap_thread_cwds(&db, |v| remap.apply(v), true).unwrap_or(0)
                } else {
                    0
                }
            },
        ),
        None => (0, 0),
    };

    Ok(RelocatePreview {
        from_exists: Path::new(&remap.from).is_dir(),
        to_exists: fs::symlink_metadata(&remap.to).is_ok(),
        bookmarks: count_bookmarks(&plan, &remap)?,
        from: remap.from.clone(),
        to: remap.to.clone(),
        sources,
        claude_config_entries,
        codex_trust_entries,
        codex_thread_rows,
        warnings,
    })
}

/// First Claude project whose new directory already exists.
fn root_conflict(plan: &Plan) -> Option<String> {
    let root = archive::source_root(SessionSourceKind::Claude)?;
    plan.claude
        .iter()
        .find(|mv| !mv.new_name.eq_ignore_ascii_case(&mv.name) && root.join(&mv.new_name).exists())
        .map(|mv| mv.new_name.clone())
}

// ── Run ──

struct Relocator<'a> {
    job: &'a JobHandle,
    remap: Remap,
    report: RelocateReport,
    /// Old → new path of moved session files (for bookmarks).
    moved_files: HashMap<PathBuf, PathBuf>,
    /// Claude: old → new project directory name.
    claude_names: HashMap<String, String>,
}

impl Relocator<'_> {
    fn error(&mut self, message: String) {
        if self.report.errors.len() < MAX_REPORTED_ERRORS {
            self.report.errors.push(message);
        }
    }

    fn check_cancel(&self) -> Result<(), String> {
        if self.job.cancelled() {
            Err(CANCELLED.to_string())
        } else {
            Ok(())
        }
    }

    /// Rewrite one transcript; a cancel aborts the run, other errors are
    /// reported and the file is counted as failed.
    fn rewrite(&mut self, path: &Path, source: &mut RelocateSourceReport) -> Result<(), String> {
        self.job
            .update(|job| job.current_item = Some(path.to_string_lossy().into_owned()));
        match rewrite_file(path, &self.remap, archive::rewrite_cwd_fields, self.job) {
            Ok(0) => Ok(()),
            Ok(_) => {
                source.rewritten_files += 1;
                Ok(())
            }
            Err(error) if error == CANCELLED => Err(error),
            Err(error) => {
                source.failed += 1;
                self.error(error);
                Ok(())
            }
        }
    }

    fn backup(&mut self) -> Result<(), String> {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let dir = crate::app_dir::get_app_dir()
            .ok_or("无法确定应用数据目录")?
            .join("transfer")
            .join("backups")
            .join(format!("relocate-{stamp}"));
        let mut files: Vec<(PathBuf, &str)> = Vec::new();
        if let Some(path) = claude_config_path() {
            files.push((path, "claude/.claude.json"));
        }
        if let Some(path) = claude_history_path() {
            files.push((path, "claude/history.jsonl"));
        }
        if let Some(home) = codex::get_codex_home() {
            files.push((home.join("config.toml"), "codex/config.toml"));
            files.push((home.join("state_5.sqlite"), "codex/state_5.sqlite"));
            files.push((home.join("state_5.sqlite-wal"), "codex/state_5.sqlite-wal"));
            files.push((home.join("state_5.sqlite-shm"), "codex/state_5.sqlite-shm"));
            files.push((global_state::global_state_path(&home), "codex/.codex-global-state.json"));
        }
        if let Some(home) = dirs::home_dir() {
            files.push((home.join(".session-viewer-bookmarks.json"), "viewer/bookmarks.json"));
        }
        for (source, rel) in files {
            if !source.is_file() {
                continue;
            }
            let target = dir.join(rel);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建备份目录失败：{e}"))?;
            }
            fs::copy(&source, &target).map_err(|e| format!("备份 {} 失败：{e}", source.display()))?;
        }
        self.report.backup_dir = Some(dir.to_string_lossy().into_owned());
        Ok(())
    }

    // ── Claude ──

    fn relocate_claude(&mut self, moves: &[ClaudeMove]) -> Result<(), String> {
        let Some(root) = archive::source_root(SessionSourceKind::Claude) else {
            return Ok(());
        };
        let mut report = RelocateSourceReport {
            source: "claude".to_string(),
            ..RelocateSourceReport::default()
        };
        let mut result = Ok(());
        for mv in moves {
            if let Err(error) = self.relocate_claude_dir(&root, mv, &mut report) {
                if error == CANCELLED {
                    result = Err(error);
                    break;
                }
                report.failed += 1;
                self.error(format!("Claude 项目 {}：{error}", mv.path));
            }
        }
        self.report.sources.push(report);
        result
    }

    fn relocate_claude_dir(&mut self, root: &Path, mv: &ClaudeMove, report: &mut RelocateSourceReport) -> Result<(), String> {
        self.check_cancel()?;
        let lock = crate::persistence::StateLock::acquire()?;
        report.sessions += mv.sessions;
        let target = root.join(&mv.new_name);
        // Paths below the final directory that still need their cwd rewritten.
        let mut to_rewrite: Vec<PathBuf> = mv.jsonl.iter().map(|(rel, _)| rel.clone()).collect();
        let mut merged_from: Option<PathBuf> = None;

        if mv.new_name != mv.name {
            // A case-only change names the same directory on case-insensitive
            // file systems: rename it, never merge it into itself.
            let case_only = mv.new_name.eq_ignore_ascii_case(&mv.name);
            if case_only || fs::symlink_metadata(&target).is_err() {
                fs::rename(&mv.dir, &target).map_err(|e| format!("重命名项目目录失败：{e}"))?;
                report.moved_dirs += 1;
            } else {
                to_rewrite = self.merge_claude_dir(&lock, mv, &target)?;
                merged_from = Some(mv.dir.clone());
            }
            self.claude_names.insert(mv.name.clone(), mv.new_name.clone());
            for (rel, _) in &mv.jsonl {
                self.moved_files.insert(mv.dir.join(rel), target.join(rel));
            }
        }

        for rel in &to_rewrite {
            self.rewrite(&target.join(rel), report)?;
        }
        if let Err(error) = self.update_claude_index(mv, &target, merged_from.as_deref()) {
            self.error(error);
        }
        if let Some(old) = merged_from {
            // Only removes the old directory once everything moved out.
            let _ = fs::remove_dir(old);
        }
        Ok(())
    }

    /// Move the entries of `mv.dir` into the existing `target`, keeping
    /// anything whose name is already taken. The index and viewer metadata
    /// are merged separately. Returns the moved transcripts (relative paths).
    fn merge_claude_dir(&mut self, lock: &crate::persistence::StateLock, mv: &ClaudeMove, target: &Path) -> Result<Vec<PathBuf>, String> {
        let entries = fs::read_dir(&mv.dir).map_err(|e| format!("读取项目目录失败：{e}"))?;
        let mut moved: Vec<PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name == "sessions-index.json" || name == ".session-viewer-meta.json" {
                continue;
            }
            let destination = target.join(&name);
            if fs::symlink_metadata(&destination).is_ok() {
                if name != ".project-meta.json" {
                    self.error(format!(
                        "Claude 目录 {} 已有 {}，保留在原位置",
                        target.display(),
                        name.to_string_lossy()
                    ));
                }
                continue;
            }
            move_path(&entry.path(), &destination)?;
            moved.push(PathBuf::from(&name));
        }
        self.merge_claude_viewer_meta(lock, mv, target);
        Ok(mv
            .jsonl
            .iter()
            .map(|(rel, _)| rel.clone())
            .filter(|rel| {
                rel.components()
                    .next()
                    .is_some_and(|first| moved.iter().any(|m| m.as_os_str() == first.as_os_str()))
            })
            .collect())
    }

    fn merge_claude_viewer_meta(&mut self, lock: &crate::persistence::StateLock, mv: &ClaudeMove, target: &Path) {
        let old_path = mv.dir.join(".session-viewer-meta.json");
        let new_path = target.join(".session-viewer-meta.json");
        if let Err(error) = crate::metadata::merge_metadata_files(lock, &old_path, &new_path) {
            self.error(error);
        }
    }

    /// Point `sessions-index.json` at the new directory and path; with
    /// `merged_from`, carry over the entries of the old index too.
    fn update_claude_index(&mut self, mv: &ClaudeMove, target: &Path, merged_from: Option<&Path>) -> Result<(), String> {
        let index_path = target.join("sessions-index.json");
        let old_index = match merged_from {
            Some(old) => read_json(&old.join("sessions-index.json"))?,
            None => None,
        };
        let mut index = match read_json(&index_path)? {
            Some(index) => index,
            None if old_index.is_some() => json!({ "version": 1, "entries": [] }),
            None => return Ok(()),
        };
        if !index.is_object() {
            return Err(format!("{} 格式无效", index_path.display()));
        }
        let mut changed = old_index.is_some();
        let original = index
            .get("originalPath")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let next_original = match original {
            Some(original) => self.remap.apply(&original),
            None if merged_from.is_some() || mv.new_name != mv.name => Some(mv.new_path.clone()),
            None => None,
        };
        if let Some(next) = next_original {
            index["originalPath"] = json!(next);
            changed = true;
        }
        let Some(entries) = index.get_mut("entries").and_then(Value::as_array_mut) else {
            return Err(format!("{} 缺少 entries", index_path.display()));
        };
        if let Some(old_entries) = old_index
            .as_ref()
            .and_then(|old| old.get("entries"))
            .and_then(Value::as_array)
        {
            for entry in old_entries {
                let id = entry.get("sessionId").and_then(Value::as_str);
                let known = entries
                    .iter()
                    .any(|e| id.is_some() && e.get("sessionId").and_then(Value::as_str) == id);
                if !known {
                    entries.push(entry.clone());
                }
            }
        }
        for entry in entries.iter_mut() {
            if let Some(Value::String(full_path)) = entry.get_mut("fullPath") {
                let file = Path::new(full_path.as_str()).file_name().map(|name| target.join(name));
                if let Some(file) = file.filter(|file| file.is_file()) {
                    let next = file.to_string_lossy().into_owned();
                    if *full_path != next {
                        *full_path = next;
                        changed = true;
                    }
                }
            }
            if let Some(Value::String(project_path)) = entry.get_mut("projectPath") {
                if let Some(next) = self.remap.apply(project_path) {
                    *project_path = next;
                    changed = true;
                }
            }
        }
        if changed {
            write_json_atomic(&index_path, &index)?;
        }
        if let Some(old) = merged_from {
            let _ = fs::remove_file(old.join("sessions-index.json"));
        }
        Ok(())
    }

    fn relocate_claude_globals(&mut self) -> Result<(), String> {
        match remap_claude_config(&self.remap, false) {
            Ok(moved) => self.report.claude_config_entries = moved,
            Err(error) => self.error(format!("更新 ~/.claude.json 失败：{error}")),
        }
        if let Some(history) = claude_history_path().filter(|path| path.is_file()) {
            self.job
                .update(|job| job.current_item = Some(history.to_string_lossy().into_owned()));
            match rewrite_file(&history, &self.remap, rewrite_history_project, self.job) {
                Ok(lines) => self.report.claude_history_lines = lines as u32,
                Err(error) if error == CANCELLED => return Err(error),
                Err(error) => self.error(error),
            }
        }
        Ok(())
    }

    // ── Codex ──

    fn relocate_codex(&mut self, rollouts: &[CodexRollout]) -> Result<(), String> {
        let Some(home) = codex::get_codex_home() else {
            return Ok(());
        };
        let mut report = RelocateSourceReport {
            source: "codex".to_string(),
            sessions: rollouts.len(),
            ..RelocateSourceReport::default()
        };
        let mut result = Ok(());
        for item in rollouts {
            if let Err(error) = self.rewrite(&item.path, &mut report) {
                result = Err(error);
                break;
            }
        }
        self.report.sources.push(report);
        result?;

        self.job.set_phase("merging");
        let db = sqlite_state::db_path(&home);
        if db.is_file() {
            match sqlite_state::remap_thread_cwds(&db, |v| self.remap.apply(v), false) {
                Ok(rows) => self.report.codex_thread_rows = rows,
                Err(error) => self.error(format!("更新 Codex 状态数据库失败：{error}")),
            }
        }
        match codex_config::remap_project_entries(&home.join("config.toml"), |v| self.remap.apply(v), false) {
            Ok(entries) => self.report.codex_trust_entries = entries,
            Err(error) => self.error(format!("更新 Codex config.toml 失败：{error}")),
        }
        match global_state::remap_paths(&global_state::global_state_path(&home), |v| {
            self.remap.apply(v)
        }) {
            Ok(changed) => self.report.codex_global_state = changed,
            Err(error) => self.error(format!("更新 Codex 全局状态失败：{error}")),
        }
        Ok(())
    }

    // ── Grok / OMP ──

    fn relocate_dir_sessions<const N: usize>(
        &mut self,
        source: &str,
        sessions: &mut [DirSession],
        names: fn(&str) -> [String; N],
    ) -> Result<(), String> {
        let mut report = RelocateSourceReport {
            source: source.to_string(),
            sessions: sessions.len(),
            ..RelocateSourceReport::default()
        };

        // Project directories first, so the rewrite below hits the final paths.
        let mut by_dir: HashMap<PathBuf, Vec<usize>> = HashMap::new();
        for (index, session) in sessions.iter().enumerate() {
            if let Some(dir) = &session.project_dir {
                by_dir.entry(dir.clone()).or_default().push(index);
            }
        }
        let mut dirs: Vec<(PathBuf, Vec<usize>)> = by_dir.into_iter().collect();
        dirs.sort();
        for (dir, indexes) in dirs {
            let first = &sessions[indexes[0]];
            if indexes.iter().any(|&i| sessions[i].cwd != first.cwd) {
                continue;
            }
            let Some(current) = dir.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(next) = renamed_dir(current, &first.cwd, &first.new_cwd, names) else {
                continue;
            };
            let Some(target) = dir.parent().map(|parent| parent.join(&next)) else {
                continue;
            };
            if next.eq_ignore_ascii_case(current) || fs::symlink_metadata(&target).is_err() {
                match fs::rename(&dir, &target) {
                    Ok(()) => {
                        report.moved_dirs += 1;
                        for &i in &indexes {
                            self.move_unit(source, &mut sessions[i], &dir, &target);
                        }
                    }
                    Err(e) => self.error(format!("{source} 目录 {} 重命名失败：{e}", dir.display())),
                }
                continue;
            }
            // The tool already has a directory for the new path: move the
            // sessions into it one by one.
            for &i in &indexes {
                let unit = sessions[i].unit.clone();
                let Some(name) = unit.file_name() else {
                    continue;
                };
                let mut parts = vec![(unit.clone(), target.join(name))];
                if source == "omp" {
                    let artifacts = omp_artifacts(&unit);
                    if artifacts.is_dir() {
                        parts.push((artifacts.clone(), omp_artifacts(&target.join(name))));
                    }
                }
                if parts.iter().any(|(_, to)| fs::symlink_metadata(to).is_ok()) {
                    self.error(format!("{source} 目录 {} 已有同名会话，保留在原位置", target.display()));
                    continue;
                }
                let moved = parts.iter().try_for_each(|(from, to)| move_path(from, to));
                match moved {
                    Ok(()) => self.move_unit(source, &mut sessions[i], &dir, &target),
                    Err(error) => self.error(error),
                }
            }
            let _ = fs::remove_dir(&dir);
        }

        self.job.set_phase("rewriting");
        for session in sessions.iter() {
            for file in session_transcripts(source, &session.unit) {
                if let Err(error) = self.rewrite(&file, &mut report) {
                    self.report.sources.push(report);
                    return Err(error);
                }
            }
            if source == "grok" {
                let summary = session.unit.join("summary.json");
                match rewrite_json_file(&summary, &self.remap) {
                    Ok(true) => report.rewritten_files += 1,
                    Ok(false) => {}
                    Err(error) => {
                        report.failed += 1;
                        self.error(error);
                    }
                }
            }
        }
        self.report.sources.push(report);
        Ok(())
    }

    /// Record that `session.unit` moved from `dir` to `target`.
    fn move_unit(&mut self, source: &str, session: &mut DirSession, dir: &Path, target: &Path) {
        let Ok(rel) = session.unit.strip_prefix(dir).map(Path::to_path_buf) else {
            return;
        };
        let next = target.join(&rel);
        // Bookmarks point at the transcript: Grok's chat_history inside the
        // session directory, the session file itself for OMP.
        let (old_file, new_file) = match source {
            "grok" => (
                session.unit.join("chat_history.jsonl"),
                next.join("chat_history.jsonl"),
            ),
            _ => (session.unit.clone(), next.clone()),
        };
        self.moved_files.insert(old_file, new_file);
        session.unit = next;
        session.project_dir = Some(target.to_path_buf());
    }

    fn relocate_bookmarks(&mut self) {
        let remap = &self.remap;
        let moved_files = &self.moved_files;
        let claude_names = &self.claude_names;
        let result = crate::bookmarks::update_bookmarks(|bookmark| {
            let mut changed = false;
            if let Some(next) = moved_files.get(Path::new(&bookmark.file_path)) {
                bookmark.file_path = next.to_string_lossy().into_owned();
                changed = true;
            }
            let project = match bookmark.source.as_str() {
                "claude" => claude_names.get(&bookmark.project_id).cloned(),
                _ => remap.apply(&bookmark.project_id),
            };
            if let Some(project) = project.filter(|p| *p != bookmark.project_id) {
                bookmark.project_id = project;
                changed = true;
            }
            changed
        });
        match result {
            Ok(count) => self.report.bookmarks = count as u32,
            Err(error) => self.error(format!("更新收藏失败：{error}")),
        }
    }
}

fn move_folder(remap: &Remap) -> Result<(), String> {
    fs::rename(&remap.from, &remap.to).map_err(|e| {
        let cross_device = matches!(e.raw_os_error(), Some(18) if cfg!(unix))
            || matches!(e.raw_os_error(), Some(17) if cfg!(windows));
        if cross_device {
            "原目录与新位置不在同一个磁盘分区，无法直接移动。请手动移动文件夹后，选择「文件夹已手动移动」再执行".to_string()
        } else {
            format!("移动文件夹失败：{e}。请关闭正在使用该目录的编辑器、终端和 AI 工具后重试")
        }
    })
}

pub(super) fn run(job: &JobHandle, request: &RelocateRequest) -> Result<(), String> {
    job.set_phase("scanning");
    let remap = validate(request, true)?;
    let mut plan = build_plan(&remap);

    let claude_bytes: u64 = plan
        .claude
        .iter()
        .flat_map(|mv| mv.jsonl.iter().map(|(_, size)| *size))
        .sum();
    let history_bytes = claude_history_path().map_or(0, |path| file_size(&path));
    let files = plan.claude.iter().map(|mv| mv.jsonl.len()).sum::<usize>()
        + plan.codex.len()
        + plan.grok.iter().chain(plan.omp.iter()).map(|s| s.files).sum::<usize>()
        + usize::from(history_bytes > 0);
    let bytes = claude_bytes
        + history_bytes
        + plan.codex.iter().map(|r| r.size).sum::<u64>()
        + plan.grok.iter().chain(plan.omp.iter()).map(|s| s.size).sum::<u64>();
    job.update(|job| {
        job.total_files = files as u64;
        job.total_bytes = bytes;
    });

    let mut relocator = Relocator {
        job,
        remap: remap.clone(),
        report: RelocateReport::default(),
        moved_files: HashMap::new(),
        claude_names: HashMap::new(),
    };
    relocator.backup()?;

    if request.move_folder {
        job.set_phase("moving");
        move_folder(&remap)?;
        relocator.report.folder_moved = true;
    }

    job.set_phase("rewriting");
    let mut outcome = relocator.relocate_claude(&plan.claude);
    if outcome.is_ok() {
        outcome = relocator.relocate_codex(&plan.codex);
    }
    if outcome.is_ok() {
        job.set_phase("rewriting");
        outcome = relocator.relocate_dir_sessions("grok", &mut plan.grok, grok_dir_names);
    }
    if outcome.is_ok() {
        outcome = relocator.relocate_dir_sessions("omp", &mut plan.omp, omp_dir_names);
    }
    if outcome.is_ok() {
        job.set_phase("merging");
        outcome = relocator.relocate_claude_globals();
    }
    // Bookmarks follow whatever moved, even after a cancel.
    relocator.relocate_bookmarks();

    claude::invalidate_cache();
    codex::invalidate_sessions_cache();
    grok::invalidate_sessions_cache();
    omp::invalidate_sessions_cache();

    let report = relocator.report;
    job.update(|job| job.relocate_report = Some(report));
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_names_follow_the_rule_that_produced_the_current_name() {
        let [strict, _] = grok_dir_names("/home/a/proj");
        assert_eq!(strict, "%2Fhome%2Fa%2Fproj");
        assert_eq!(
            renamed_dir(&strict, "/home/a/proj", "/work/proj", grok_dir_names).as_deref(),
            Some("%2Fwork%2Fproj")
        );
        assert_eq!(renamed_dir("custom-name", "/home/a/proj", "/work/proj", grok_dir_names), None);

        assert_eq!(omp_dir_names("/home/a/proj")[0], "--home-a-proj--");
        assert_eq!(
            renamed_dir("--home-a-proj--", "/home/a/proj", "/work/proj", omp_dir_names).as_deref(),
            Some("--work-proj--")
        );
    }

    #[test]
    fn keeps_forward_slash_style_of_windows_keys() {
        let remap = Remap {
            from: r"C:\Users\a\proj".into(),
            to: r"D:\work\proj".into(),
        };
        assert_eq!(remap_keep_style(&remap, "C:/Users/a/proj").as_deref(), Some("D:/work/proj"));
        assert_eq!(remap_keep_style(&remap, r"C:\Users\a\proj\x").as_deref(), Some(r"D:\work\proj\x"));
    }

    #[test]
    fn rejects_moves_into_itself() {
        let request = |from: &str, to: &str| RelocateRequest {
            from: from.into(),
            to: to.into(),
            move_folder: false,
        };
        let base = std::env::temp_dir().join("asv-relocate-test");
        let path = |rel: &str| base.join(rel).to_string_lossy().into_owned();
        let proj = path("proj");
        assert!(validate(&request(&proj, &path("proj/sub")), false).is_err());
        assert!(validate(&request(&proj, &proj), false).is_err());
        assert!(validate(&request("relative", &path("b")), false).is_err());
        assert!(validate(&request(&proj, &path("proj-new")), false).is_ok());
    }
}
