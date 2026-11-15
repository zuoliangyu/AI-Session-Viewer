use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Claude raw record types ──

/// A raw JSONL record from a Claude session file
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct RawRecord {
    #[serde(rename = "type")]
    pub record_type: String,
    pub uuid: Option<String>,
    pub parent_uuid: Option<String>,
    pub session_id: Option<String>,
    pub timestamp: Option<String>,
    pub message: Option<RawMessage>,
    #[serde(default)]
    pub is_sidechain: Option<bool>,
    pub cwd: Option<String>,
    pub version: Option<String>,
    pub git_branch: Option<String>,
    pub slug: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawMessage {
    pub role: String,
    pub content: ContentValue,
    pub model: Option<String>,
}

/// Content can be a simple string or an array of content blocks
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ContentValue {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

/// A single content block in a Claude message
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: Option<Value>,
        #[serde(default)]
        is_error: Option<bool>,
    },
    #[serde(other)]
    Unknown,
}

// ── Unified display types (sent to frontend) ──

/// A display-ready message for the frontend
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayMessage {
    pub uuid: Option<String>,
    pub parent_uuid: Option<String>,
    pub role: String,
    pub timestamp: Option<String>,
    pub model: Option<String>,
    pub content: Vec<DisplayContentBlock>,
}

/// Unified content block enum covering Claude, Codex, and Grok types
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DisplayContentBlock {
    // Shared
    #[serde(rename = "text")]
    Text { text: String },
    // Claude-specific
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: String,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
    // Codex-specific
    #[serde(rename = "reasoning")]
    Reasoning { text: String },
    #[serde(rename = "function_call")]
    FunctionCall {
        name: String,
        arguments: String,
        call_id: String,
    },
    #[serde(rename = "function_call_output")]
    FunctionCallOutput { call_id: String, output: String },
}

/// A lightweight, session-wide user-question index for navigation and summaries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionIndexEntry {
    pub message_index: usize,
    pub message_id: String,
    pub preview: String,
    pub timestamp: Option<String>,
    pub parent_message_index: Option<usize>,
    pub reply_preview: String,
    pub reply_model: Option<String>,
    pub reply_timestamp: Option<String>,
    pub has_tool: bool,
}

/// A streaming projection: no tool arguments, results, or full message bodies.
pub(crate) struct NavigationMessage {
    pub uuid: Option<String>,
    pub parent_uuid: Option<String>,
    pub role: String,
    pub timestamp: Option<String>,
    pub model: Option<String>,
    pub preview: String,
    pub has_tool: bool,
}

impl NavigationMessage {
    pub(crate) fn from_display(message: &DisplayMessage) -> Self {
        Self {
            uuid: message.uuid.clone(),
            parent_uuid: message.parent_uuid.clone(),
            role: message.role.clone(),
            timestamp: message.timestamp.clone(),
            model: message.model.clone(),
            preview: preview_texts(
                message.content.iter().filter_map(|block| match block {
                    DisplayContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                }),
                if message.role == "user" { 200 } else { 220 },
            ),
            has_tool: message.content.iter().any(|block| {
                matches!(
                    block,
                    DisplayContentBlock::ToolUse { .. } | DisplayContentBlock::FunctionCall { .. }
                )
            }),
        }
    }
}

/// Build one navigation item for each user prompt without returning the full
/// transcript. Parent and reply data are derived from the same visible-message
/// graph that the message page receives.
pub fn question_index(messages: &[DisplayMessage]) -> Vec<QuestionIndexEntry> {
    let messages: Vec<_> = messages
        .iter()
        .map(NavigationMessage::from_display)
        .collect();
    question_index_from_navigation(&messages)
}

pub(crate) fn question_index_from_navigation(
    messages: &[NavigationMessage],
) -> Vec<QuestionIndexEntry> {
    let message_indices: HashMap<_, _> = messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            message
                .uuid
                .as_deref()
                .filter(|id| !id.is_empty())
                .map(|id| (id, index))
        })
        .collect();
    let parents: Vec<_> = messages
        .iter()
        .map(|message| {
            message
                .parent_uuid
                .as_deref()
                .and_then(|id| message_indices.get(id).copied())
        })
        .collect();
    let mut children = vec![Vec::new(); messages.len()];
    for (index, parent) in parents.iter().enumerate() {
        if let Some(parent) = parent {
            children[*parent].push(index);
        }
    }
    // Reuse one visitation array. Clearing N flags per question made even a
    // simple alternating user/assistant chain quadratic in its message count.
    let mut visited = vec![0usize; messages.len()];

    messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message.role == "user")
        .map(|(index, message)| {
            let parent_message_index = nearest_user_parent(index, messages, &parents);
            let reply = first_assistant_descendant(index, messages, &children, &mut visited);
            let (reply_preview, reply_model, reply_timestamp, has_tool) = reply
                .map(|message| {
                    (
                        message.preview.clone(),
                        message.model.clone(),
                        message.timestamp.clone(),
                        message.has_tool,
                    )
                })
                .unwrap_or_else(|| (String::new(), None, None, false));

            QuestionIndexEntry {
                message_index: index,
                message_id: message
                    .uuid
                    .clone()
                    .filter(|id| !id.is_empty())
                    .unwrap_or_else(|| format!("user-{index}")),
                preview: message.preview.clone(),
                timestamp: message.timestamp.clone(),
                parent_message_index,
                reply_preview,
                reply_model,
                reply_timestamp,
                has_tool,
            }
        })
        .collect()
}

