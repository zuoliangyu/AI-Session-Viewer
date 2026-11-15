//! Preview and import an archive produced by [`super::export`].

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use zip::ZipArchive;

use super::archive::{self, ArchivedBookmark, Manifest, ManifestFile, ManifestProject, ManifestSession, Remap};
use super::{
    copy_with_progress, ConflictPolicy, ImportOptions, ImportPreview, ImportReport, JobHandle,
    PreviewProject, PreviewSource, SourceReport, CANCELLED,
};
use crate::metadata::{self, MetadataFile};
use crate::paths::SessionSourceKind;
use crate::provider::{claude, codex, grok, omp};
use crate::provider_sync::sqlite_state::{self, ImportedThread};

type Archive = ZipArchive<BufReader<File>>;

/// Small JSON side files are read fully; refuse anything absurd.
const MAX_JSON_ENTRY: u64 = 512 * 1024 * 1024;
const MAX_REPORTED_ERRORS: usize = 50;

fn read_entry(zip: &mut Archive, name: &str) -> Result<Option<Vec<u8>>, String> {
    let entry = match zip.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(format!("读取归档 {name} 失败：{e}")),
    };
    let mut bytes = Vec::new();
    entry
        .take(MAX_JSON_ENTRY)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取归档 {name} 失败：{e}"))?;
    Ok(Some(bytes))
}

fn open_archive(path: &Path) -> Result<(Archive, Manifest), String> {
    let file = File::open(path).map_err(|e| format!("打开归档失败：{e}"))?;
    let mut zip = ZipArchive::new(BufReader::new(file))
        .map_err(|e| format!("不是有效的 zip 归档：{e}"))?;
    let bytes = read_entry(&mut zip, archive::MANIFEST)?
        .ok_or("归档缺少 manifest.json，不是 AI Session Viewer 导出的会话包")?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("manifest.json 无法解析：{e}"))?;
    if manifest.format != archive::FORMAT {
        return Err("不是 AI Session Viewer 导出的会话包".to_string());
    }
    if manifest.version > archive::VERSION {
        return Err(format!(
            "该会话包由更新的版本（{}）创建，请先升级本应用",
            manifest.app_version
        ));
    }
    validate_manifest(&manifest)?;
    Ok((zip, manifest))
}

/// Reject anything that could write outside the source roots or confuse the
/// providers, before touching the file system.
fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    for source in &manifest.sources {
        let kind = SessionSourceKind::parse(&source.source)?;
        for project in &source.projects {
            if kind == SessionSourceKind::Claude {
                archive::split_rel(&project.id)
                    .ok()
                    .filter(|parts| parts.len() == 1)
                    .ok_or_else(|| format!("归档包含非法项目目录：{}", project.id))?;
            }
            let check = |file: &ManifestFile| -> Result<(), String> {
                if kind == SessionSourceKind::Claude
                    && !file.path.starts_with(&format!("{}/", project.id))
                {
                    return Err(format!("归档文件不在所属项目目录内：{}", file.path));
                }
                archive::validate_layout(kind, &file.path)
            };
            for file in &project.files {
                if kind != SessionSourceKind::Claude {
                    return Err("只有 Claude 项目可以包含项目级文件".to_string());
                }
                check(file)?;
            }
            for session in &project.sessions {
                metadata::validate_session_id(&session.id)?;
                archive::validate_layout(kind, &session.primary)?;
                if !session.files.iter().any(|file| file.path == session.primary) {
                    return Err(format!("会话 {} 缺少主文件", session.id));
                }
                for file in &session.files {
                    check(file)?;
                }
            }
        }
    }
    Ok(())
}

fn join_rel(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for part in archive::split_rel(rel)? {
        path.push(part);
    }
    Ok(path)
}

/// Where a project lands on this machine.
struct ProjectTarget {
    kind: SessionSourceKind,
    remap: Option<Remap>,
    /// Claude only: project directory name under `~/.claude/projects`.
    claude_dir: Option<String>,
    project_id: String,
    project_path: Option<String>,
}

