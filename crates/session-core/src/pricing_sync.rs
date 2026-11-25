//! Optional online refresh of model prices (pricing source 1 in
//! [`crate::models::pricing`]).
//!
//! Off by default. When on, the app downloads LiteLLM's community price list
//! at startup and then whenever the last successful download is older than
//! a day, keeps the same filtered subset as `scripts/sync-prices.mjs`, and
//! stores it under `~/.claude-code-viewer/pricing/`. A failed or suspicious
//! download keeps the previous data; with no download the built-in snapshot
//! applies. Turning the option off deletes the downloaded file.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::models::pricing::{self, Catalog};
use crate::persistence::{self, StateLock};

/// jsDelivr first: it mirrors GitHub and is usually reachable where
/// raw.githubusercontent.com is not.
const SOURCES: [&str; 2] = [
    "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
];
const MAX_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;
/// A filtered list smaller than this is treated as a broken download.
const MIN_MODELS: usize = 100;
const REFRESH_AFTER_HOURS: i64 = 24;
const STARTUP_DELAY: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

static REFRESHING: AtomicBool = AtomicBool::new(false);

/// Clears [`REFRESHING`] even if the refresh task unwinds.
struct RefreshingGuard;

impl Drop for RefreshingGuard {
    fn drop(&mut self) {
        REFRESHING.store(false, Ordering::SeqCst);
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct PricingSettings {
    #[serde(default)]
    auto_update: bool,
    #[serde(default)]
    last_attempt_at: Option<String>,
    #[serde(default)]
    last_success_at: Option<String>,
    #[serde(default)]
    last_error: Option<String>,
    #[serde(default)]
    last_source_url: Option<String>,
}

/// What the settings page shows.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PricingStatus {
    pub auto_update: bool,
    pub refreshing: bool,
    /// `"online"` when downloaded prices are in use, otherwise `"snapshot"`.
    pub active_source: &'static str,
    pub snapshot_generated_at: Option<String>,
    pub snapshot_model_count: usize,
    pub online_fetched_at: Option<String>,
    pub online_model_count: Option<usize>,
    pub online_source_url: Option<String>,
    pub last_attempt_at: Option<String>,
    pub last_error: Option<String>,
}

fn pricing_dir() -> Result<PathBuf, String> {
    crate::app_dir::get_app_dir()
        .map(|dir| dir.join("pricing"))
        .ok_or_else(|| "无法确定本地数据目录".to_string())
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(pricing_dir()?.join("settings.json"))
}

fn online_path() -> Result<PathBuf, String> {
    Ok(pricing_dir()?.join("online-prices.json"))
}

fn read_settings() -> PricingSettings {
    settings_path()
        .and_then(|path| persistence::read_json(&path))
        .unwrap_or_default()
}

/// Read-modify-write the settings under the shared state lock.
fn update_settings(lock: &StateLock, change: impl FnOnce(&mut PricingSettings)) -> Result<PricingSettings, String> {
    let path = settings_path()?;
    let mut settings: PricingSettings = persistence::read_json(&path).unwrap_or_default();
    change(&mut settings);
    lock.write_json(&path, &settings)?;
    Ok(settings)
}

fn load_online_file() -> Result<Option<Catalog>, String> {
    let path = online_path()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Catalog::from_json_str(&text).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取 {} 失败：{error}", path.display())),
    }
}

/// Load previously downloaded prices. Call once at startup.
pub fn init() {
    if !read_settings().auto_update {
        return;
    }
    match load_online_file() {
        Ok(Some(catalog)) if !catalog.is_empty() => pricing::set_online_catalog(Some(Arc::new(catalog))),
        Ok(_) => {}
        Err(error) => eprintln!("[pricing] {error}"),
    }
}

