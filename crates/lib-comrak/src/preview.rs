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
    page: String,
}
impl Preview {
    pub fn start(args: &Args) -> Result<Self, String> {
        let notebook =
            dunce::canonicalize(args.root.as_deref().unwrap_or(std::path::Path::new(".")))
                .map_err(|e| e.to_string())?;
        let input = dunce::canonicalize(&args.input).map_err(|e| e.to_string())?;
        let (root, document) = if let Some(site) = &args.site_root {
            std::fs::create_dir_all(site).map_err(|e| e.to_string())?;
            (
                dunce::canonicalize(site).map_err(|e| e.to_string())?,
                std::path::absolute(&args.output).map_err(|e| e.to_string())?,
            )
        } else {
            (
                notebook.clone(),
                notebook
                    .join(
                        input
                            .strip_prefix(&notebook)
                            .map_err(|_| "input must be inside root")?,
                    )
                    .with_extension("html"),
            )
        };
        let assets = if args.site_root.is_some() {
            root.join("_shared")
        } else {
            std::path::absolute(args.asset_dir.clone().unwrap_or(root.join("_shared")))
                .map_err(|e| e.to_string())?
        };
        let base = url::Url::from_directory_path(&root).map_err(|_| "invalid root")?;
        let page = format!(
            "/{}",
            base.make_relative(&assets::file_url(&document)?)
                .ok_or("invalid page URL")?
        );
        let listener =
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
        eprintln!(
            "serving at http://{}{page}",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let allowed = [root.clone(), assets.clone()];
        let served_page = page.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                // Short requests only; timeouts bound stalled local clients.
                let _ = serve(stream, &shared, &allowed, &served_page);
            }
        });
        Ok(Self {
            state,
            root,
            assets,
            page,
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
            let (base, prefix) = if path.starts_with(&self.root) {
                (&self.root, "/")
            } else {
                (&self.assets, "/_shared/")
            };
            let base = url::Url::from_directory_path(base).unwrap();
            let relative = base.make_relative(&url).unwrap();
            let target = url::Url::parse("http://localhost/")
                .unwrap()
                .join(&format!("{prefix}{relative}"))
                .unwrap();
            let page = url::Url::parse("http://localhost/")
                .unwrap()
                .join(&self.page)
                .unwrap();
            page.make_relative(&target).unwrap()
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
fn serve(
    mut stream: TcpStream,
    state: &Mutex<State>,
    allowed: &[PathBuf],
    page: &str,
) -> std::io::Result<()> {
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
    } else if path.split('?').next() == Some(page) {
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
        let file = site_file(path, allowed);
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
        && path != "/__revision"
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

fn site_file(request: &str, allowed: &[PathBuf]) -> Option<PathBuf> {
    let url = url::Url::parse("http://localhost/")
        .ok()?
        .join(request)
        .ok()?;
    let (root, path) = if let Some(path) = url.path().strip_prefix("/_shared/") {
        (&allowed[1], path)
    } else {
        (&allowed[0], url.path().strip_prefix('/')?)
    };
    let base = url::Url::from_directory_path(root).ok()?;
    let file = base.join(path).ok()?.to_file_path().ok()?;
    let file = dunce::canonicalize(file).ok()?;
    file.starts_with(root).then_some(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_resource_urls_keep_queries_and_fragments() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let preview = Preview {
            state: Arc::default(),
            root: root.clone(),
            assets: root.join("shared"),
            page: "/ai/chatgpt/note.html".into(),
        };
        let url = assets::file_url(&root.join("assets/example.webp")).unwrap();
        preview.publish(format!("<img src=\"{url}?v=2#image\"></body>"));
        let state = preview.state.lock().unwrap();
        assert!(state.html.contains("../../assets/example.webp?v=2#image"));
        assert!(!state.html.contains("file:"));
    }
    #[test]
    fn serving_rejects_escaped_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let allowed = [root.clone(), root.join("shared")];
        assert!(site_file("/%2e%2e/etc/passwd", &allowed).is_none());
    }
}