impl ProjectTarget {
    fn new(kind: SessionSourceKind, project: &ManifestProject, options: Option<&ImportOptions>) -> Self {
        let source = archive::source_name(kind);
        let mapped = options
            .and_then(|options| {
                options
                    .path_mappings
                    .iter()
                    .find(|m| m.source == source && m.project_id == project.id)
            })
            .map(|m| m.target_path.trim().to_string())
            .filter(|path| !path.is_empty());
        let remap = match (&project.path, &mapped) {
            (Some(from), Some(to)) if from != to => Some(Remap {
                from: from.clone(),
                to: to.clone(),
            }),
            _ => None,
        };
        let claude_dir = (kind == SessionSourceKind::Claude).then(|| match &remap {
            Some(remap) => crate::parser::path_encoder::encode_project_path(&remap.to),
            None => project.id.clone(),
        });
        let project_id = match (&claude_dir, &remap) {
            (Some(dir), _) => dir.clone(),
            (None, Some(remap)) => remap.to.clone(),
            (None, None) => project.id.clone(),
        };
        Self {
            kind,
            project_path: remap
                .as_ref()
                .map(|remap| remap.to.clone())
                .or_else(|| project.path.clone()),
            remap,
            claude_dir,
            project_id,
        }
    }

    fn rel(&self, rel: &str) -> String {
        match &self.claude_dir {
            Some(dir) => match rel.split_once('/') {
                Some((_, rest)) => format!("{dir}/{rest}"),
                None => dir.clone(),
            },
            None => rel.to_string(),
        }
    }

    /// Paths that make up the session locally; the first one decides whether
    /// the session already exists.
    fn session_units(&self, root: &Path, primary: &Path) -> Vec<PathBuf> {
        match self.kind {
            SessionSourceKind::Claude | SessionSourceKind::Omp => {
                vec![primary.to_path_buf(), primary.with_extension("")]
            }
            SessionSourceKind::Codex => vec![primary.to_path_buf()],
            SessionSourceKind::Grok => vec![primary
                .parent()
                .filter(|dir| *dir != root)
                .unwrap_or(primary)
                .to_path_buf()],
        }
    }
}

fn session_exists(target: &ProjectTarget, root: &Path, session: &ManifestSession) -> bool {
    join_rel(root, &target.rel(&session.primary))
        .map(|primary| {
            target
                .session_units(root, &primary)
                .first()
                .is_some_and(|unit| unit.exists())
        })
        .unwrap_or(false)
}

fn project_bytes(project: &ManifestProject) -> (u64, u64) {
    project
        .files
        .iter()
        .chain(project.sessions.iter().flat_map(|s| s.files.iter()))
        .fold((0, 0), |(count, bytes), file| (count + 1, bytes + file.size))
}