pub fn status() -> PricingStatus {
    let settings = read_settings();
    let online = pricing::online_catalog();
    let snapshot = pricing::snapshot_catalog();
    PricingStatus {
        auto_update: settings.auto_update,
        refreshing: REFRESHING.load(Ordering::SeqCst),
        active_source: if online.is_some() { "online" } else { "snapshot" },
        snapshot_generated_at: snapshot.generated_at().map(str::to_string),
        snapshot_model_count: snapshot.len(),
        online_fetched_at: online
            .as_ref()
            .and_then(|catalog| catalog.generated_at().map(str::to_string))
            .or(settings.last_success_at),
        online_model_count: online.as_ref().map(|catalog| catalog.len()),
        online_source_url: settings.last_source_url,
        last_attempt_at: settings.last_attempt_at,
        last_error: settings.last_error,
    }
}

/// Turn online updates on or off. Turning them off deletes the downloaded
/// prices and returns to the built-in snapshot; turning them on loads an
/// earlier download if one is still on disk (call [`refresh_now`] to fetch).
pub fn set_auto_update(enabled: bool) -> Result<PricingStatus, String> {
    {
        let lock = StateLock::acquire()?;
        update_settings(&lock, |settings| {
            settings.auto_update = enabled;
            if !enabled {
                settings.last_error = None;
            }
        })?;
        if !enabled {
            match std::fs::remove_file(online_path()?) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("删除在线价格数据失败：{error}")),
            }
        }
    }
    if enabled {
        init();
    } else {
        pricing::set_online_catalog(None);
    }
    Ok(status())
}

/// Download, validate and activate the latest prices now. Requires online
/// updates to be on.
pub async fn refresh_now() -> Result<PricingStatus, String> {
    if !read_settings().auto_update {
        return Err("请先开启在线更新价格".to_string());
    }
    if REFRESHING.swap(true, Ordering::SeqCst) {
        return Err("价格正在更新，请稍候".to_string());
    }
    let guard = RefreshingGuard;
    let result = refresh_inner().await;
    drop(guard);

    let attempted_at = Utc::now().to_rfc3339();
    let error = result.as_ref().err().cloned();
    let record = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let lock = StateLock::acquire()?;
        update_settings(&lock, |settings| {
            settings.last_attempt_at = Some(attempted_at);
            settings.last_error = error;
        })
        .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    if let Err(record_error) = record {
        eprintln!("[pricing] failed to record refresh result: {record_error}");
    }

    result.map(|_| status())
}

async fn refresh_inner() -> Result<(), String> {
    let (url, body) = download().await?;
    let catalog = tokio::task::spawn_blocking(move || store_download(&url, &body))
        .await
        .map_err(|e| format!("价格数据处理任务失败：{e}"))??;
    if let Some(catalog) = catalog {
        pricing::set_online_catalog(Some(Arc::new(catalog)));
    }
    Ok(())
}

