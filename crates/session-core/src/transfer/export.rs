//! Collect the files of the selected projects and stream them into a zip.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::archive::{
    self, ArchivedBookmark, Manifest, ManifestFile, ManifestProject, ManifestSession,
    ManifestSource,
};
use super::{copy_with_progress, walk_files, ExportRequest, ExportSummary, JobHandle, SourceSelection};
use crate::models::project::ProjectEntry;
use crate::paths::SessionSourceKind;
use crate::provider::{claude, codex, grok, omp};

struct PlannedFile {
    abs: PathBuf,
    rel: String,
    size: u64,
    mtime: Option<i64>,
}

struct PlannedSession {
    id: String,
    primary: String,
    files: Vec<PlannedFile>,
}

struct PlannedProject {
    id: String,
    name: String,
    path: Option<String>,
    sessions: Vec<PlannedSession>,
    files: Vec<PlannedFile>,
}

struct PlannedSource {
    kind: SessionSourceKind,
    root: PathBuf,
    projects: Vec<PlannedProject>,
}

fn planned_file(root: &Path, abs: &Path) -> Option<PlannedFile> {
    let meta = fs::symlink_metadata(abs).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some(PlannedFile {
        abs: abs.to_path_buf(),
        rel: archive::relative_to(root, abs)?,
        size: meta.len(),
        mtime: meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|age| age.as_secs() as i64),
    })
}

fn planned_files(root: &Path, files: impl IntoIterator<Item = PathBuf>) -> Vec<PlannedFile> {
    files
        .into_iter()
        .filter_map(|abs| planned_file(root, &abs))
        .collect()
}

fn is_selected(selection: &SourceSelection, project_id: &str) -> bool {
    selection
        .project_ids
        .as_ref()
        .is_none_or(|ids| ids.iter().any(|id| id == project_id))
}

pub(super) fn project_infos(projects: Result<Vec<ProjectEntry>, String>) -> HashMap<String, ProjectEntry> {
    projects
        .unwrap_or_default()
        .into_iter()
        .map(|project| (project.id.clone(), project))
        .collect()
}

fn project_name(info: Option<&ProjectEntry>, path: Option<&str>, id: &str) -> String {
    info.and_then(|project| project.alias.clone())
        .or_else(|| info.map(|project| project.short_name.clone()))
        .filter(|name| !name.is_empty())
        .or_else(|| path.map(crate::parser::path_encoder::short_name_from_path))
        .unwrap_or_else(|| id.to_string())
}

// ── Claude ──

/// The cwd Claude ran in: index `originalPath`, else the first `cwd` row of a
/// transcript, else the provider's decoded display path.
pub(super) fn claude_project_path(dir: &Path, sessions: &[PathBuf], info: Option<&ProjectEntry>) -> Option<String> {
    let from_index = fs::read(dir.join("sessions-index.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|index| index.get("originalPath")?.as_str().map(str::to_owned));
    from_index
        .or_else(|| {
            sessions.iter().find_map(|path| {
                let file = File::open(path).ok()?;
                BufReader::new(file).lines().take(50).find_map(|line| {
                    let row: Value = serde_json::from_str(line.ok()?.trim()).ok()?;
                    row.get("cwd")?.as_str().map(str::to_owned)
                })
            })
        })
        .or_else(|| info.map(|project| project.display_path.clone()))
        .filter(|path| !path.is_empty())
}

fn plan_claude(selection: &SourceSelection) -> Result<PlannedSource, String> {
    let root = archive::source_root(SessionSourceKind::Claude).ok_or("找不到 Claude 项目目录")?;
    let mut planned = PlannedSource {
        kind: SessionSourceKind::Claude,
        root: root.clone(),
        projects: Vec::new(),
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(planned);
    };
    let infos = project_infos(claude::get_projects());
    let mut dirs: Vec<_> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|ty| ty.is_dir()))
        .filter_map(|entry| Some((entry.file_name().to_str()?.to_string(), entry.path())))
        .filter(|(id, _)| is_selected(selection, id))
        .collect();
    dirs.sort();

    for (id, dir) in dirs {
        let mut transcripts = Vec::new();
        if let Ok(children) = fs::read_dir(&dir) {
            for child in children.flatten() {
                let path = child.path();
                if child.file_type().is_ok_and(|ty| ty.is_file())
                    && path.extension().is_some_and(|ext| ext == "jsonl")
                {
                    transcripts.push(path);
                }
            }
        }
        transcripts.sort();
        let session_ids: HashSet<String> = transcripts
            .iter()
            .filter_map(|path| path.file_stem()?.to_str().map(str::to_owned))
            .collect();

        let mut sessions = Vec::new();
        for transcript in &transcripts {
            let Some(session_id) = transcript.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Some(primary) = planned_file(&root, transcript) else {
                continue;
            };
            let mut files = planned_files(&root, walk_files(&dir.join(session_id)));
            let primary_rel = primary.rel.clone();
            files.push(primary);
            sessions.push(PlannedSession {
                id: session_id.to_string(),
                primary: primary_rel,
                files,
            });
        }

        // Everything else in the project directory: memory, index, metadata.
        let project_files = planned_files(
            &root,
            walk_files(&dir).into_iter().filter(|path| {
                let Ok(rel) = path.strip_prefix(&dir) else {
                    return false;
                };
                let first = rel
                    .components()
                    .next()
                    .and_then(|c| c.as_os_str().to_str())
                    .unwrap_or_default();
                let top_level = rel.components().count() == 1;
                let session_file = top_level && first.ends_with(".jsonl");
                let session_dir = !top_level && session_ids.contains(first);
                !(session_file || session_dir || first.ends_with(".tmp"))
            }),
        );

        if sessions.is_empty() && project_files.is_empty() {
            continue;
        }
        let info = infos.get(&id);
        let path = claude_project_path(&dir, &transcripts, info);
        planned.projects.push(PlannedProject {
            name: project_name(info, path.as_deref(), &id),
            id,
            path,
            sessions,
            files: project_files,
        });
    }
    Ok(planned)
}