pub fn inspect_archive(path: &Path) -> Result<ImportPreview, String> {
    super::validate_archive_name(path)?;
    let (_, manifest) = open_archive(path)?;
    let sources = manifest
        .sources
        .iter()
        .map(|source| -> Result<PreviewSource, String> {
            let kind = SessionSourceKind::parse(&source.source)?;
            let root = archive::source_root(kind);
            let projects: Vec<PreviewProject> = source
                .projects
                .iter()
                .map(|project| {
                    let target = ProjectTarget::new(kind, project, None);
                    let conflict_count = root.as_deref().map_or(0, |root| {
                        project
                            .sessions
                            .iter()
                            .filter(|session| session_exists(&target, root, session))
                            .count()
                    });
                    PreviewProject {
                        id: project.id.clone(),
                        name: project.name.clone(),
                        path_exists: project.path.as_deref().is_some_and(|path| {
                            let path = Path::new(path);
                            path.is_absolute() && path.is_dir()
                        }),
                        path: project.path.clone(),
                        session_count: project.sessions.len(),
                        conflict_count,
                        total_bytes: project_bytes(project).1,
                    }
                })
                .collect();
            Ok(PreviewSource {
                source: source.source.clone(),
                session_count: projects.iter().map(|p| p.session_count).sum(),
                projects,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ImportPreview {
        app_version: manifest.app_version,
        created_at: manifest.created_at,
        host_os: manifest.host_os,
        file_count: manifest.file_count,
        total_bytes: manifest.total_bytes,
        sources,
    })
}

// ── File writing ──

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|window| window == needle)
}

/// Copy a transcript line by line, applying `rewrite` (the cwd fields for
/// transcripts) only to lines that mention the old path; every
/// other byte is preserved. Returns `(bytes read, lines rewritten)`.
pub(super) fn rewrite_jsonl(
    input: impl Read,
    output: &mut impl Write,
    remap: &Remap,
    rewrite: fn(&mut Value, &Remap) -> bool,
    job: &JobHandle,
) -> std::io::Result<(u64, usize)> {
    let needle = remap.needle();
    let mut reader = BufReader::with_capacity(256 * 1024, input);
    let mut line = Vec::new();
    let mut total = 0u64;
    let mut changed = 0usize;
    loop {
        if job.cancelled() {
            return Err(std::io::Error::other(CANCELLED));
        }
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        job.add_bytes(read as u64);
        let rewritten = if contains(&line, needle.as_bytes()) {
            std::str::from_utf8(&line).ok().and_then(|text| {
                let body = text.trim_end_matches(['\r', '\n']);
                let mut row: Value = serde_json::from_str(body).ok()?;
                rewrite(&mut row, remap)
                    .then(|| format!("{row}{}", &text[body.len()..]))
            })
        } else {
            None
        };
        match rewritten {
            Some(text) => {
                changed += 1;
                output.write_all(text.as_bytes())?
            }
            None => output.write_all(&line)?,
        }
    }
    Ok((total, changed))
}

/// Extract one archive file to `dest` (which must not exist) through a
/// temporary sibling, then restore its mtime.
fn write_entry(
    zip: &mut Archive,
    source: &str,
    file: &ManifestFile,
    dest: &Path,
    remap: Option<&Remap>,
    job: &JobHandle,
) -> Result<(), String> {
    let name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("无效的目标文件名")?
        .to_string();
    let entry_name = archive::entry_name(source, &file.path);
    let mut entry = zip
        .by_name(&entry_name)
        .map_err(|e| format!("归档缺少 {entry_name}：{e}"))?;
    let temporary = dest.with_file_name(format!(".{name}.asv-import"));
    let _ = fs::remove_file(&temporary);
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| format!("创建 {} 失败：{e}", dest.display()))?;
    let mut writer = BufWriter::new(output);

    let is_jsonl = name.ends_with(".jsonl");
    let result = (|| -> std::io::Result<u64> {
        let read = match remap {
            Some(remap) if is_jsonl => {
                rewrite_jsonl(&mut entry, &mut writer, remap, archive::rewrite_cwd_fields, job)?.0
            }
            Some(remap) if name == "summary.json" => {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes)?;
                job.add_bytes(bytes.len() as u64);
                let len = bytes.len() as u64;
                let rewritten = serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .and_then(|mut summary| {
                        archive::rewrite_cwd_fields(&mut summary, remap).then(|| summary.to_string())
                    });
                match rewritten {
                    Some(summary) => writer.write_all(summary.as_bytes())?,
                    None => writer.write_all(&bytes)?,
                }
                len
            }
            _ => copy_with_progress(&mut entry, &mut writer, job)?,
        };
        writer.flush()?;
        Ok(read)
    })();
    drop(writer);
    let outcome = result
        .map_err(|e| format!("写入 {} 失败：{e}", dest.display()))
        .and_then(|read| {
            if read == file.size {
                Ok(())
            } else {
                Err(format!("{} 大小不符，归档可能已损坏", file.path))
            }
        })
        .and_then(|_| {
            fs::rename(&temporary, dest).map_err(|e| format!("保存 {} 失败：{e}", dest.display()))
        });
    if outcome.is_err() {
        let _ = fs::remove_file(&temporary);
        return outcome;
    }
    if let Some(mtime) = file.mtime {
        let _ = filetime::set_file_mtime(dest, filetime::FileTime::from_unix_time(mtime, 0));
    }
    job.update(|job| job.processed_files += 1);
    Ok(())
}

