//! Loopback preview; static output remains usable directly from disk.
use crate::{assets, cli::Args};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
struct State {
    html: String,
    revision: u64,
}
pub(crate) struct Preview {
    state: Arc<Mutex<State>>,
    root: PathBuf,
    assets: PathBuf,
}
impl Preview {
    pub fn start(args: &Args) -> Result<Self, String> {
        let input = dunce::canonicalize(&args.input).map_err(|e| e.to_string())?;
        let root = dunce::canonicalize(args.root.as_deref().unwrap_or(input.parent().unwrap()))
            .map_err(|e| e.to_string())?;
        let assets = std::path::absolute(args.asset_dir.clone().unwrap_or(assets::shared_base()?))
            .map_err(|e| e.to_string())?;
        let listener =
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
        eprintln!(
            "serving at http://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let allowed = [root.clone(), assets.clone()];
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                // Short requests only; timeouts bound stalled local clients.
                let _ = serve(stream, &shared, &allowed);
            }
        });
        Ok(Self {
            state,
            root,
            assets,
        })
    }
    pub fn publish(&self, html: String) {
        let pattern = regex::Regex::new(r#"file://[^\s\"'<>]+"#).unwrap();
        let html = pattern.replace_all(&html, |captures: &regex::Captures<'_>| {
            let original = &captures[0];
            let value = original.replace("&amp;", "&");
            let Ok(url) = url::Url::parse(&value) else {
                return original.to_owned();
            };
            let Ok(path) = url.to_file_path() else {
                return original.to_owned();
            };
            if !path.starts_with(&self.root) && !path.starts_with(&self.assets) {
                return original.to_owned();
            }
            format!("/__file/{}", original)
        });
        let mut state = self.state.lock().unwrap();
        state.revision += 1;
        let script = format!(
            r#"<script>let revision={};setInterval(async()=>{{try{{const r=await fetch('/__revision',{{cache:'no-store'}});if(r.ok&&await r.text()!==String(revision))location.reload();}}catch{{}}}},750);</script>"#,
            state.revision
        );
        state.html = html.replace("</body>", &(script + "</body>"));
    }
}
fn serve(mut stream: TcpStream, state: &Mutex<State>, allowed: &[PathBuf]) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut request = [0; 16384];
    let n = stream.read(&mut request)?;
    let request = String::from_utf8_lossy(&request[..n]);
    let mut words = request.split_whitespace();
    let method = words.next().unwrap_or("");
    let path = words.next().unwrap_or("");
    let mut status = "200 OK";
    let (mime, body) = if method != "GET" && method != "HEAD" {
        status = "405 Method Not Allowed";
        ("text/plain".to_owned(), Vec::new())
    } else if path == "/" {
        let state = state.lock().unwrap();
        let html = if state.html.is_empty() {
            "<p>Waiting for successful compilation…</p><script>setTimeout(()=>location.reload(),1000)</script>"
        } else {
            &state.html
        };
        (
            "text/html; charset=utf-8".to_owned(),
            html.as_bytes().to_vec(),
        )
    } else if path == "/__revision" {
        (
            "text/plain".to_owned(),
            state.lock().unwrap().revision.to_string().into_bytes(),
        )
    } else {
        let file = path
            .strip_prefix("/__file/")
            .and_then(|s| url::Url::parse(s).ok())
            .filter(|u| u.scheme() == "file")
            .and_then(|u| u.to_file_path().ok())
            .and_then(|p| dunce::canonicalize(p).ok());
        if let Some(file) =
            file.filter(|p| allowed.iter().any(|root| p.starts_with(root)) && p.is_file())
        {
            (
                mime_guess::from_path(&file)
                    .first_or_octet_stream()
                    .to_string(),
                std::fs::read(file)?,
            )
        } else {
            status = "404 Not Found";
            ("text/plain".to_owned(), Vec::new())
        }
    };
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    body.hash(&mut hash);
    let etag = format!("\"{:x}\"", hash.finish());
    if status == "200 OK"
        && path.starts_with("/__file/")
        && request.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("if-none-match") && value.trim() == etag
            })
        })
    {
        write!(
            stream,
            "HTTP/1.1 304 Not Modified\r\nETag: {etag}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        )?;
        return Ok(());
    }
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nETag: {etag}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    if method != "HEAD" {
        stream.write_all(&body)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_rewrites_allowed_urls_and_retains_static_output() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let preview = Preview {
            state: Arc::default(),
            root: root.clone(),
            assets: root.join("assets"),
        };
        let url = assets::file_url(&root.join("a b.png")).unwrap();
        let html = format!("<img src=\"{url}\"></body>");
        preview.publish(html.clone());
        let state = preview.state.lock().unwrap();
        assert!(state.html.contains(&format!("/__file/{url}")));
        assert!(state.html.contains("/__revision"));
        assert_eq!(state.revision, 1);
        assert!(!html.contains("/__file/"));
    }
}
