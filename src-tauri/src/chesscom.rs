use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::Error;

const LOGIN_WINDOW: &str = "chesscom-login";
const LOGIN_URL: &str = "https://www.chess.com/login";
const COOKIE_URL: &str = "https://www.chess.com/";

pub fn has_chesscom_session<'a, I>(names: I) -> bool
where
    I: IntoIterator<Item = &'a str>,
{
    let mut php = false;
    let mut access = false;
    for name in names {
        if name.eq_ignore_ascii_case("PHPSESSID") {
            php = true;
        }
        if name.eq_ignore_ascii_case("ACCESS_TOKEN") {
            access = true;
        }
    }
    php && access
}

pub fn cookie_header_from_pairs(pairs: &[(String, String)]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut ordered: Vec<(String, String)> = Vec::new();
    for (name, value) in pairs.iter().rev() {
        if name.is_empty() || value.is_empty() {
            continue;
        }
        if seen.insert(name.to_ascii_lowercase()) {
            ordered.push((name.clone(), value.clone()));
        }
    }
    ordered.reverse();
    ordered
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn pairs_from_window(window: &WebviewWindow) -> Result<Vec<(String, String)>, Error> {
    let url = COOKIE_URL.parse().expect("static chess.com URL");
    let cookies = window.cookies_for_url(url)?;
    Ok(cookies
        .into_iter()
        .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn chesscom_login(app: AppHandle) -> Result<String, Error> {
    let window = if let Some(existing) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = existing.set_focus();
        existing
    } else {
        WebviewWindowBuilder::new(
            &app,
            LOGIN_WINDOW,
            WebviewUrl::External(LOGIN_URL.parse().expect("static chess.com URL")),
        )
            .title("Chess.com login")
            .inner_size(1000.0, 800.0)
            .center()
            .build()?
    };

    let (closed_tx, mut closed_rx) = tokio::sync::watch::channel(false);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = closed_tx.send(true);
        }
    });

    loop {
        tokio::select! {
            _ = closed_rx.changed() => {
                if *closed_rx.borrow() {
                    return Err(Error::ChessComLoginCancelled);
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(400)) => {
                let poll_window = window.clone();
                let pairs = tokio::task::spawn_blocking(move || pairs_from_window(&poll_window))
                    .await
                    .map_err(|_| Error::ChessComLoginCancelled)??;
                let names: Vec<&str> = pairs.iter().map(|(name, _)| name.as_str()).collect();
                if has_chesscom_session(names) {
                    let header = cookie_header_from_pairs(&pairs);
                    let _ = window.close();
                    return Ok(header);
                }
                if app.get_webview_window(LOGIN_WINDOW).is_none() {
                    return Err(Error::ChessComLoginCancelled);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{cookie_header_from_pairs, has_chesscom_session};

    #[test]
    fn session_requires_php_and_access_token() {
        assert!(!has_chesscom_session(["PHPSESSID", "cf_clearance"]));
        assert!(has_chesscom_session(["PHPSESSID", "ACCESS_TOKEN"]));
        assert!(has_chesscom_session(["phpsessid", "access_token"]));
    }

    #[test]
    fn cookie_header_dedupes_and_skips_empty() {
        let header = cookie_header_from_pairs(&[
            ("PHPSESSID".into(), "abc".into()),
            ("skip".into(), "".into()),
            ("PHPSESSID".into(), "xyz".into()),
            ("ACCESS_TOKEN".into(), "tok".into()),
        ]);
        assert_eq!(header, "PHPSESSID=xyz; ACCESS_TOKEN=tok");
    }
}