/// Create the parent directories of `rel` and make sure the result is still
/// inside the (canonical) source root and not a link.
fn prepare_target(root: &Path, canonical_root: &Path, rel: &str) -> Result<PathBuf, String> {
    let target = join_rel(root, rel)?;
    let parent = target.parent().ok_or("无效的目标路径")?;
    fs::create_dir_all(parent).map_err(|e| format!("创建目录 {} 失败：{e}", parent.display()))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("解析目录 {} 失败：{e}", parent.display()))?;
    if !canonical_parent.starts_with(canonical_root) {
        return Err(format!("拒绝写入会话目录之外的路径：{rel}"));
    }
    if fs::symlink_metadata(&target).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(format!("目标是符号链接，已拒绝：{}", target.display()));
    }
    Ok(target)
}

fn copy_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(source)?.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(source, destination).map(|_| ())
    }
}

/// Move a file or directory, falling back to copy + delete across devices.
pub(super) fn move_path(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建备份目录失败：{e}"))?;
    }
    if fs::rename(source, destination).is_ok() {
        return Ok(());
    }
    copy_tree(source, destination).map_err(|e| format!("备份 {} 失败：{e}", source.display()))?;
    let removed = if source.is_dir() {
        fs::remove_dir_all(source)
    } else {
        fs::remove_file(source)
    };
    removed.map_err(|e| format!("移除旧文件 {} 失败：{e}", source.display()))
}

pub(super) fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let temporary = path.with_extension("json.asv-import");
    fs::write(&temporary, value.to_string()).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    fs::rename(&temporary, path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("保存 {} 失败：{e}", path.display())
    })
}

// ── Import job ──

/// Count files that are not written (skipped or merged) as processed.
fn skip_progress(job: &JobHandle, files: &[ManifestFile]) {
    let bytes: u64 = files.iter().map(|file| file.size).sum();
    job.update(|job| {
        job.processed_files += files.len() as u64;
        job.processed_bytes += bytes;
    });
}

enum Outcome {
    Imported,
    Overwritten,
    Skipped,
}

/// A session that exists locally after the import (written now or kept).
struct Present {
    path: PathBuf,
    project_id: String,
    remap: Option<Remap>,
    /// Replaced a local copy, so archived side data wins over local data.
    overwritten: bool,
}

struct Importer<'a> {
    job: &'a JobHandle,
    zip: Archive,
    policy: ConflictPolicy,
    backup_dir: Option<PathBuf>,
    report: ImportReport,
    /// (source, archived primary) → local session.
    present: HashMap<(String, String), Present>,
    /// (source, session id) → archived primary.
    by_id: HashMap<(String, String), String>,
}