fn nearest_user_parent(
    index: usize,
    messages: &[NavigationMessage],
    parents: &[Option<usize>],
) -> Option<usize> {
    let mut current = parents[index];
    for _ in 0..messages.len() {
        let parent = current?;
        if messages[parent].role == "user" {
            return Some(parent);
        }
        current = parents[parent];
    }
    None
}

fn first_assistant_descendant<'a>(
    index: usize,
    messages: &'a [NavigationMessage],
    children: &[Vec<usize>],
    visited: &mut [usize],
) -> Option<&'a NavigationMessage> {
    let mut stack: Vec<_> = children[index].iter().rev().copied().collect();
    let generation = index + 1;
    while let Some(current) = stack.pop() {
        if visited[current] == generation {
            continue;
        }
        visited[current] = generation;
        if messages[current].role == "assistant" {
            return Some(&messages[current]);
        }
        stack.extend(children[current].iter().rev().copied());
    }
    None
}

pub(crate) fn preview_texts<'a>(texts: impl Iterator<Item = &'a str>, limit: usize) -> String {
    let mut preview = String::new();
    let mut count = 0;
    for text in texts.map(str::trim).filter(|text| !text.is_empty()) {
        let separator = (!preview.is_empty()).then_some(' ');
        for ch in separator.into_iter().chain(text.chars()) {
            if count == limit {
                preview.push_str("...");
                return preview;
            }
            preview.push(ch);
            count += 1;
        }
    }
    preview
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedMessages {
    pub messages: Vec<DisplayMessage>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
    pub has_more: bool,
}

/// Result of a range-based message load: returns the slice
/// `messages[start..end)` along with the total count so the frontend can
/// extend the loaded window in either direction.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeMessages {
    pub messages: Vec<DisplayMessage>,
    pub total: usize,
    pub start: usize,
    pub end: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(
        id: &str,
        parent_id: Option<&str>,
        role: &str,
        content: Vec<DisplayContentBlock>,
    ) -> DisplayMessage {
        DisplayMessage {
            uuid: Some(id.to_string()),
            parent_uuid: parent_id.map(str::to_string),
            role: role.to_string(),
            timestamp: Some("2026-09-04T00:00:00Z".to_string()),
            model: (role == "assistant").then(|| "test-model".to_string()),
            content,
        }
    }

    #[test]
    fn question_index_follows_visible_parent_chain_and_reply_metadata() {
        let messages = vec![
            message(
                "user-1",
                None,
                "user",
                vec![DisplayContentBlock::Text {
                    text: "First question".to_string(),
                }],
            ),
            message(
                "assistant-1",
                Some("user-1"),
                "assistant",
                vec![
                    DisplayContentBlock::Text {
                        text: "First reply".to_string(),
                    },
                    DisplayContentBlock::ToolUse {
                        id: "tool-1".to_string(),
                        name: "read".to_string(),
                        input: "{}".to_string(),
                    },
                ],
            ),
            message(
                "user-2",
                Some("assistant-1"),
                "user",
                vec![DisplayContentBlock::Text {
                    text: "Follow-up question".to_string(),
                }],
            ),
        ];

        let entries = question_index(&messages);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message_id, "user-1");
        assert_eq!(entries[0].reply_preview, "First reply");
        assert_eq!(entries[0].reply_model.as_deref(), Some("test-model"));
        assert!(entries[0].has_tool);
        assert_eq!(entries[1].message_id, "user-2");
        assert_eq!(entries[1].parent_message_index, Some(0));
    }

    #[test]
    fn preview_stops_at_the_limit_without_consuming_later_blocks() {
        let mut calls = 0;
        let preview = preview_texts(
            ["内容".repeat(200), "unused".to_string()]
                .iter()
                .map(|text| {
                    calls += 1;
                    text.as_str()
                }),
            200,
        );
        assert_eq!(preview.chars().count(), 203);
        assert_eq!(calls, 1);
        assert_eq!(preview_texts([" a ", "", " b "].into_iter(), 3), "a b");
    }

    #[test]
    fn navigation_visits_independent_branches_and_terminates_on_cycles() {
        let messages = vec![
            message("u1", Some("t1"), "user", vec![]),
            message("t1", Some("u1"), "tool", vec![]),
            message("u2", Some("t1"), "user", vec![]),
            message(
                "answer",
                Some("u2"),
                "assistant",
                vec![DisplayContentBlock::Text {
                    text: "found".to_string(),
                }],
            ),
        ];
        let entries = question_index(&messages);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].reply_preview, "found");
        assert_eq!(entries[1].reply_preview, "found");
    }
}
