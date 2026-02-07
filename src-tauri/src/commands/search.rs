use rayon::prelude::*;
use serde::Serialize;
use std::fs;

use crate::parser::jsonl::parse_all_messages;
use crate::parser::path_encoder::{decode_project_path, get_projects_dir, short_name_from_path};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub encoded_name: String,
    pub project_name: String,
    pub session_id: String,
    pub first_prompt: Option<String>,
    pub matched_text: String,
    pub role: String,
    pub timestamp: Option<String>,
}

#[tauri::command]
pub fn global_search(query: String, max_results: usize) -> Result<Vec<SearchResult>, String> {
    let projects_dir = get_projects_dir().ok_or("Could not find Claude projects directory")?;

    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let query_lower = query.to_lowercase();

    // Collect all JSONL file paths
    let mut jsonl_files: Vec<(String, String, std::path::PathBuf)> = Vec::new();

    let project_dirs = fs::read_dir(&projects_dir)
        .map_err(|e| format!("Failed to read projects dir: {}", e))?;

    for entry in project_dirs.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let encoded_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        let display_path = decode_project_path(&encoded_name);
        let project_name = short_name_from_path(&display_path);

        if let Ok(files) = fs::read_dir(&path) {
            for file_entry in files.flatten() {
                let file_path = file_entry.path();
                if file_path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    jsonl_files.push((encoded_name.clone(), project_name.clone(), file_path));
                }
            }
        }
    }

    // Parallel search across all files
    let results: Vec<SearchResult> = jsonl_files
        .par_iter()
        .flat_map(|(encoded_name, project_name, file_path)| {
            let session_id = file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            let mut file_results: Vec<SearchResult> = Vec::new();

            // Quick pre-check: does the file contain the query at all?
            let content = match fs::read_to_string(file_path) {
                Ok(c) => c,
                Err(_) => return file_results,
            };

            if !content.to_lowercase().contains(&query_lower) {
                return file_results;
            }

            // Parse and search through messages
            if let Ok(messages) = parse_all_messages(file_path) {
                let mut first_prompt = None;
                for msg in &messages {
                    if msg.role == "user" && first_prompt.is_none() {
                        for block in &msg.content {
                            if let crate::models::message::DisplayContentBlock::Text { text } =
                                block
                            {
                                first_prompt = Some(if text.len() > 100 {
                                    format!("{}...", &text[..100])
                                } else {
                                    text.clone()
                                });
                                break;
                            }
                        }
                    }

                    for block in &msg.content {
                        let text = match block {
                            crate::models::message::DisplayContentBlock::Text { text } => text,
                            crate::models::message::DisplayContentBlock::Thinking { thinking } => {
                                thinking
                            }
                            crate::models::message::DisplayContentBlock::ToolUse {
                                input, ..
                            } => input,
                            crate::models::message::DisplayContentBlock::ToolResult {
                                content,
                                ..
                            } => content,
                        };

                        if text.to_lowercase().contains(&query_lower) {
                            // Extract context around the match
                            let lower_text = text.to_lowercase();
                            let pos = lower_text.find(&query_lower).unwrap_or(0);
                            let start = pos.saturating_sub(50);
                            let end = (pos + query.len() + 50).min(text.len());
                            let matched_text = text[start..end].to_string();

                            file_results.push(SearchResult {
                                encoded_name: encoded_name.clone(),
                                project_name: project_name.clone(),
                                session_id: session_id.clone(),
                                first_prompt: first_prompt.clone(),
                                matched_text,
                                role: msg.role.clone(),
                                timestamp: msg.timestamp.clone(),
                            });

                            if file_results.len() >= 5 {
                                return file_results;
                            }
                        }
                    }
                }
            }

            file_results
        })
        .collect();

    // Limit total results
    let mut results = results;
    results.truncate(max_results);

    Ok(results)
}
