use rayon::prelude::*;
use serde::Serialize;
use std::fs;

use crate::metadata;
use crate::models::message::DisplayContentBlock;
use crate::provider::{claude, codex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub source: String,
    pub project_id: String,
    pub project_name: String,
    pub session_id: String,
    pub first_prompt: Option<String>,
    pub alias: Option<String>,
    pub tags: Option<Vec<String>>,
    pub matched_text: String,
    pub role: String,
    pub timestamp: Option<String>,
    pub file_path: String,
    pub total_message_count: u32,
    pub matched_message_id: Option<String>,
}

/// Safely truncate a string to approximately `max_chars` characters
fn safe_truncate(s: &str, max_chars: usize) -> String {
    let truncated: String = s.chars().take(max_chars).collect();
    if truncated.len() < s.len() {
        format!("{}...", truncated)
    } else {
        truncated
    }
}

/// Extract a context window around a match, operating on characters (not bytes)
fn extract_context(text: &str, query_lower: &str, context_chars: usize) -> String {
    let text_lower = text.to_lowercase();

    let text_chars: Vec<char> = text.chars().collect();
    let lower_chars: Vec<char> = text_lower.chars().collect();
    let query_chars: Vec<char> = query_lower.chars().collect();
    let query_len = query_chars.len();

    let match_pos = lower_chars
        .windows(query_len)
        .position(|w| w == query_chars.as_slice());

    match match_pos {
        Some(pos) => {
            let start = pos.saturating_sub(context_chars);
            let end = (pos + query_len + context_chars).min(text_chars.len());
            text_chars[start..end].iter().collect()
        }
        None => safe_truncate(text, context_chars * 2),
    }
}

/// Extract searchable text from a DisplayContentBlock
fn block_text(block: &DisplayContentBlock) -> &str {
    match block {
        DisplayContentBlock::Text { text } => text,
        DisplayContentBlock::Thinking { thinking } => thinking,
        DisplayContentBlock::ToolUse { input, .. } => input,
        DisplayContentBlock::ToolResult { content, .. } => content,
        DisplayContentBlock::Reasoning { text } => text,
        DisplayContentBlock::FunctionCall { arguments, .. } => arguments,
        DisplayContentBlock::FunctionCallOutput { output, .. } => output,
    }
}

pub fn global_search(
    source: &str,
    query: &str,
    max_results: usize,
) -> Result<Vec<SearchResult>, String> {
    let query_lower = query.to_lowercase();

    let results: Vec<SearchResult> = match source {
        "claude" => search_claude(&query_lower, max_results),
        "codex" => search_codex(&query_lower, max_results),
        _ => return Err(format!("Unknown source: {}", source)),
    };

    Ok(results)
}

fn search_claude(query_lower: &str, max_results: usize) -> Vec<SearchResult> {
    let jsonl_files = claude::collect_all_jsonl_files();

    // Pre-load metadata per project for alias lookup
    let mut meta_cache: std::collections::HashMap<String, metadata::MetadataFile> =
        std::collections::HashMap::new();
    for (encoded_name, _, _) in &jsonl_files {
        meta_cache
            .entry(encoded_name.clone())
            .or_insert_with(|| metadata::load_metadata("claude", encoded_name));
    }

    let results: Vec<SearchResult> = jsonl_files
        .par_iter()
        .flat_map(|(encoded_name, project_name, file_path)| {
            let session_id = file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            let mut file_results: Vec<SearchResult> = Vec::new();

            let content = match fs::read_to_string(file_path) {
                Ok(c) => c,
                Err(_) => return file_results,
            };

            if !content.to_lowercase().contains(query_lower) {
                return file_results;
            }

            // Lookup alias and tags from metadata
            let session_meta = meta_cache
                .get(encoded_name)
                .and_then(|m| m.sessions.get(&session_id));
            let alias = session_meta.and_then(|s| s.alias.clone());
            let tags = session_meta
                .map(|s| s.tags.clone())
                .filter(|t| !t.is_empty());

            if let Ok(messages) = claude::parse_all_messages(file_path) {
                let total_message_count = messages.len() as u32;
                let mut session_name_matched = false;
                let mut message_match_count = 0usize;

                // Check alias for session-name match
                if let Some(a) = &alias {
                    if a.to_lowercase().contains(query_lower) {
                        session_name_matched = true;
                        file_results.push(SearchResult {
                            source: "claude".to_string(),
                            project_id: encoded_name.clone(),
                            project_name: project_name.clone(),
                            session_id: session_id.clone(),
                            first_prompt: None,
                            alias: alias.clone(),
                            tags: tags.clone(),
                            matched_text: a.clone(),
                            role: "session".to_string(),
                            timestamp: None,
                            file_path: file_path.to_string_lossy().to_string(),
                            total_message_count,
                            matched_message_id: None,
                        });
                    }
                }

                let mut first_prompt = None;
                for msg in &messages {
                    if msg.role == "user" && first_prompt.is_none() {
                        for block in &msg.content {
                            if let DisplayContentBlock::Text { text } = block {
                                first_prompt = Some(safe_truncate(text, 100));
                                // Check first_prompt for session-name match (only once, and only if alias didn't already match)
                                if !session_name_matched && text.to_lowercase().contains(query_lower) {
                                    session_name_matched = true;
                                    file_results.push(SearchResult {
                                        source: "claude".to_string(),
                                        project_id: encoded_name.clone(),
                                        project_name: project_name.clone(),
                                        session_id: session_id.clone(),
                                        first_prompt: first_prompt.clone(),
                                        alias: alias.clone(),
                                        tags: tags.clone(),
                                        matched_text: safe_truncate(text, 100),
                                        role: "session".to_string(),
                                        timestamp: msg.timestamp.clone(),
                                        file_path: file_path.to_string_lossy().to_string(),
                                        total_message_count,
                                        matched_message_id: msg.uuid.clone(),
                                    });
                                }
                                break;
                            }
                        }
                    }

                    for block in &msg.content {
                        let text = block_text(block);

                        if text.to_lowercase().contains(query_lower) {
                            let matched_text = extract_context(text, query_lower, 50);

                            file_results.push(SearchResult {
                                source: "claude".to_string(),
                                project_id: encoded_name.clone(),
                                project_name: project_name.clone(),
                                session_id: session_id.clone(),
                                first_prompt: first_prompt.clone(),
                                alias: alias.clone(),
                                tags: tags.clone(),
                                matched_text,
                                role: msg.role.clone(),
                                timestamp: msg.timestamp.clone(),
                                file_path: file_path.to_string_lossy().to_string(),
                                total_message_count,
                                matched_message_id: msg.uuid.clone(),
                            });

                            message_match_count += 1;
                            if message_match_count >= 5 {
                                return file_results;
                            }
                        }
                    }
                }
            }

            file_results
        })
        .collect();

    let mut results = results;
    results.truncate(max_results);
    results
}

