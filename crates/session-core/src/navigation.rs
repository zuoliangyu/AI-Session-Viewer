//! Session navigation shares a small index without warming the full-message cache.
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

use lru::LruCache;
use parking_lot::Mutex;
use serde::Serialize;

use crate::models::message::{
    question_index_from_navigation, NavigationMessage, QuestionIndexEntry,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageLocation {
    pub message_index: Option<usize>,
}

struct NavigationIndex {
    questions: Vec<QuestionIndexEntry>,
    locations: HashMap<String, usize>,
}

impl NavigationIndex {
    fn new(messages: Vec<NavigationMessage>) -> Self {
        let questions = question_index_from_navigation(&messages);
        let mut locations = HashMap::with_capacity(messages.len());
        // Real identifiers take priority over synthetic role/index identifiers.
        for (index, message) in messages.iter().enumerate() {
            if let Some(id) = message.uuid.as_ref().filter(|id| !id.is_empty()) {
                locations.entry(id.clone()).or_insert(index);
            }
        }
        for (index, message) in messages.iter().enumerate() {
            if message.uuid.as_ref().map_or(true, String::is_empty) {
                locations
                    .entry(format!("{}-{index}", message.role))
                    .or_insert(index);
            }
        }
        Self {
            questions,
            locations,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileSignature {
    modified: SystemTime,
    length: u64,
}

fn signature(path: &Path) -> Result<FileSignature, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(FileSignature {
        modified: metadata.modified().map_err(|error| error.to_string())?,
        length: metadata.len(),
    })
}

struct CachedIndex {
    signature: FileSignature,
    index: Arc<NavigationIndex>,
}

type CacheSlot = Arc<Mutex<Option<CachedIndex>>>;
type CacheKey = (String, PathBuf);

fn cache() -> &'static Mutex<LruCache<CacheKey, CacheSlot>> {
    static CACHE: OnceLock<Mutex<LruCache<CacheKey, CacheSlot>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new(NonZeroUsize::new(20).unwrap())))
}

pub(crate) fn clear_cache() {
    cache().lock().clear();
}

pub(crate) fn clear_cache_for_path(path: &Path) {
    let mut cache = cache().lock();
    let keys: Vec<_> = cache
        .iter()
        .filter(|((_, cached_path), _)| cached_path == path)
        .map(|(key, _)| key.clone())
        .collect();
    for key in keys {
        cache.pop(&key);
    }
}

fn read_index(source: &str, path: &Path) -> Result<Arc<NavigationIndex>, String> {
    let key = (source.to_string(), path.to_path_buf());
    let slot = {
        let mut cache = cache().lock();
        if let Some(slot) = cache.get(&key) {
            slot.clone()
        } else {
            let slot = Arc::new(Mutex::new(None));
            cache.put(key, slot.clone());
            slot
        }
    };
    // Only builders for this session wait for one another; other sessions and
    // the windowed message cache remain available while its file is scanned.
    let mut cached = slot.lock();
    for _ in 0..2 {
        let before = signature(path)?;
        if let Some(entry) = cached.as_ref() {
            if entry.signature == before {
                return Ok(entry.index.clone());
            }
        }
        let messages = match source {
            "claude" => crate::parser::jsonl::parse_navigation_messages(path),
            "codex" => crate::provider::codex::parse_navigation_messages(path),
            "grok" => crate::provider::grok::parse_navigation_messages(path),
            "omp" => crate::provider::omp::parse_navigation_messages(path),
            _ => return Err(format!("Unknown source: {source}")),
        }?;
        if signature(path)? != before {
            continue;
        }
        let index = Arc::new(NavigationIndex::new(messages));
        *cached = Some(CachedIndex {
            signature: before,
            index: index.clone(),
        });
        return Ok(index);
    }
    Err("会话文件正在变化，请重试导航请求".to_string())
}

pub fn question_index(source: &str, path: &Path) -> Result<Vec<QuestionIndexEntry>, String> {
    Ok(read_index(source, path)?.questions.clone())
}

