//! HTML previews run in a sandbox with repository-local resources and restricted network access.
//! The sandbox is not a separate process: scripts may still consume CPU.
use crate::{
    AppState, PathQuery, checked_library_path, documents::read_document_source, encode_path,
    encode_query_component, file_kind, json_error, media_type, stream_file, worker_error,
};
use axum::{
    body::Body,
    extract::{OriginalUri, Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::{collections::HashMap, sync::LazyLock};

#[derive(Clone)]
pub(super) struct Service {
    token: std::sync::Arc<String>,
}

impl Service {
    pub(super) fn new() -> Result<Self, std::io::Error> {
        let mut bytes = [0u8; 24];
        getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
        Ok(Self {
            token: std::sync::Arc::new(bytes.iter().map(|byte| format!("{byte:02x}")).collect()),
        })
    }

    pub(super) fn token(&self) -> std::sync::Arc<String> {
        self.token.clone()
    }
    fn authorizes(&self, token: &str) -> bool {
        self.token.as_str() == token
    }
}

static HTML_STRIP_ELEMENTS_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::RegexBuilder::new(
        r"(?is)<(?:iframe|frame|frameset|object|embed)\b[^>]*>.*?</(?:iframe|frame|frameset|object|embed)\s*>|<(?:iframe|frame|frameset|object|embed)\b[^>]*/?>|<base\b[^>]*>",
    )
    .build()
    .expect("static HTML sanitizing pattern is valid")
});
static HTML_META_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?is)<meta\b[^>]*>").expect("valid HTML meta pattern"));
static HTML_HTTP_EQUIV_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)\bhttp-equiv\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#)
        .expect("valid HTML http-equiv pattern")
});
static HTML_OPEN_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)<html\b[^>]*>").expect("valid HTML pattern"));
static HEAD_OPEN_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)<head\b[^>]*>").expect("valid HTML pattern"));
static HTML_ANCHOR_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?is)<a\b[^>]*>").expect("valid anchor pattern"));
static HTML_HREF_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')"#).expect("valid href pattern")
});
static HTML_TARGET_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)\btarget\s*=\s*(?:"[^"]*"|'[^']*')"#).expect("valid target pattern")
});
static HTML_REL_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?i)\brel\s*=\s*(?:"([^"]*)"|'([^']*)')"#).expect("valid rel pattern")
});
static HTML_TAG_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)<html\b[^>]*>").expect("valid HTML pattern"));
static HTML_HOST_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9.\-:\[\]]+$").expect("valid host pattern"));
static HTML_RESOURCE_EXTENSION_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^(css|js|mjs|png|jpe?g|gif|webp|avif|bmp|ico|svg|woff2?|ttf|otf|mp3|mp4|mov|webm|ogg|wav)$")
        .expect("valid HTML resource extension pattern")
});

fn html_resources_base(api_prefix: &str, token: &str, path: &str) -> String {
    let directory = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let relative = if directory.is_empty() {
        String::new()
    } else {
        format!("{}/", encode_path(directory))
    };
    format!("{api_prefix}/api/html-resource/{token}/{relative}")
}

fn html_preview(source: &str, base: &str, document_url: &str) -> String {
    let source = HTML_STRIP_ELEMENTS_RE.replace_all(source, "");
    let source = HTML_META_RE.replace_all(&source, |captures: &regex::Captures<'_>| {
        if HTML_HTTP_EQUIV_RE.is_match(&captures[0]) {
            String::new()
        } else {
            captures[0].to_owned()
        }
    });
    let base_tag = format!(
        "<base href=\"{}\">",
        base.replace('&', "&amp;").replace('"', "&quot;")
    );
    let no_scroll = "<style>html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}</style>";
    let image_style = include_str!("../web/image-theme.css");
    let injection = format!("{base_tag}{no_scroll}<style>{image_style}</style>");
    let output = if let Some(found) = HEAD_OPEN_RE.find(&source) {
        let mut value = source.to_string();
        value.insert_str(found.end(), &injection);
        value
    } else if let Some(found) = HTML_OPEN_RE.find(&source) {
        let mut value = source.to_string();
        value.insert_str(found.end(), &format!("<head>{injection}</head>"));
        value
    } else {
        format!("<head>{injection}</head>{source}")
    };
    let output = HTML_ANCHOR_RE.replace_all(&output, |captures: &regex::Captures<'_>| {
        let mut tag = captures[0].to_owned();
        let Some(found) = HTML_HREF_RE.captures(&tag) else {
            return tag;
        };
        let value = found
            .get(1)
            .or_else(|| found.get(2))
            .map(|value| value.as_str())
            .unwrap_or_default();
        if let Some(fragment) = value.strip_prefix('#') {
            let replacement = format!(
                "href=\"{}#{}\"",
                document_url.replace('&', "&amp;"),
                fragment
            );
            tag = HTML_HREF_RE.replace(&tag, replacement).into_owned();
        } else if value
            .get(..7)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("http://"))
            || value
                .get(..8)
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
        {
            if HTML_TARGET_RE.is_match(&tag) {
                tag = HTML_TARGET_RE
                    .replace(&tag, "target=\"_blank\"")
                    .into_owned();
            } else {
                tag.insert_str(tag.len() - 1, " target=\"_blank\"");
            }
            if let Some(existing) = HTML_REL_RE.captures(&tag) {
                let values = existing
                    .get(1)
                    .or_else(|| existing.get(2))
                    .map(|value| value.as_str())
                    .unwrap_or_default();
                let mut values = values
                    .split_ascii_whitespace()
                    .map(str::to_owned)
                    .collect::<std::collections::HashSet<_>>();
                values.remove("opener");
                values.insert("noopener".into());
                values.insert("noreferrer".into());
                tag = HTML_REL_RE
                    .replace(
                        &tag,
                        format!(
                            "rel=\"{}\"",
                            values.into_iter().collect::<Vec<_>>().join(" ")
                        ),
                    )
                    .into_owned();
            } else {
                tag.insert_str(tag.len() - 1, " rel=\"noopener noreferrer\"");
            }
        }
        tag
    });
    HTML_TAG_RE
        .replace(&output, |captures: &regex::Captures<'_>| {
            let tag = &captures[0];
            if tag.to_ascii_lowercase().contains("data-dim-images") {
                tag.to_owned()
            } else {
                tag.replacen('>', " data-dim-images>", 1)
            }
        })
        .into_owned()
}