impl Importer<'_> {
    fn error(&mut self, message: String) {
        if self.report.errors.len() < MAX_REPORTED_ERRORS {
            self.report.errors.push(message);
        }
    }

    fn backup_root(&mut self) -> Result<PathBuf, String> {
        if let Some(dir) = &self.backup_dir {
            return Ok(dir.clone());
        }
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let dir = crate::app_dir::get_app_dir()
            .ok_or("无法确定应用数据目录")?
            .join("transfer")
            .join("backups")
            .join(stamp);
        fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
        self.report.backup_dir = Some(dir.to_string_lossy().into_owned());
        self.backup_dir = Some(dir.clone());
        Ok(dir)
    }

    fn import_session(
        &mut self,
        roots: (&Path, &Path),
        target: &ProjectTarget,
        session: &ManifestSession,
    ) -> Result<Outcome, String> {
        let (root, canonical_root) = roots;
        let source = archive::source_name(target.kind);
        let primary = join_rel(root, &target.rel(&session.primary))?;
        let units = target.session_units(root, &primary);
        let exists = units.first().is_some_and(|unit| unit.exists());
        if exists && self.policy == ConflictPolicy::Skip {
            skip_progress(self.job, &session.files);
            return Ok(Outcome::Skipped);
        }

        let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
        if exists {
            let backup = self.backup_root()?.join(source);
            for unit in units.iter().filter(|unit| unit.exists()) {
                let step = archive::relative_to(root, unit)
                    .ok_or_else(|| "无法备份会话目录之外的文件".to_string())
                    .and_then(|rel| join_rel(&backup, &rel))
                    .and_then(|destination| move_path(unit, &destination).map(|_| destination));
                match step {
                    Ok(destination) => moved.push((destination, unit.clone())),
                    Err(error) => {
                        for (from, to) in moved.iter().rev() {
                            let _ = move_path(from, to);
                        }
                        return Err(error);
                    }
                }
            }
        }

        // Primary (and the Grok summary) last: providers ignore a session
        // until it is complete.
        let mut files: Vec<&ManifestFile> = session.files.iter().collect();
        files.sort_by_key(|file| file.path == session.primary || file.path.ends_with("/summary.json"));

        let mut written = Vec::new();
        let mut result = Ok(());
        for file in files {
            let dest = match prepare_target(root, canonical_root, &target.rel(&file.path)) {
                Ok(dest) => dest,
                Err(error) => {
                    result = Err(error);
                    break;
                }
            };
            if dest.exists() {
                // A leftover of an earlier partial copy; never clobber it.
                skip_progress(self.job, std::slice::from_ref(file));
                continue;
            }
            if let Err(error) =
                write_entry(&mut self.zip, source, file, &dest, target.remap.as_ref(), self.job)
            {
                result = Err(error);
                break;
            }
            written.push(dest);
        }
        if let Err(error) = result {
            for path in written.iter().rev() {
                let _ = fs::remove_file(path);
            }
            for (from, to) in moved.iter().rev() {
                let _ = move_path(from, to);
            }
            return Err(error);
        }
        Ok(if exists {
            Outcome::Overwritten
        } else {
            Outcome::Imported
        })
    }

    fn merge_metadata(&mut self, source: &str, project_id: &str, bytes: &[u8], ids: &HashMap<String, bool>) {
        let Ok(archived) = serde_json::from_slice::<MetadataFile>(bytes) else {
            self.error(format!("{source} 别名/标签数据损坏，已跳过"));
            return;
        };
        let result = metadata::edit_metadata(source, project_id, |local| {
            let mut changed = false;
            for (id, meta) in archived.sessions {
                let Some(overwritten) = ids.get(&id) else {
                    continue;
                };
                if *overwritten || !local.sessions.contains_key(&id) {
                    local.sessions.insert(id, meta);
                    changed = true;
                }
            }
            Ok(changed)
        });
        if let Err(error) = result {
            self.error(format!("保存 {source} 别名/标签失败：{error}"));
        }
    }

    /// Claude project-level files: merge the index and metadata, copy the
    /// rest (memory, notes) only where missing.
    fn import_claude_project_files(
        &mut self,
        roots: (&Path, &Path),
        target: &ProjectTarget,
        project: &ManifestProject,
        written: &HashMap<String, PathBuf>,
        present_ids: &HashMap<String, bool>,
    ) {
        let (root, canonical_root) = roots;
        let dir_name = target.claude_dir.clone().unwrap_or_default();
        for file in &project.files {
            let rel = target.rel(&file.path);
            let at_top = rel == format!("{dir_name}/sessions-index.json")
                || rel == format!("{dir_name}/.session-viewer-meta.json");
            if at_top {
                skip_progress(self.job, std::slice::from_ref(file));
                let entry = archive::entry_name("claude", &file.path);
                let bytes = match read_entry(&mut self.zip, &entry) {
                    Ok(Some(bytes)) => bytes,
                    Ok(None) => continue,
                    Err(error) => {
                        self.error(error);
                        continue;
                    }
                };
                if rel.ends_with("sessions-index.json") {
                    if let Err(error) = merge_claude_index(root, &dir_name, &bytes, written, target) {
                        self.error(error);
                    }
                } else if !present_ids.is_empty() {
                    self.merge_metadata("claude", &dir_name, &bytes, present_ids);
                }
                continue;
            }
            let step = match prepare_target(root, canonical_root, &rel) {
                Ok(dest) if dest.exists() => {
                    skip_progress(self.job, std::slice::from_ref(file));
                    Ok(())
                }
                Ok(dest) => write_entry(&mut self.zip, "claude", file, &dest, None, self.job),
                Err(error) => Err(error),
            };
            if let Err(error) = step {
                self.error(error);
            }
        }
    }

    fn import_codex_extras(&mut self, root: &Path) {
        let source = "codex".to_string();
        let lookup = |by_id: &HashMap<(String, String), String>, id: &str| {
            by_id.get(&(source.clone(), id.to_string())).cloned()
        };

        // threads rows → state_5.sqlite
        match read_entry(&mut self.zip, archive::CODEX_THREADS) {
            Ok(Some(bytes)) => {
                let (mut overwrite, mut keep) = (Vec::new(), Vec::new());
                for line in bytes.split(|b| *b == b'\n') {
                    let Ok(Value::Object(row)) = serde_json::from_slice::<Value>(line) else {
                        continue;
                    };
                    let Some(primary) = row.get("id").and_then(Value::as_str).and_then(|id| lookup(&self.by_id, id))
                    else {
                        continue;
                    };
                    let Some(present) = self.present.get(&(source.clone(), primary)) else {
                        continue;
                    };
                    let cwd = row
                        .get("cwd")
                        .and_then(Value::as_str)
                        .zip(present.remap.as_ref())
                        .and_then(|(cwd, remap)| remap.apply(cwd));
                    let thread = ImportedThread {
                        rollout_path: present.path.to_string_lossy().into_owned(),
                        cwd,
                        row,
                    };
                    if present.overwritten {
                        overwrite.push(thread);
                    } else {
                        keep.push(thread);
                    }
                }
                let db = sqlite_state::db_path(root);
                for (threads, replace) in [(overwrite, true), (keep, false)] {
                    match sqlite_state::import_thread_rows(&db, &threads, replace) {
                        Ok((written, failures)) => {
                            self.report.codex_threads_imported += written;
                            if let Some(first) = failures.first() {
                                self.error(format!(
                                    "{} 条 Codex 线程记录未能写入本机数据库：{first}",
                                    failures.len()
                                ));
                            }
                        }
                        Err(error) => self.error(format!("写入 Codex 状态数据库失败：{error}")),
                    }
                }
            }
            Ok(None) => {}
            Err(error) => self.error(error),
        }

        // session_index.jsonl → append names that are missing locally
        match read_entry(&mut self.zip, archive::CODEX_SESSION_INDEX) {
            Ok(Some(bytes)) => {
                let index_path = root.join("session_index.jsonl");
                let local = fs::read(&index_path).unwrap_or_default();
                let known: HashSet<String> = local
                    .split(|b| *b == b'\n')
                    .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
                    .filter_map(|row| row.get("id")?.as_str().map(str::to_owned))
                    .collect();
                let mut append = String::new();
                for line in String::from_utf8_lossy(&bytes).lines() {
                    let Some(id) = serde_json::from_str::<Value>(line)
                        .ok()
                        .and_then(|row| row.get("id")?.as_str().map(str::to_owned))
                    else {
                        continue;
                    };
                    if known.contains(&id) || lookup(&self.by_id, &id).is_none() {
                        continue;
                    }
                    append.push_str(line);
                    append.push('\n');
                }
                if !append.is_empty() {
                    if !local.is_empty() && !local.ends_with(b"\n") {
                        append.insert(0, '\n');
                    }
                    let result = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(index_path)
                        .and_then(|mut file| file.write_all(append.as_bytes()));
                    if let Err(error) = result {
                        self.error(format!("更新 Codex 会话名称失败：{error}"));
                    }
                }
            }
            Ok(None) => {}
            Err(error) => self.error(error),
        }

        match read_entry(&mut self.zip, archive::CODEX_VIEWER_META) {
            Ok(Some(bytes)) => {
                let ids: HashMap<String, bool> = self
                    .by_id
                    .iter()
                    .filter(|((source, _), _)| source == "codex")
                    .filter_map(|((source, id), primary)| {
                        let present = self.present.get(&(source.clone(), primary.clone()))?;
                        Some((id.clone(), present.overwritten))
                    })
                    .collect();
                self.merge_metadata("codex", "", &bytes, &ids);
            }
            Ok(None) => {}
            Err(error) => self.error(error),
        }
    }

    fn import_bookmarks(&mut self) {
        let bytes = match read_entry(&mut self.zip, archive::BOOKMARKS) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return,
            Err(error) => return self.error(error),
        };
        let Ok(archived) = serde_json::from_slice::<Vec<ArchivedBookmark>>(&bytes) else {
            return self.error("收藏数据损坏，已跳过".to_string());
        };
        let bookmarks = archived
            .into_iter()
            .filter_map(|item| {
                let present = self.present.get(&(item.source.clone(), item.primary))?;
                let mut bookmark = item.bookmark;
                bookmark.file_path = present.path.to_string_lossy().into_owned();
                bookmark.project_id = present.project_id.clone();
                Some(bookmark)
            })
            .collect();
        match crate::bookmarks::import_bookmarks(bookmarks) {
            Ok(added) => self.report.bookmarks_imported = added,
            Err(error) => self.error(format!("导入收藏失败：{error}")),
        }
    }
}

