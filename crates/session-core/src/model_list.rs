use serde::{Deserialize, Serialize};

use crate::cli_config;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub group: String,
    pub created: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AnthropicModelsResponse {
    data: Vec<AnthropicModel>,
}

#[derive(Debug, Deserialize)]
struct AnthropicModel {
    id: String,
    display_name: Option<String>,
    created_at: Option<String>,
}

/// Infer a human-friendly group name from a model ID.
fn infer_group(id: &str) -> String {
    let lower = id.to_lowercase();
    if lower.contains("opus") {
        return "Claude Opus".to_string();
    }
    if lower.contains("sonnet") {
        return "Claude Sonnet".to_string();
    }
    if lower.contains("haiku") {
        return "Claude Haiku".to_string();
    }
    "Other".to_string()
}

/// Built-in Claude models — mirrors Claude CLI `/model` output.
fn builtin_claude_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "claude-sonnet-4-6".to_string(),
            name: "Sonnet 4.6 (默认推荐)".to_string(),
            provider: "anthropic".to_string(),
            group: "Claude Sonnet".to_string(),
            created: None,
        },
        ModelInfo {
            id: "claude-opus-4-6".to_string(),
            name: "Opus 4.6".to_string(),
            provider: "anthropic".to_string(),
            group: "Claude Opus".to_string(),
            created: None,
        },
        ModelInfo {
            id: "claude-haiku-4-5".to_string(),
            name: "Haiku 4.5".to_string(),
            provider: "anthropic".to_string(),
            group: "Claude Haiku".to_string(),
            created: None,
        },
    ]
}

async fn fetch_anthropic_models(api_key: &str, base_url: &str) -> Result<Vec<ModelInfo>, String> {
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("x-api-key", api_key)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("Anthropic API request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Anthropic API error {}: {}", status, text));
    }

    let body: AnthropicModelsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Anthropic models response: {}", e))?;

    let mut models: Vec<ModelInfo> = body
        .data
        .into_iter()
        .map(|m| {
            let name = m.display_name.unwrap_or_else(|| m.id.clone());
            let group = infer_group(&m.id);
            let created = m.created_at.and_then(|ts| {
                chrono::DateTime::parse_from_rfc3339(&ts)
                    .ok()
                    .map(|dt| dt.timestamp())
            });
            ModelInfo {
                id: m.id,
                name,
                provider: "anthropic".to_string(),
                group,
                created,
            }
        })
        .collect();

    // When using a proxy, the /v1/models endpoint may return models from all
    // providers.  Only keep models that look like Claude models.
    models.retain(|m| m.id.to_lowercase().contains("claude"));

    // Sort by created desc (newest first)
    models.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(models)
}

/// Merge: built-in models first, then append any API-only extras (deduped).
fn merge_models(builtin: Vec<ModelInfo>, api_models: Vec<ModelInfo>) -> Vec<ModelInfo> {
    use std::collections::HashSet;
    let builtin_ids: HashSet<String> = builtin.iter().map(|m| m.id.clone()).collect();
    let mut result = builtin;
    for m in api_models {
        if !builtin_ids.contains(&m.id) {
            result.push(m);
        }
    }
    result
}

/// List available Claude models.
///
/// - `_source`: ignored (always uses Claude)
/// - `api_key`: user-provided key (empty string = use CLI config / env var)
/// - `base_url`: base URL for the API (empty string = use CLI config / env var / default)
pub async fn list_models(
    _source: &str,
    api_key: &str,
    base_url: &str,
) -> Result<Vec<ModelInfo>, String> {
    let (resolved_key, resolved_url) = if api_key.is_empty() && base_url.is_empty() {
        let (cli_key, cli_url) = cli_config::get_credentials("claude");
        let final_key = if cli_key.is_empty() {
            std::env::var("ANTHROPIC_API_KEY").unwrap_or_default()
        } else {
            cli_key
        };
        (final_key, cli_url)
    } else {
        let key = if api_key.is_empty() {
            std::env::var("ANTHROPIC_API_KEY").unwrap_or_default()
        } else {
            api_key.to_string()
        };
        let url = if base_url.is_empty() {
            std::env::var("ANTHROPIC_BASE_URL")
                .unwrap_or_else(|_| "https://api.anthropic.com".to_string())
        } else {
            base_url.to_string()
        };
        (key, url)
    };

    let builtin = builtin_claude_models();
    if resolved_key.is_empty() {
        return Ok(builtin);
    }

    let api_models = match fetch_anthropic_models(&resolved_key, &resolved_url).await {
        Ok(models) => models,
        Err(e) => {
            eprintln!("Warning: failed to fetch Anthropic models: {}", e);
            vec![]
        }
    };

    Ok(merge_models(builtin, api_models))
}