async fn download() -> Result<(String, Vec<u8>), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .user_agent(concat!("AI-Session-Viewer/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("创建网络客户端失败：{e}"))?;
    let mut errors = Vec::new();
    for url in SOURCES {
        match fetch_capped(&client, url).await {
            Ok(body) => return Ok((url.to_string(), body)),
            Err(error) => errors.push(format!("{url}：{error}")),
        }
    }
    Err(format!("下载价格数据失败（{}）", errors.join("；")))
}

async fn fetch_capped(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.to_string())?;
    if response.content_length().is_some_and(|len| len > MAX_DOWNLOAD_BYTES as u64) {
        return Err("文件过大".to_string());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if body.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
            return Err("文件过大".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Filter and validate a download, then save it. Returns `None` when online
/// updates were turned off while the download was running.
fn store_download(url: &str, body: &[u8]) -> Result<Option<Catalog>, String> {
    let value: Value = serde_json::from_slice(body).map_err(|e| format!("价格数据不是有效的 JSON：{e}"))?;
    let models = pricing::filter_models(&pricing::models_from_json(value)?);
    validate(&models)?;

    let fetched_at = Utc::now().to_rfc3339();
    let document = json!({
        "_meta": { "source": "litellm", "url": url, "generatedAt": fetched_at },
        "models": models,
    });

    let lock = StateLock::acquire()?;
    let settings_now: PricingSettings = persistence::read_json(&settings_path()?).unwrap_or_default();
    if !settings_now.auto_update {
        return Ok(None);
    }
    lock.write_json(&online_path()?, &document)?;
    update_settings(&lock, |settings| {
        settings.last_success_at = Some(fetched_at.clone());
        settings.last_source_url = Some(url.to_string());
    })?;
    drop(lock);

    Ok(Some(Catalog::from_models(&models, Some(fetched_at))))
}

fn validate(models: &Map<String, Value>) -> Result<(), String> {
    if models.len() < MIN_MODELS {
        return Err(format!("价格数据只有 {} 个模型，疑似不完整，已保留原数据", models.len()));
    }
    for provider in ["anthropic", "openai"] {
        let present = models
            .values()
            .any(|entry| entry.get("litellm_provider").and_then(Value::as_str) == Some(provider));
        if !present {
            return Err(format!("价格数据缺少 {provider} 模型，已保留原数据"));
        }
    }
    Ok(())
}

fn refresh_due(settings: &PricingSettings, now: DateTime<Utc>) -> bool {
    let parse = |value: &Option<String>| {
        value
            .as_deref()
            .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
            .map(|time| time.with_timezone(&Utc))
    };
    let stale = parse(&settings.last_success_at)
        .is_none_or(|success| now - success >= chrono::Duration::hours(REFRESH_AFTER_HOURS));
    // After a failure, wait an hour before trying again.
    let cooled_down = parse(&settings.last_attempt_at)
        .is_none_or(|attempt| now - attempt >= chrono::Duration::hours(1));
    stale && cooled_down
}

/// Background task: refresh shortly after startup and then hourly whenever
/// online updates are on and the data is a day old. Spawn once per process.
pub async fn auto_refresh_loop() {
    tokio::time::sleep(STARTUP_DELAY).await;
    loop {
        let settings = read_settings();
        if settings.auto_update && refresh_due(&settings, Utc::now()) {
            if let Err(error) = refresh_now().await {
                eprintln!("[pricing] online refresh failed: {error}");
            }
        }
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> Option<String> {
        Some(text.to_string())
    }

    #[test]
    fn refresh_schedule() {
        let now = DateTime::parse_from_rfc3339("2026-11-25T12:00:00Z").unwrap().with_timezone(&Utc);
        let never = PricingSettings { auto_update: true, ..Default::default() };
        assert!(refresh_due(&never, now));

        let fresh = PricingSettings {
            last_success_at: at("2026-11-25T01:00:00Z"),
            last_attempt_at: at("2026-11-25T01:00:00Z"),
            ..never.clone()
        };
        assert!(!refresh_due(&fresh, now));

        let stale = PricingSettings {
            last_success_at: at("2026-11-24T11:00:00Z"),
            last_attempt_at: at("2026-11-24T11:00:00Z"),
            ..never.clone()
        };
        assert!(refresh_due(&stale, now));

        let just_failed = PricingSettings {
            last_success_at: at("2026-11-23T00:00:00Z"),
            last_attempt_at: at("2026-11-25T11:30:00Z"),
            ..never
        };
        assert!(!refresh_due(&just_failed, now));
    }

    #[test]
    fn rejects_incomplete_downloads() {
        let mut models = Map::new();
        models.insert(
            "gpt-5.4".into(),
            json!({ "litellm_provider": "openai", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6 }),
        );
        assert!(validate(&models).is_err());

        for i in 0..MIN_MODELS {
            models.insert(
                format!("gpt-test-{i}"),
                json!({ "litellm_provider": "openai", "mode": "chat", "input_cost_per_token": 1e-6, "output_cost_per_token": 1e-6 }),
            );
        }
        // Enough models but no Anthropic entries.
        assert!(validate(&models).unwrap_err().contains("anthropic"));
        models.insert(
            "claude-opus-4-7".into(),
            json!({ "litellm_provider": "anthropic", "mode": "chat", "input_cost_per_token": 5e-6, "output_cost_per_token": 2.5e-5 }),
        );
        assert!(validate(&models).is_ok());
    }
}