fn search_codex(query_lower: &str, max_results: usize) -> Vec<SearchResult> {
    let files = codex::scan_all_session_files();

    // Pre-load codex metadata (single file for all sessions)
    let codex_meta = metadata::load_metadata("codex", "");

    let results: Vec<SearchResult> = files
        .par_iter()
        .flat_map(|file_path| {
            let mut file_results: Vec<SearchResult> = Vec::new();

            let content = match fs::read_to_string(file_path) {
                Ok(c) => c,
                Err(_) => return file_results,
            };

            if !content.to_lowercase().contains(query_lower) {
                return file_results;
            }

            let meta = codex::extract_session_meta(file_path);
            let (session_id, cwd) = match &meta {
                Some(m) => (m.id.clone(), m.cwd.clone()),
                None => {
                    let stem = file_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    (stem, String::new())
                }
            };
            let short_name = cwd
                .rsplit(['/', '\\'])
                .find(|s| !s.is_empty())
                .unwrap_or(&cwd)
                .to_string();

            let session_meta = codex_meta.sessions.get(&session_id);
            let alias = session_meta.and_then(|s| s.alias.clone());
            let tags = session_meta
                .map(|s| s.tags.clone())
                .filter(|t| !t.is_empty());

            if let Ok(messages) = codex::parse_all_messages(file_path) {
                let total_message_count = messages.len() as u32;
                let mut session_name_matched = false;
                let mut message_match_count = 0usize;

                // Check alias for session-name match
                if let Some(a) = &alias {
                    if a.to_lowercase().contains(query_lower) {
                        session_name_matched = true;
                        file_results.push(SearchResult {
                            source: "codex".to_string(),
                            project_id: cwd.clone(),
                            project_name: short_name.clone(),
                            session_id: session_id.clone(),
                            first_prompt: None,
                            alias: alias.clone(),
                            tags: tags.clone(),
                            matched_text: a.clone(),
                            role: "session".to_string(),
                            timestamp: None,
                            file_path: file_path.to_string_lossy().to_string(),
                            total_message_count,
                            matched_message_id: None,
                        });
                    }
                }

                let mut first_prompt = None;
                for msg in &messages {
                    if msg.role == "user" && first_prompt.is_none() {
                        for block in &msg.content {
                            if let DisplayContentBlock::Text { text } = block {
                                first_prompt = Some(safe_truncate(text, 100));
                                // Check first_prompt for session-name match (only once, and only if alias didn't already match)
                                if !session_name_matched && text.to_lowercase().contains(query_lower) {
                                    session_name_matched = true;
                                    file_results.push(SearchResult {
                                        source: "codex".to_string(),
                                        project_id: cwd.clone(),
                                        project_name: short_name.clone(),
                                        session_id: session_id.clone(),
                                        first_prompt: first_prompt.clone(),
                                        alias: alias.clone(),
                                        tags: tags.clone(),
                                        matched_text: safe_truncate(text, 100),
                                        role: "session".to_string(),
                                        timestamp: msg.timestamp.clone(),
                                        file_path: file_path.to_string_lossy().to_string(),
                                        total_message_count,
                                        matched_message_id: msg.uuid.clone(),
                                    });
                                }
                                break;
                            }
                        }
                    }

                    for block in &msg.content {
                        let text = block_text(block);

                        if text.to_lowercase().contains(query_lower) {
                            let matched_text = extract_context(text, query_lower, 50);

                            file_results.push(SearchResult {
                                source: "codex".to_string(),
                                project_id: cwd.clone(),
                                project_name: short_name.clone(),
                                session_id: session_id.clone(),
                                first_prompt: first_prompt.clone(),
                                alias: alias.clone(),
                                tags: tags.clone(),
                                matched_text,
                                role: msg.role.clone(),
                                timestamp: msg.timestamp.clone(),
                                file_path: file_path.to_string_lossy().to_string(),
                                total_message_count,
                                matched_message_id: msg.uuid.clone(),
                            });

                            message_match_count += 1;
                            if message_match_count >= 5 {
                                return file_results;
                            }
                        }
                    }
                }
            }

            file_results
        })
        .collect();

    let mut results = results;
    results.truncate(max_results);
    results
}
