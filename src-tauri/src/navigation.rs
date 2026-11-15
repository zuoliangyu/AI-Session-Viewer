use tauri::{plugin::TauriPlugin, Manager, Runtime, Url};

// Compare the complete origin. A matching first subdomain is not sufficient.
fn is_allowed_navigation(url: &Url, dev_url: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let local = url.port().is_none()
        && match url.scheme() {
            "tauri" => url.host_str() == Some("localhost"),
            "http" | "https" => url.host_str() == Some("tauri.localhost"),
            _ => false,
        };
    local
        || dev_url.is_some_and(|dev| {
            matches!(url.scheme(), "http" | "https")
                && url.scheme() == dev.scheme()
                && url.host_str() == dev.host_str()
                && url.port_or_known_default() == dev.port_or_known_default()
        })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("navigation-guard")
        .on_navigation(|webview, url| {
            let config = webview.app_handle().config();
            let dev_url = if cfg!(dev) {
                config.build.dev_url.as_ref()
            } else {
                None
            };
            is_allowed_navigation(url, dev_url)
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::is_allowed_navigation;
    use tauri::Url;

    #[test]
    fn only_full_application_origins_are_trusted() {
        for value in [
            "tauri://localhost/",
            "http://tauri.localhost/messages",
            "https://tauri.localhost/#details",
        ] {
            assert!(is_allowed_navigation(&Url::parse(value).unwrap(), None));
        }
        for value in [
            "http://tauri.attacker.test/",
            "https://tauri.localhost.attacker.test/",
            "http://tauri.localhost:1420/",
            "tauri://attacker.test/",
            "https://user@tauri.localhost/",
            "file:///tmp/page.html",
            "data:text/html,hello",
            "about:blank",
            "http://localhost:1420/",
        ] {
            assert!(
                !is_allowed_navigation(&Url::parse(value).unwrap(), None),
                "{value}"
            );
        }
    }

    #[test]
    fn development_allows_only_the_configured_origin() {
        let dev = Url::parse("http://localhost:1420/").unwrap();
        assert!(is_allowed_navigation(
            &dev.join("messages#end").unwrap(),
            Some(&dev)
        ));
        for value in [
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://localhost.attacker.test:1420/",
            "http://user@localhost:1420/",
        ] {
            assert!(!is_allowed_navigation(
                &Url::parse(value).unwrap(),
                Some(&dev)
            ));
        }
    }
}
