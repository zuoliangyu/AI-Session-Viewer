use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::{cli, cli_config};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// Stream a chat completion from Claude (Anthropic) API.
///
/// Calls `on_chunk` with each text delta as it arrives.
/// The `model` parameter must be a full API model ID (e.g. "claude-sonnet-4-6"),
/// not a CLI alias (e.g. "sonnet").
pub async fn stream_chat(
    source: &str,
    messages: Vec<ChatMsg>,
    model: &str,
    on_chunk: impl Fn(&str),
) -> Result<(), String> {
    let source = cli::normalize_source(source)?;
    if source != "claude" {
        return Err(format!(
            "Quick chat API streaming is only supported for Claude right now (got {}).",
            source
        ));
    }

    let (api_key, base_url) = cli_config::get_credentials(source);
    if api_key.is_empty() {
        return Err(
            "No API key found for Claude. Please configure your CLI or set the ANTHROPIC_API_KEY environment variable.".to_string()
        );
    }

    eprintln!(
        "[quick_chat] source={}, model={}, base_url={}",
        source, model, base_url
    );

    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let api_messages: Vec<serde_json::Value> = messages
        .into_iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 16384,
        "stream": true,
        "messages": api_messages,
    });

    let resp = client
        .post(&url)
        .header("x-api-key", &api_key)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic API request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        eprintln!("[quick_chat] Anthropic API error {}: {}", status, text);
        return Err(format!("API Error: {} {}", status, text));
    }

    // Parse SSE stream
    use futures_util::TryStreamExt;
    use tokio::io::AsyncBufReadExt;
    use tokio_util::io::StreamReader;

    let stream = resp.bytes_stream().map_err(std::io::Error::other);
    let reader = StreamReader::new(stream);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if !line.starts_with("data: ") {
            continue;
        }
        let data = &line[6..];
        if data == "[DONE]" {
            break;
        }

        let json: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(error_msg) = json
            .get("error")
            .and_then(|error| {
                error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .or_else(|| error.as_str())
            })
            .or_else(|| json.get("message").and_then(|v| v.as_str()))
        {
            return Err(error_msg.to_string());
        }

        // Anthropic SSE: content_block_delta with delta.text
        if let Some(event_type) = json.get("type").and_then(|v| v.as_str()) {
            if event_type == "content_block_delta" {
                if let Some(text) = json
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(|v| v.as_str())
                {
                    if !text.is_empty() {
                        on_chunk(text);
                    }
                }
            } else if event_type == "error" {
                return Err(format!("Anthropic stream error: {}", data));
            }
        }
    }

    Ok(())
}
