use serde::{Deserialize, Serialize};

/// A single discovered skill (one `SKILL.md` directory).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    /// Display name from frontmatter `name`, falling back to the directory slug.
    pub name: String,
    /// Frontmatter `description` (may be empty).
    pub description: String,
    /// Absolute path to the skill's `SKILL.md`.
    pub path: String,
    /// "global" | "project" | "plugin"
    pub scope: String,
    /// For plugin skills: the marketplace / source directory name. None otherwise.
    pub source_label: Option<String>,
    /// Directory name (slug) the skill lives in.
    pub slug: String,
    /// True when the skill directory is a symlink (e.g. global `lark-*`).
    /// Deleting such a skill only removes the link, not its target.
    pub is_symlink: bool,
}

/// Outcome of importing skills from an archive.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Slugs that were written.
    pub imported: Vec<String>,
    /// Slugs skipped because they already existed (and overwrite was off).
    pub skipped: Vec<String>,
    /// Per-entry error messages (extraction continued past these).
    pub errors: Vec<String>,
}

/// Grouped result of a skills scan.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillsResult {
    /// Global skills under `~/.claude/skills/`.
    pub global: Vec<SkillEntry>,
    /// Plugin / marketplace skills under `~/.claude/plugins/`.
    pub plugin: Vec<SkillEntry>,
    /// Project-level skills under `<project>/.claude/skills/` (empty when no
    /// project path was supplied or the project has none).
    pub project: Vec<SkillEntry>,
    /// The project path that was scanned, echoed back for the UI. None when no
    /// project path was supplied.
    pub project_path: Option<String>,
}