/// Merge archived `sessions-index.json` entries of the written sessions into
/// the local index, pointing them at their new location.
fn merge_claude_index(
    root: &Path,
    dir_name: &str,
    archived: &[u8],
    written: &HashMap<String, PathBuf>,
    target: &ProjectTarget,
) -> Result<(), String> {
    static INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    if written.is_empty() {
        return Ok(());
    }
    let archived: Value =
        serde_json::from_slice(archived).map_err(|e| format!("归档中的 Claude 会话索引损坏：{e}"))?;
    let entries: Vec<Value> = archived
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry.get("sessionId")?.as_str()?;
            let path = written.get(id)?;
            let mut entry = entry.clone();
            entry["fullPath"] = json!(path.to_string_lossy());
            if let (Some(remap), Some(Value::String(project_path))) =
                (&target.remap, entry.get_mut("projectPath"))
            {
                if let Some(next) = remap.apply(project_path) {
                    *project_path = next;
                }
            }
            Some(entry)
        })
        .collect();
    if entries.is_empty() {
        return Ok(());
    }

    let _guard = INDEX_LOCK.lock().map_err(|e| e.to_string())?;
    let index_path = root.join(dir_name).join("sessions-index.json");
    let mut index: Value = if index_path.exists() {
        let bytes = fs::read(&index_path).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes)
            .map_err(|e| format!("本机 Claude 会话索引损坏，未合并：{e}"))?
    } else {
        json!({ "version": 1, "entries": [] })
    };
    if index.get("originalPath").is_none() {
        if let Some(path) = &target.project_path {
            index["originalPath"] = json!(path);
        }
    }
    let list = index
        .get_mut("entries")
        .and_then(Value::as_array_mut)
        .ok_or("本机 Claude 会话索引缺少 entries")?;
    list.retain(|entry| {
        entry
            .get("sessionId")
            .and_then(Value::as_str)
            .is_none_or(|id| !written.contains_key(id))
    });
    list.extend(entries);
    write_json_atomic(&index_path, &index)
}