pub(super) async fn html_document(
    State(state): State<AppState>,
    OriginalUri(original_uri): OriginalUri,
    Query(query): Query<PathQuery>,
    headers: HeaderMap,
) -> Response {
    let uri = original_uri;
    let root = state.root_for_uri(uri.path());
    let private = state.data_directory.clone();
    let token = state.html.token();
    let api_prefix = uri
        .path()
        .strip_suffix("/api/html")
        .unwrap_or("")
        .to_owned();
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("localhost");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .filter(|value| matches!(*value, "http" | "https"))
        .unwrap_or("http");
    let origin = format!("{scheme}://{host}");
    if !HTML_HOST_RE.is_match(host) {
        return json_error(StatusCode::BAD_REQUEST, "Invalid host header").into_response();
    }
    let resource_origin = origin.clone();
    let resource_api_prefix = api_prefix.clone();
    let resource_token = token.clone();
    let document_url = format!(
        "{origin}{api_prefix}/api/html?path={}",
        encode_query_component(&query.path)
    );
    let result = state
        .document_workers
        .run(move || -> Result<String, (StatusCode, String)> {
            let path = checked_library_path(&root, &query.path, &private)?;
            if !matches!(
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str(),
                "html" | "htm"
            ) {
                return Err((StatusCode::BAD_REQUEST, "Not an HTML document".into()));
            }
            let detected = file_kind::from_path(&path)
                .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
            if detected.mime != "text/html" || detected.binary {
                return Err((StatusCode::BAD_REQUEST, "Not an HTML document".into()));
            }
            let source = String::from_utf8(read_document_source(&path)?)
                .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
            let relative_base = html_resources_base(&api_prefix, &token, &query.path);
            let base = format!("{origin}{relative_base}");
            Ok(html_preview(&source, &base, &document_url))
        })
        .await;
    match result {
        Ok(Ok(body)) => {
            let resource_root = format!(
                "{resource_origin}{resource_api_prefix}/api/html-resource/{resource_token}/"
            );
            let csp = format!(
                "default-src 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; script-src 'unsafe-inline' {resource_root}; style-src 'unsafe-inline' {resource_root}; img-src data: blob: {resource_root}; font-src data: {resource_root}; media-src {resource_root}; base-uri {resource_root}; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'"
            );
            let mut response = body.into_response();
            response.headers_mut().insert(
                axum::http::header::CONTENT_TYPE,
                "text/html; charset=utf-8".parse().unwrap(),
            );
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                "no-store".parse().unwrap(),
            );
            response
                .headers_mut()
                .insert("content-security-policy", csp.parse().unwrap());
            response
                .headers_mut()
                .insert("x-content-type-options", "nosniff".parse().unwrap());
            response
                .headers_mut()
                .insert("referrer-policy", "no-referrer".parse().unwrap());
            response
                .headers_mut()
                .insert("x-dns-prefetch-control", "off".parse().unwrap());
            response.headers_mut().insert(
                "permissions-policy",
                "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()"
                    .parse()
                    .unwrap(),
            );
            response
        }
        Ok(Err((status, error))) => json_error(status, error).into_response(),
        Err(error) => worker_error(error),
    }
}

pub(super) async fn html_resource(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    AxumPath(params): AxumPath<HashMap<String, String>>,
) -> Response {
    let token = params.get("token").map(String::as_str).unwrap_or_default();
    let path = params.get("path").map(String::as_str).unwrap_or_default();
    if !state.html.authorizes(token) {
        return json_error(StatusCode::FORBIDDEN, "Invalid HTML resource capability")
            .into_response();
    }
    let root = state.root_for_uri(uri.path());
    let private = state.data_directory.clone();
    let file_path = match checked_library_path(&root, &path, &private) {
        Ok(path) => path,
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if !HTML_RESOURCE_EXTENSION_RE.is_match(extension) {
        return json_error(StatusCode::FORBIDDEN, "Unsupported HTML resource").into_response();
    }
    let mut file = match tokio::fs::File::open(&file_path).await {
        Ok(file) => file,
        Err(error) => return json_error(StatusCode::NOT_FOUND, error.to_string()).into_response(),
    };
    let metadata = match file.metadata().await {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return json_error(StatusCode::NOT_FOUND, "Resource not found").into_response(),
        Err(error) => return json_error(StatusCode::NOT_FOUND, error.to_string()).into_response(),
    };
    let mime = match media_type(&file_path, &mut file).await {
        Ok(mime) => mime,
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, error.to_string()).into_response();
        }
    };
    let mut response = Response::new(Body::from_stream(stream_file(file)));
    let headers = response.headers_mut();
    headers.insert(axum::http::header::CONTENT_TYPE, mime.parse().unwrap());
    headers.insert(axum::http::header::CONTENT_LENGTH, metadata.len().into());
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("access-control-allow-origin", "*".parse().unwrap());
    headers.insert(
        "content-security-policy",
        "sandbox; default-src 'none'".parse().unwrap(),
    );
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    response
}