// ── Codex / Grok / OMP: one entry per session file, grouped by project ──

struct FoundSession {
    project_id: String,
    is_virtual: bool,
    session: PlannedSession,
}

fn group_sessions(
    kind: SessionSourceKind,
    root: PathBuf,
    selection: &SourceSelection,
    infos: &HashMap<String, ProjectEntry>,
    found: Vec<FoundSession>,
) -> PlannedSource {
    let mut by_project: HashMap<String, (bool, Vec<PlannedSession>)> = HashMap::new();
    for item in found {
        if !is_selected(selection, &item.project_id) {
            continue;
        }
        let entry = by_project
            .entry(item.project_id)
            .or_insert_with(|| (item.is_virtual, Vec::new()));
        entry.1.push(item.session);
    }
    let mut projects: Vec<PlannedProject> = by_project
        .into_iter()
        .map(|(id, (is_virtual, mut sessions))| {
            sessions.sort_by(|a, b| a.primary.cmp(&b.primary));
            let info = infos.get(&id);
            let path = (!is_virtual).then(|| id.clone());
            PlannedProject {
                name: project_name(info, path.as_deref(), &id),
                id,
                path,
                sessions,
                files: Vec::new(),
            }
        })
        .collect();
    projects.sort_by(|a, b| a.id.cmp(&b.id));
    PlannedSource {
        kind,
        root,
        projects,
    }
}

fn plan_codex(selection: &SourceSelection) -> Result<PlannedSource, String> {
    let root = archive::source_root(SessionSourceKind::Codex).ok_or("找不到 Codex 数据目录")?;
    let projects = codex::get_projects();
    let infos = project_infos(projects);

    // Listed sessions keep the provider's bucket (direct chats, unrooted dates).
    let mut bucket_of: HashMap<PathBuf, (String, bool)> = HashMap::new();
    for project in infos.values() {
        for session in codex::get_sessions(&project.id).unwrap_or_default() {
            bucket_of.insert(
                PathBuf::from(&session.file_path),
                (project.id.clone(), project.is_virtual),
            );
        }
    }

    // Archived, sub-agent and exec rollouts are not listed; group them by cwd.
    let mut files = codex::scan_all_session_files();
    files.extend(
        walk_files(&root.join("archived_sessions"))
            .into_iter()
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
            }),
    );

    let found: Vec<FoundSession> = files
        .into_par_iter()
        .filter_map(|path| {
            let meta = codex::extract_session_meta(&path);
            let (project_id, is_virtual) = match bucket_of.get(&path) {
                Some(bucket) => bucket.clone(),
                None => match meta.as_ref().map(|meta| meta.cwd.clone()) {
                    Some(cwd) if !cwd.is_empty() => (cwd, false),
                    _ => ("<codex-unrooted>/unknown".to_string(), true),
                },
            };
            let primary = planned_file(&root, &path)?;
            let id = meta
                .map(|meta| meta.id)
                .filter(|id| !id.is_empty())
                .or_else(|| path.file_stem()?.to_str().map(str::to_owned))?;
            Some(FoundSession {
                project_id,
                is_virtual,
                session: PlannedSession {
                    id,
                    primary: primary.rel.clone(),
                    files: vec![primary],
                },
            })
        })
        .collect();
    Ok(group_sessions(
        SessionSourceKind::Codex,
        root,
        selection,
        &infos,
        found,
    ))
}