pub(super) fn run(job: &JobHandle, archive_path: &Path, options: &ImportOptions) -> Result<(), String> {
    job.set_phase("scanning");
    let (zip, manifest) = open_archive(archive_path)?;
    let selected = |source: &str, project_id: &str| {
        options.projects.as_ref().is_none_or(|list| {
            list.iter()
                .any(|p| p.source == source && p.project_id == project_id)
        })
    };

    let (total_files, total_bytes) = manifest
        .sources
        .iter()
        .flat_map(|source| {
            source
                .projects
                .iter()
                .filter(|project| selected(&source.source, &project.id))
        })
        .map(project_bytes)
        .fold((0, 0), |(files, bytes), (f, b)| (files + f, bytes + b));
    if total_files == 0 {
        return Err("没有选择要导入的项目".to_string());
    }
    job.update(|job| {
        job.total_files = total_files;
        job.total_bytes = total_bytes;
    });
    job.set_phase("copying");

    let mut importer = Importer {
        job,
        zip,
        policy: options.conflict,
        backup_dir: None,
        report: ImportReport::default(),
        present: HashMap::new(),
        by_id: HashMap::new(),
    };
    let mut cancelled = false;
    let mut touched = Vec::new();

    for source in &manifest.sources {
        let kind = SessionSourceKind::parse(&source.source)?;
        let name = archive::source_name(kind);
        let root = archive::source_root(kind).ok_or_else(|| format!("无法确定 {name} 的数据目录"))?;
        fs::create_dir_all(&root).map_err(|e| format!("创建 {} 失败：{e}", root.display()))?;
        let canonical_root = root
            .canonicalize()
            .map_err(|e| format!("解析 {} 失败：{e}", root.display()))?;
        let mut report = SourceReport {
            source: name.to_string(),
            ..SourceReport::default()
        };
        touched.push(kind);

        for project in &source.projects {
            if !selected(name, &project.id) {
                continue;
            }
            let target = ProjectTarget::new(kind, project, Some(options));
            let mut written: HashMap<String, PathBuf> = HashMap::new();
            let mut present_ids: HashMap<String, bool> = HashMap::new();
            for session in &project.sessions {
                if job.cancelled() {
                    cancelled = true;
                    break;
                }
                job.update(|job| job.current_item = Some(format!("{name}/{}", session.primary)));
                let outcome = importer.import_session((&root, &canonical_root), &target, session);
                let primary_path = join_rel(&root, &target.rel(&session.primary))?;
                let (is_written, overwritten) = match outcome {
                    Ok(Outcome::Imported) => {
                        report.imported += 1;
                        (true, false)
                    }
                    Ok(Outcome::Overwritten) => {
                        report.overwritten += 1;
                        (true, true)
                    }
                    Ok(Outcome::Skipped) => {
                        report.skipped += 1;
                        (false, false)
                    }
                    Err(error) => {
                        if job.cancelled() {
                            cancelled = true;
                            break;
                        }
                        report.failed += 1;
                        importer.error(format!("{name} 会话 {}：{error}", session.id));
                        continue;
                    }
                };
                if is_written {
                    written.insert(session.id.clone(), primary_path.clone());
                }
                present_ids.insert(session.id.clone(), overwritten);
                importer
                    .by_id
                    .insert((name.to_string(), session.id.clone()), session.primary.clone());
                importer.present.insert(
                    (name.to_string(), session.primary.clone()),
                    Present {
                        path: primary_path,
                        project_id: target.project_id.clone(),
                        remap: target.remap.clone(),
                        overwritten,
                    },
                );
            }
            if kind == SessionSourceKind::Claude {
                job.set_phase("merging");
                importer.import_claude_project_files(
                    (&root, &canonical_root),
                    &target,
                    project,
                    &written,
                    &present_ids,
                );
                job.set_phase("copying");
            }
            if cancelled {
                break;
            }
        }

        // Side data still follows the sessions imported before a cancel.
        if kind == SessionSourceKind::Codex {
            job.set_phase("merging");
            importer.import_codex_extras(&root);
            job.set_phase("copying");
        }
        importer.report.sources.push(report);
        if cancelled {
            break;
        }
    }

    job.set_phase("merging");
    importer.import_bookmarks();
    for kind in touched {
        match kind {
            SessionSourceKind::Claude => claude::invalidate_cache(),
            SessionSourceKind::Codex => codex::invalidate_sessions_cache(),
            SessionSourceKind::Grok => grok::invalidate_sessions_cache(),
            SessionSourceKind::Omp => omp::invalidate_sessions_cache(),
        }
    }
    let report = importer.report;
    job.update(|job| job.import_report = Some(report));
    if cancelled {
        return Err(CANCELLED.to_string());
    }
    Ok(())
}