pub fn message_location(
    source: &str,
    path: &Path,
    message_id: &str,
) -> Result<MessageLocation, String> {
    Ok(MessageLocation {
        message_index: read_index(source, path)?.locations.get(message_id).copied(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::message::{question_index as full_question_index, DisplayMessage};
    use serde_json::{json, Value};
    use std::io::Write;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(rows: &[Value]) -> Self {
            let path =
                std::env::temp_dir().join(format!("asv-navigation-{}.jsonl", uuid::Uuid::new_v4()));
            let content = rows
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(&path, format!("{content}\n")).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            crate::state::clear_message_cache_for_path(&self.0);
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn assert_parity(source: &str, fixture: &Fixture) -> Vec<DisplayMessage> {
        let questions = question_index(source, &fixture.0).unwrap();
        assert!(crate::state::get_cached_full_messages(&fixture.0)
            .unwrap()
            .is_none());
        let messages = match source {
            "claude" => crate::parser::jsonl::parse_all_messages(&fixture.0),
            "codex" => crate::provider::codex::parse_all_messages(&fixture.0),
            "grok" => crate::provider::grok::parse_all_messages(&fixture.0),
            "omp" => crate::provider::omp::parse_all_messages(&fixture.0),
            _ => unreachable!(),
        }
        .unwrap();
        assert_eq!(
            serde_json::to_value(&questions).unwrap(),
            serde_json::to_value(full_question_index(&messages)).unwrap()
        );
        for (index, message) in messages.iter().enumerate() {
            let id = message
                .uuid
                .clone()
                .unwrap_or_else(|| format!("{}-{index}", message.role));
            assert_eq!(
                message_location(source, &fixture.0, &id)
                    .unwrap()
                    .message_index,
                Some(index)
            );
        }
        assert_eq!(
            message_location(source, &fixture.0, "missing")
                .unwrap()
                .message_index,
            None
        );
        messages
    }

    #[test]
    fn claude_navigation_matches_tool_roles_previews_and_fallback_ids() {
        let fixture = Fixture::new(&[
            json!({"type":"user","uuid":"u1","message":{"role":"user","content":"问题".repeat(300)}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"回答"},{"type":"tool_use","id":"call","name":"read","input":{"large":"x".repeat(10000)}}]}}),
            json!({"type":"user","uuid":"t1","parentUuid":"a1","message":{"role":"user","content":[{"type":"text","text":" "},{"type":"tool_result","tool_use_id":"call","content":"result"}]}}),
            json!({"type":"user","parentUuid":"t1","message":{"role":"user","content":"无UUID"}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"想法"}]}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"image","source":{}}]}}),
        ]);
        let messages = assert_parity("claude", &fixture);
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[2].role, "tool");
        let questions = question_index("claude", &fixture.0).unwrap();
        assert_eq!(questions[1].message_id, "user-3");
        assert_eq!(questions[1].parent_message_index, Some(0));
        assert_eq!(questions[0].preview.chars().count(), 203);
    }

    #[test]
    fn codex_navigation_uses_the_same_rollback_and_line_ids() {
        let rows = vec![
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"one"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":"keep"}}),
            json!({"type":"response_item","payload":{"type":"function_call","name":"read","arguments":"{}","call_id":"call"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","output":"data","call_id":"call"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":"done"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"two"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":"rolled back"}}),
            json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":"replacement"}}),
        ];
        let removed_id = crate::fork::line_message_id(6, &rows[6]);
        let fixture = Fixture::new(&rows);
        assert_eq!(assert_parity("codex", &fixture).len(), 5);
        assert_eq!(
            message_location("codex", &fixture.0, &removed_id)
                .unwrap()
                .message_index,
            None
        );
    }

    #[test]
    fn grok_navigation_preserves_hidden_context_and_visible_line_ids() {
        let fixture = Fixture::new(&[
            json!({"type":"user","content":"<system-reminder>hidden</system-reminder>"}),
            json!({"type":"user","content":"<user_info>context</user_info><user_query>question</user_query>"}),
            json!({"type":"reasoning","summary":"thought"}),
            json!({"type":"assistant","model_id":"grok","content":"answer"}),
            json!({"type":"user","synthetic_reason":"context","content":"hidden"}),
        ]);
        assert_eq!(assert_parity("grok", &fixture).len(), 3);
        assert_eq!(
            question_index("grok", &fixture.0).unwrap()[0].preview,
            "question"
        );
    }

    #[test]
    fn omp_navigation_keeps_branches_and_skips_invisible_parent_nodes() {
        let fixture = Fixture::new(&[
            json!({"type":"message","id":"u1","message":{"role":"user","content":"root"}}),
            json!({"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","model":"m","content":[{"type":"toolCall","id":"call","name":"read","arguments":{"file":"x"}}]}}),
            json!({"type":"message","id":"t1","parentId":"a1","message":{"role":"toolResult","toolCallId":"call","content":"data"}}),
            json!({"type":"compaction","id":"c1","parentId":"t1"}),
            json!({"type":"message","id":"u2","parentId":"c1","message":{"role":"user","content":"continuation"}}),
            json!({"type":"message","id":"branch","parentId":"u1","message":{"role":"user","content":"branch"}}),
            json!({"type":"message","id":"reply","parentId":"branch","message":{"role":"assistant","content":"branch reply"}}),
        ]);
        assert_eq!(assert_parity("omp", &fixture).len(), 6);
        let questions = question_index("omp", &fixture.0).unwrap();
        assert_eq!(questions.len(), 3);
        assert_eq!(questions[1].parent_message_index, Some(0));
        assert_eq!(questions[2].reply_preview, "branch reply");
    }

    #[test]
    fn navigation_cache_is_reused_and_invalidated_after_append_or_explicit_clear() {
        let fixture = Fixture::new(&[
            json!({"type":"user","uuid":"one","message":{"role":"user","content":"one"}}),
        ]);
        let first = read_index("claude", &fixture.0).unwrap();
        assert!(Arc::ptr_eq(
            &first,
            &read_index("claude", &fixture.0).unwrap()
        ));
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&fixture.0)
                .unwrap(),
            "{}",
            json!({"type":"user","uuid":"two","message":{"role":"user","content":"two"}})
        )
        .unwrap();
        let appended = read_index("claude", &fixture.0).unwrap();
        assert!(!Arc::ptr_eq(&first, &appended));
        assert_eq!(
            message_location("claude", &fixture.0, "two")
                .unwrap()
                .message_index,
            Some(1)
        );
        crate::state::clear_message_cache_for_path(&fixture.0);
        assert!(!Arc::ptr_eq(
            &appended,
            &read_index("claude", &fixture.0).unwrap()
        ));
    }

    #[test]
    fn real_message_id_takes_priority_over_synthetic_fallback() {
        let fixture = Fixture::new(&[
            json!({"type":"user","message":{"role":"user","content":"fallback"}}),
            json!({"type":"assistant","uuid":"user-0","message":{"role":"assistant","content":"actual ID"}}),
        ]);
        assert_eq!(
            message_location("claude", &fixture.0, "user-0")
                .unwrap()
                .message_index,
            Some(1)
        );
    }

    #[test]
    fn empty_uuid_uses_the_same_fallback_as_a_missing_uuid() {
        let fixture = Fixture::new(&[
            json!({"type":"user","uuid":"","message":{"role":"user","content":"question"}}),
            json!({"type":"assistant","uuid":"","message":{"role":"assistant","content":"answer"}}),
        ]);
        assert_eq!(
            question_index("claude", &fixture.0).unwrap()[0].message_id,
            "user-0"
        );
        assert_eq!(
            message_location("claude", &fixture.0, "user-0")
                .unwrap()
                .message_index,
            Some(0)
        );
        assert_eq!(
            message_location("claude", &fixture.0, "assistant-1")
                .unwrap()
                .message_index,
            Some(1)
        );
        assert_eq!(
            message_location("claude", &fixture.0, "")
                .unwrap()
                .message_index,
            None
        );
    }
}