fn plan_grok(selection: &SourceSelection) -> Result<PlannedSource, String> {
    let root = archive::source_root(SessionSourceKind::Grok).ok_or("找不到 Grok 会话目录")?;
    let infos = project_infos(grok::get_projects());
    let found = grok::session_dirs()
        .into_iter()
        .filter_map(|dir| {
            let history = dir.join("chat_history.jsonl");
            let meta = grok::extract_session_meta(&history)?;
            let cwd = meta.cwd.filter(|cwd| !cwd.is_empty());
            let primary = archive::relative_to(&root, &history)?;
            Some(FoundSession {
                is_virtual: cwd.is_none(),
                project_id: cwd.unwrap_or_else(|| "<grok-unrooted>".to_string()),
                session: PlannedSession {
                    id: meta.id,
                    primary,
                    files: planned_files(&root, walk_files(&dir)),
                },
            })
        })
        .collect();
    Ok(group_sessions(
        SessionSourceKind::Grok,
        root,
        selection,
        &infos,
        found,
    ))
}

fn plan_omp(selection: &SourceSelection) -> Result<PlannedSource, String> {
    let root = archive::source_root(SessionSourceKind::Omp).ok_or("找不到 OMP 会话目录")?;
    let infos = project_infos(omp::get_projects());
    let found = omp::session_files()
        .into_iter()
        .filter_map(|path| {
            let meta = omp::extract_session_meta(&path)?;
            let primary = planned_file(&root, &path)?;
            let primary_rel = primary.rel.clone();
            // Sibling `<session>/` directory holds the session's artifacts.
            let mut files = planned_files(&root, walk_files(&path.with_extension("")));
            files.push(primary);
            Some(FoundSession {
                project_id: meta.cwd,
                is_virtual: false,
                session: PlannedSession {
                    id: meta.id,
                    primary: primary_rel,
                    files,
                },
            })
        })
        .collect();
    Ok(group_sessions(
        SessionSourceKind::Omp,
        root,
        selection,
        &infos,
        found,
    ))
}

// ── Writing ──

struct Writer<'a> {
    zip: ZipWriter<BufWriter<File>>,
    job: &'a JobHandle,
}

impl Writer<'_> {
    fn options(size: u64) -> SimpleFileOptions {
        SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(size >= u64::from(u32::MAX))
    }

    /// Copy one file; `Ok(None)` if it disappeared since planning.
    fn add_file(&mut self, source: &str, file: &PlannedFile) -> Result<Option<ManifestFile>, String> {
        self.job.update(|job| job.current_item = Some(format!("{source}/{}", file.rel)));
        let mut input = match File::open(&file.abs) {
            Ok(input) => input,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.job.update(|job| job.processed_files += 1);
                return Ok(None);
            }
            Err(e) => return Err(format!("读取 {} 失败：{e}", file.abs.display())),
        };
        let size = input.metadata().map(|meta| meta.len()).unwrap_or(file.size);
        self.zip
            .start_file(archive::entry_name(source, &file.rel), Self::options(size))
            .map_err(|e| format!("写入归档失败：{e}"))?;
        let written = copy_with_progress(&mut input, &mut self.zip, self.job)
            .map_err(|e| format!("复制 {} 失败：{e}", file.abs.display()))?;
        self.job.update(|job| job.processed_files += 1);
        Ok(Some(ManifestFile {
            path: file.rel.clone(),
            size: written,
            mtime: file.mtime,
        }))
    }

    fn add_bytes(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.zip
            .start_file(name, Self::options(bytes.len() as u64))
            .and_then(|_| self.zip.write_all(bytes).map_err(Into::into))
            .map_err(|e| format!("写入归档失败：{e}"))
    }
}

fn jsonl_bytes(rows: impl IntoIterator<Item = String>) -> Vec<u8> {
    let mut out = String::new();
    for row in rows {
        out.push_str(&row);
        out.push('\n');
    }
    out.into_bytes()
}

/// Codex-wide side data for the exported sessions.
fn write_codex_extras(writer: &mut Writer, root: &Path, ids: &HashSet<String>) -> Result<(), String> {
    let id_list: Vec<String> = ids.iter().cloned().collect();
    let db = crate::provider_sync::sqlite_state::db_path(root);
    if db.is_file() {
        let rows = crate::provider_sync::sqlite_state::export_thread_rows(&db, &id_list)?;
        if !rows.is_empty() {
            let lines = rows.into_iter().map(|row| Value::Object(row).to_string());
            writer.add_bytes(archive::CODEX_THREADS, &jsonl_bytes(lines))?;
        }
    }

    if let Ok(file) = File::open(root.join("session_index.jsonl")) {
        let lines: Vec<String> = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter(|line| {
                serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}').trim())
                    .ok()
                    .and_then(|row| row.get("id")?.as_str().map(|id| ids.contains(id)))
                    .unwrap_or(false)
            })
            .collect();
        if !lines.is_empty() {
            writer.add_bytes(archive::CODEX_SESSION_INDEX, &jsonl_bytes(lines))?;
        }
    }

    let mut meta = crate::metadata::try_load_metadata("codex", "")?;
    meta.sessions.retain(|id, _| ids.contains(id));
    if !meta.sessions.is_empty() {
        let bytes = serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?;
        writer.add_bytes(archive::CODEX_VIEWER_META, &bytes)?;
    }
    Ok(())
}

pub(super) fn run(job: &JobHandle, request: &ExportRequest, output: &Path) -> Result<(), String> {
    job.set_phase("scanning");
    let mut plans = Vec::new();
    for selection in &request.sources {
        let kind = SessionSourceKind::parse(&selection.source)?;
        job.update(|job| job.current_item = Some(selection.source.clone()));
        let plan = match kind {
            SessionSourceKind::Claude => plan_claude(selection),
            SessionSourceKind::Codex => plan_codex(selection),
            SessionSourceKind::Grok => plan_grok(selection),
            SessionSourceKind::Omp => plan_omp(selection),
        };
        // A source that is not installed here simply has nothing to export.
        if let Ok(plan) = plan {
            plans.push(plan);
        }
        if job.cancelled() {
            return Err(super::CANCELLED.to_string());
        }
    }

    let all_files = || {
        plans.iter().flat_map(|plan| {
            plan.projects.iter().flat_map(|project| {
                project
                    .files
                    .iter()
                    .chain(project.sessions.iter().flat_map(|session| session.files.iter()))
            })
        })
    };
    let total_files = all_files().count() as u64;
    let total_bytes: u64 = all_files().map(|file| file.size).sum();
    if total_files == 0 {
        return Err("所选范围内没有可导出的会话".to_string());
    }
    job.update(|job| {
        job.total_files = total_files;
        job.total_bytes = total_bytes;
    });

    let partial = output.with_extension("zip.partial");
    let result = write_archive(job, &plans, &partial);
    let summary = match result {
        Ok(summary) => summary,
        Err(error) => {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
    };
    if output.exists() {
        // The save dialog already asked before overwriting.
        let _ = fs::remove_file(output);
    }
    if let Err(e) = fs::rename(&partial, output) {
        let _ = fs::remove_file(&partial);
        return Err(format!("保存归档失败：{e}"));
    }
    let archive_bytes = fs::metadata(output).map(|meta| meta.len()).unwrap_or(0);
    let file_name = output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sessions.zip")
        .to_string();
    job.update(|job| {
        job.export_summary = Some(ExportSummary {
            output_path: output.to_string_lossy().into_owned(),
            file_name,
            archive_bytes,
            ..summary
        });
    });
    Ok(())
}

fn write_archive(job: &JobHandle, plans: &[PlannedSource], partial: &Path) -> Result<ExportSummary, String> {
    let file = File::create(partial).map_err(|e| format!("创建归档失败：{e}"))?;
    let mut writer = Writer {
        zip: ZipWriter::new(BufWriter::new(file)),
        job,
    };
    job.set_phase("copying");

    let mut manifest = Manifest {
        format: archive::FORMAT.to_string(),
        version: archive::VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        host_os: archive::host_os().to_string(),
        file_count: 0,
        total_bytes: 0,
        sources: Vec::new(),
    };
    let mut project_count = 0;
    let mut session_count = 0;
    // (source, absolute primary path) → archive primary, for bookmarks.
    let mut primaries: HashMap<(String, String), String> = HashMap::new();

    for plan in plans {
        let source = archive::source_name(plan.kind);
        let mut manifest_source = ManifestSource {
            source: source.to_string(),
            projects: Vec::new(),
        };
        let mut codex_ids = HashSet::new();
        for project in &plan.projects {
            let mut sessions = Vec::new();
            for session in &project.sessions {
                let mut files = Vec::new();
                for file in &session.files {
                    if let Some(written) = writer.add_file(source, file)? {
                        files.push(written);
                    }
                }
                if !files.iter().any(|file| file.path == session.primary) {
                    continue; // deleted while exporting
                }
                if let Some(primary) = session.files.iter().find(|f| f.rel == session.primary) {
                    primaries.insert(
                        (source.to_string(), primary.abs.to_string_lossy().into_owned()),
                        session.primary.clone(),
                    );
                }
                if plan.kind == SessionSourceKind::Codex {
                    codex_ids.insert(session.id.clone());
                }
                sessions.push(ManifestSession {
                    id: session.id.clone(),
                    primary: session.primary.clone(),
                    files,
                });
            }
            let mut files = Vec::new();
            for file in &project.files {
                if let Some(written) = writer.add_file(source, file)? {
                    files.push(written);
                }
            }
            if sessions.is_empty() && files.is_empty() {
                continue;
            }
            project_count += 1;
            session_count += sessions.len();
            manifest_source.projects.push(ManifestProject {
                id: project.id.clone(),
                name: project.name.clone(),
                path: project.path.clone(),
                sessions,
                files,
            });
        }
        if plan.kind == SessionSourceKind::Codex && !codex_ids.is_empty() {
            job.update(|job| job.current_item = Some("codex state".to_string()));
            write_codex_extras(&mut writer, &plan.root, &codex_ids)?;
        }
        if !manifest_source.projects.is_empty() {
            manifest.sources.push(manifest_source);
        }
    }
    if session_count == 0 {
        return Err("所选范围内没有可导出的会话".to_string());
    }

    let bookmarks: Vec<ArchivedBookmark> = crate::bookmarks::load_bookmarks()?
        .bookmarks
        .into_iter()
        .filter_map(|bookmark| {
            let canonical = fs::canonicalize(&bookmark.file_path)
                .ok()
                .map(|path| path.to_string_lossy().into_owned());
            let primary = [Some(bookmark.file_path.clone()), canonical]
                .into_iter()
                .flatten()
                .find_map(|path| primaries.get(&(bookmark.source.clone(), path)).cloned())?;
            Some(ArchivedBookmark {
                source: bookmark.source.clone(),
                primary,
                bookmark,
            })
        })
        .collect();
    if !bookmarks.is_empty() {
        let bytes = serde_json::to_vec_pretty(&bookmarks).map_err(|e| e.to_string())?;
        writer.add_bytes(archive::BOOKMARKS, &bytes)?;
    }

    let all = manifest.sources.iter().flat_map(|source| {
        source.projects.iter().flat_map(|project| {
            project
                .files
                .iter()
                .chain(project.sessions.iter().flat_map(|session| session.files.iter()))
        })
    });
    let (file_count, total_bytes) = all.fold((0u64, 0u64), |(count, bytes), file| (count + 1, bytes + file.size));
    manifest.file_count = file_count;
    manifest.total_bytes = total_bytes;

    job.set_phase("finishing");
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    writer.add_bytes(archive::MANIFEST, &manifest_bytes)?;
    let buffered = writer
        .zip
        .finish()
        .map_err(|e| format!("完成归档失败：{e}"))?;
    let file = buffered
        .into_inner()
        .map_err(|e| format!("写入归档失败：{}", e.error()))?;
    file.sync_all().map_err(|e| format!("写入归档失败：{e}"))?;

    Ok(ExportSummary {
        output_path: String::new(),
        file_name: String::new(),
        project_count,
        session_count,
        file_count,
        total_bytes,
        archive_bytes: 0,
    })
}
