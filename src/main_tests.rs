#[cfg(windows)]
#[test]
fn client_paths_use_compatible_windows_syntax() {
    assert_eq!(client_path(Path::new(r"\\?\C:\Users\jay")), r"C:\Users\jay");
    assert_eq!(
        client_path(Path::new(r"\\?\UNC\server\share\repo")),
        r"\\server\share\repo"
    );
}
use super::*;

#[tokio::test]
async fn shutdown_ends_all_sse_streams_and_releases_session_registration() {
    let temporary = tempfile::tempdir().unwrap();
    let (state, slug) = test_state(&temporary);
    let app = build_router(state.clone());
    let paths = [
        format!("/{slug}/api/library/events?path=note.md"),
        format!("/{slug}/api/library/tree-events"),
        format!("/api/library/session?client=shutdown-client-1234&repo={slug}"),
    ];
    let mut streams = Vec::new();
    for path in paths {
        let response = request(&app, "GET", &path, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = response.into_body().into_data_stream();
        tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        streams.push(stream);
    }
    state.shutdown.send_replace(true);
    for mut stream in streams {
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
                .await
                .unwrap()
                .is_none()
        );
    }
    assert!(
        state
            .runtime
            .library_events
            .clients
            .lock()
            .unwrap()
            .is_empty()
    );
    state.document_workers.shutdown().await;
    state.rendering.close().await;
}
use axum::{
    body::{Body, to_bytes},
    http::Request as HttpRequest,
};
use futures_util::TryStreamExt;
use tower::ServiceExt;

async fn request(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
) -> Response {
    let mut builder = HttpRequest::builder()
        .method(method)
        .uri(uri)
        .header("host", "localhost")
        .header("origin", "http://localhost");
    let body = match body {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    app.clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap()
}

async fn json(response: Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn test_state(temporary: &tempfile::TempDir) -> (AppState, String) {
    let root = temporary.path().join("notes");
    let data = temporary.path().join("data");
    let web = temporary.path().join("dist/web");
    let assets = temporary.path().join("dist/assets");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&web).unwrap();
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(root.join("note.md"), "# Hello Rust\n\nneedle in markdown\n").unwrap();
    std::fs::write(
            root.join("sample.html"),
            "<html><head><base href=\"https://invalid.example/\"></head><body><script>window.ready=true</script><iframe src=\"https://invalid.example\"></iframe><link rel=\"stylesheet\" href=\"theme.css\"><a href=\"#section\">Jump</a></body></html>",
        )
        .unwrap();
    std::fs::write(root.join("theme.css"), "body { color: rebeccapurple; }").unwrap();
    std::fs::write(
        web.join("index.html"),
        "<!doctype html><main>library app</main>",
    )
    .unwrap();
    std::fs::write(assets.join("app.js"), "console.log('loaded')").unwrap();
    let repositories = Arc::new(repositories::RepositoryStore::open(&data, Some(&root)).unwrap());
    let repo = repositories.list().unwrap().remove(0);
    (
        AppState {
            root: Arc::new(root.clone()),
            service_root: Arc::new(root.clone()),
            dist: Arc::new(web),
            document_workers: worker::WorkerPool::new("document", 1, 16),
            media_workers: worker::WorkerPool::new("media", 1, 256),
            media_metadata_workers: worker::WorkerPool::new("media-metadata", 1, 256),
            media_metadata: Arc::new(media::MetadataService::default()),
            media_previews: Arc::new(media::PreviewFlights::default()),
            rendering: Arc::new(render::RenderService::default()),
            shutdown: tokio::sync::watch::channel(false).0,
            html: html::Service::new().unwrap(),
            search: Arc::new(search::SearchService::default()),
            data_directory: Arc::new(data.clone()),
            access: Arc::new(
                access::AccessPolicy::load(&data, "test-host", "http://localhost").unwrap(),
            ),
            trees: tree::Service::default(),
            repositories,
            file_history: Arc::new(file_history::FileHistory::new(data)),
            runtime: Arc::new(RuntimeState::default()),
            base_url: Arc::new("http://127.0.0.1:49191".into()),
        },
        repo.slug,
    )
}

fn minimal_pdf(width: usize, height: usize) -> Vec<u8> {
    let content = "BT /F1 14 Tf 24 48 Td (PDF preview) Tj ET";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        ),
    ];
    let mut output = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![0usize];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(output.len());
        output.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = output.len();
    output
        .extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes());
    for offset in offsets.iter().skip(1) {
        output.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    output.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            offsets.len()
        )
        .as_bytes(),
    );
    output
}

#[tokio::test]
async fn html_raw_source_and_multiple_asset_watches_match_frontend_contract() {
    let temporary = tempfile::tempdir().unwrap();
    let (state, slug) = test_state(&temporary);
    let expected = std::fs::read_to_string(state.root.join("sample.html")).unwrap();
    let app = build_router(state.clone());
    let document = json(
        request(
            &app,
            "GET",
            &format!("/{slug}/api/document?path=sample.html&view=raw"),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(document["source"], expected);
    assert_eq!(document["lineCount"], expected.split('\n').count());
    let response = request(
        &app,
        "GET",
        &format!("/{slug}/api/library/events?path=sample.html&asset=theme.css&asset=note.md"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let watchers = state.runtime.file_watchers.lock().unwrap();
    let key = watchers.keys().next().unwrap();
    assert_eq!(key.assets.len(), 2);
    assert_eq!(key.assets[0].1, "theme.css");
    assert_eq!(key.assets[1].1, "note.md");
}

#[tokio::test]
async fn saturated_render_queue_returns_retryable_errors() {
    let temporary = tempfile::tempdir().unwrap();
    let (mut state, slug) = test_state(&temporary);
    state.document_workers = worker::WorkerPool::new("saturated", 1, 1);
    let pool = state.document_workers.clone();
    let (release, wait) = std::sync::mpsc::channel();
    let (started, ready) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        pool.run(move || {
            let _ = started.send(());
            wait.recv().unwrap();
        })
        .await
    });
    ready.await.unwrap();
    let pool = state.document_workers.clone();
    let mut queued = Box::pin(pool.run(|| ()));
    assert!(futures_util::poll!(&mut queued).is_pending());
    let app = build_router(state);
    for endpoint in ["document?path=note.md", "html?path=sample.html"] {
        let response = request(&app, "GET", &format!("/{slug}/api/{endpoint}"), None).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers().get("retry-after").unwrap(), "1");
    }
    drop(queued);
    release.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn file_stream_preserves_large_payloads_across_chunk_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("payload.bin");
    let expected = (0..150_000)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    std::fs::write(&path, &expected).unwrap();
    let file = tokio::fs::File::open(path).await.unwrap();
    let chunks = stream_file(file).try_collect::<Vec<_>>().await.unwrap();
    let actual = chunks.into_iter().flatten().collect::<Vec<_>>();
    assert_eq!(actual, expected);
}

#[tokio::test]
async fn raw_text_media_type_declares_utf8_and_preserves_file_bytes() {
    use tokio::io::AsyncReadExt;

    let temporary = tempfile::tempdir().unwrap();
    for (name, bytes, expected) in [
        (
            "sqlite.md",
            "SQLite 中文说明\n".as_bytes(),
            "text/markdown; charset=utf-8",
        ),
        (
            "note.txt",
            "中文原始文本\n".as_bytes(),
            "text/plain; charset=utf-8",
        ),
        (
            "page.html",
            "<p>中文</p>".as_bytes(),
            "text/html; charset=utf-8",
        ),
        ("image.md", &b"\x89PNG\r\n\x1a\n"[..], "image/png"),
        ("binary.txt", &b"data\0\xff"[..], "application/octet-stream"),
    ] {
        let path = temporary.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        let mut file = tokio::fs::File::open(&path).await.unwrap();
        assert_eq!(media_type(&path, &mut file).await.unwrap(), expected);
        let mut actual = Vec::new();
        file.read_to_end(&mut actual).await.unwrap();
        assert_eq!(actual, bytes);
    }
}

#[tokio::test]
async fn content_detection_preserves_renamed_previews_assets_and_text_semantics() {
    let temporary = tempfile::tempdir().unwrap();
    let (state, slug) = test_state(&temporary);
    let root = state.default_repository().unwrap().root;
    let pdf = minimal_pdf(595, 842);
    let png = b"\x89PNG\r\n\x1a\n";
    std::fs::write(root.join("renamed.txt"), &pdf).unwrap();
    std::fs::write(root.join("picture.pdf"), png).unwrap();
    std::fs::write(root.join("archive.txt"), b"PK\x03\x04\0\0\0\0").unwrap();
    std::fs::write(root.join("inline.md"), "<div>needle</div>\n").unwrap();
    let app = build_router(state);

    let metadata = json(
        request(
            &app,
            "GET",
            &format!("/{slug}/api/document?path=renamed.txt"),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(metadata["type"], "pdf");
    assert_eq!(metadata["pages"].as_array().unwrap().len(), 1);
    let page_url = metadata["pages"][0]["url"].as_str().unwrap();
    assert_eq!(
        request(&app, "GET", page_url, None).await.status(),
        StatusCode::OK
    );

    let image = json(
        request(
            &app,
            "GET",
            &format!("/{slug}/api/document?path=picture.pdf"),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(image["type"], "image");
    assert_eq!(image["mime"], "image/png");
    assert_eq!(image["format"], "png");
    let asset = request(&app, "GET", image["url"].as_str().unwrap(), None).await;
    assert_eq!(asset.headers()["content-type"], "image/png");
    assert_eq!(
        &to_bytes(asset.into_body(), usize::MAX).await.unwrap()[..],
        png
    );

    let archive = json(
        request(
            &app,
            "GET",
            &format!("/{slug}/api/document?path=archive.txt"),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(archive["type"], "binary");
    assert_eq!(archive["mime"], "application/zip");
    let markdown = json(
        request(
            &app,
            "GET",
            &format!("/{slug}/api/document?path=inline.md&view=raw"),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(markdown["type"], "markdown");

    let search =
        json(request(&app, "GET", &format!("/{slug}/api/search?q=PDF-1"), None).await).await;
    assert_eq!(search["total"], 0);
}

#[tokio::test]
async fn migrated_http_routes_match_frontend_repository_flows() {
    let temporary = tempfile::tempdir().unwrap();
    let (state, slug) = test_state(&temporary);
    let html_token = state.html.token();
    let app = build_router(state.clone());

    let home = request(&app, "GET", "/", None).await;
    assert_eq!(home.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        home.headers().get("location").unwrap().to_str().unwrap(),
        format!("/{slug}/tree/")
    );

    let page = request(&app, "GET", &format!("/{slug}/tree/"), None).await;
    assert_eq!(page.status(), StatusCode::OK);
    assert!(
        String::from_utf8(
            to_bytes(page.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec()
        )
        .unwrap()
        .contains("library app")
    );
    let asset = request(&app, "GET", "/assets/app.js", None).await;
    assert_eq!(asset.status(), StatusCode::OK);

    let tree = json(request(&app, "GET", &format!("/{slug}/api/tree"), None).await).await;
    assert_eq!(tree["name"], "notes");
    assert_eq!(tree["children"][0]["path"], "note.md");
    let document = json(
        request(
            &app,
            "GET",
            &format!("/{slug}/api/document?path=note.md"),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(document["type"], "markdown");
    assert!(
        document["html"]
            .as_str()
            .unwrap()
            .contains("needle in markdown")
    );
    let html = request(
        &app,
        "GET",
        &format!("/{slug}/api/html?path=sample.html"),
        None,
    )
    .await;
    assert_eq!(html.status(), StatusCode::OK);
    assert!(html.headers().contains_key("content-security-policy"));
    let html = String::from_utf8(
        to_bytes(html.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("window.ready=true"));
    assert!(!html.contains("<iframe"));
    assert!(!html.contains("https://invalid.example/"));
    assert!(html.contains("#section"));
    let css = request(
        &app,
        "GET",
        &format!(
            "/{slug}/api/html-resource/{}/theme.css",
            html_token.as_str()
        ),
        None,
    )
    .await;
    assert_eq!(
        css.status(),
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&to_bytes(css.into_body(), usize::MAX).await.unwrap())
    );
    assert_eq!(
        css.headers().get("content-type").unwrap(),
        "text/css; charset=utf-8"
    );
    let denied = request(
        &app,
        "GET",
        &format!("/{slug}/api/html-resource/not-a-token/theme.css"),
        None,
    )
    .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let search =
        json(request(&app, "GET", &format!("/{slug}/api/search?q=needle"), None).await).await;
    assert_eq!(search["files"][0]["path"], "note.md");

    let lease_uri = format!("/{slug}/api/library/session-leases");
    let lease = request(
        &app,
        "POST",
        &lease_uri,
        Some(serde_json::json!({
            "client":"reader-1", "paths":["note.md"], "version":1
        })),
    )
    .await;
    assert_eq!(lease.status(), StatusCode::OK);
    let stale_release = request(
        &app,
        "POST",
        &lease_uri,
        Some(serde_json::json!({
            "client":"reader-1", "paths":[], "version":1
        })),
    )
    .await;
    assert_eq!(stale_release.status(), StatusCode::OK);
    assert_eq!(
        state.runtime.leases.lock().unwrap()["reader-1"].paths.len(),
        1
    );
    let invalid_lease = request(
        &app,
        "POST",
        &lease_uri,
        Some(serde_json::json!({
            "client":"reader-1", "paths":["../outside"], "version":2
        })),
    )
    .await;
    assert_eq!(invalid_lease.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        state.runtime.leases.lock().unwrap()["reader-1"].paths.len(),
        1
    );
    let release = request(
        &app,
        "POST",
        &lease_uri,
        Some(serde_json::json!({
            "client":"reader-1", "paths":[], "version":2
        })),
    )
    .await;
    assert_eq!(release.status(), StatusCode::OK);
    assert!(
        state.runtime.leases.lock().unwrap()["reader-1"]
            .paths
            .is_empty()
    );

    let invalid = request(
        &app,
        "GET",
        &format!("/{slug}/api/document?path=../outside"),
        None,
    )
    .await;
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        request(&app, "GET", "/missing/api/tree", None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );

    let bookmark = request(
        &app,
        "PUT",
        &format!("/{slug}/api/bookmarks"),
        Some(serde_json::json!({"path":"note.md","bookmarked":true})),
    )
    .await;
    assert_eq!(bookmark.status(), StatusCode::OK);
    assert_eq!(json(request(&app, "GET", &format!("/{slug}/api/bookmarks"), None).await).await["bookmarks"].as_array().unwrap().len(), 1);
    let recent = request(
        &app,
        "POST",
        &format!("/{slug}/api/recent-files"),
        Some(serde_json::json!({"path":"note.md"})),
    )
    .await;
    assert_eq!(recent.status(), StatusCode::OK);
    assert_eq!(json(recent).await["recent"][0], "note.md");

    let cross_origin = HttpRequest::builder()
        .header("host", "localhost")
        .method("PUT")
        .uri(format!("/{slug}/api/bookmarks"))
        .header("content-type", "application/json")
        .header("origin", "https://attacker.example")
        .body(Body::from(r#"{"path":"note.md","bookmarked":false}"#))
        .unwrap();
    let rejected = app.clone().oneshot(cross_origin).await.unwrap();
    assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pdf_document_reports_a_valid_modified_timestamp() {
    let temporary = tempfile::tempdir().unwrap();
    let (state, slug) = test_state(&temporary);
    std::fs::write(state.root.join("sample.pdf"), minimal_pdf(595, 842)).unwrap();
    let app = build_router(state);

    let response = request(
        &app,
        "GET",
        &format!("/{slug}/api/document?path=sample.pdf"),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let document = json(response).await;
    let modified = document["modified"].as_str().unwrap();
    assert!(
        time::OffsetDateTime::parse(modified, &time::format_description::well_known::Rfc3339)
            .is_ok()
    );
    let revision = document["revision"].as_str().unwrap();
    assert_ne!(revision, modified);
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/{slug}/api/pdf/page?path=sample.pdf&page=1&v={revision}&width=450"),
            None,
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/{slug}/api/pdf/page?path=sample.pdf&page=1&v=stale&width=450"),
            None,
        )
        .await
        .status(),
        StatusCode::GONE
    );
}

#[tokio::test]
async fn document_and_asset_changes_are_both_emitted_by_library_events() {
    let temporary = tempfile::tempdir().unwrap();
    let (state, slug) = test_state(&temporary);
    let root = state.default_repository().unwrap().root;
    let app = build_router(state.clone());
    let mut streams = Vec::new();
    for _ in 0..2 {
        let response = request(
            &app,
            "GET",
            &format!("/{slug}/api/library/events?path=sample.html&asset=theme.css"),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        streams.push(Box::pin(response.into_body().into_data_stream()));
    }
    assert_eq!(state.runtime.file_watchers.lock().unwrap().len(), 1);
    for stream in &mut streams {
        let mut body = String::new();
        while !body.contains("event: connected") {
            let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            body.push_str(&String::from_utf8_lossy(&chunk));
        }
    }
    std::fs::write(root.join("sample.html"), "<html>changed</html>").unwrap();
    std::fs::write(root.join("theme.css"), "body{color:blue}").unwrap();
    for stream in &mut streams {
        let mut body = String::new();
        while !body.contains("event: document") || !body.contains("event: assets") {
            let chunk = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            body.push_str(&String::from_utf8_lossy(&chunk));
        }
        assert!(body.contains("data: {\"paths\":[\"theme.css\"]}"));
    }
}

#[tokio::test]
async fn pdf_metadata_and_page_route_match_frontend_contract() {
    let temporary = tempfile::tempdir().unwrap();
    let (state, slug) = test_state(&temporary);
    let root = state.default_repository().unwrap().root;
    std::fs::write(root.join("sample.pdf"), minimal_pdf(595, 842)).unwrap();
    let app = build_router(state);
    let metadata = json(
        request(
            &app,
            "GET",
            &format!("/{slug}/api/document?path=sample.pdf"),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(metadata["type"], "pdf");
    assert_eq!(metadata["pages"].as_array().unwrap().len(), 1);
    let page_url = metadata["pages"][0]["url"].as_str().unwrap();
    let page = request(
        &app,
        "GET",
        &format!(
            "{page_url}&v={}&width=2250",
            metadata["revision"].as_str().unwrap()
        ),
        None,
    )
    .await;
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(
        page.headers().get("content-type").unwrap(),
        "image/svg+xml; charset=utf-8"
    );
    let svg = String::from_utf8(
        to_bytes(page.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(svg.contains("<svg"));
    let invalid_width = request(&app, "GET", &format!("{page_url}&width=0"), None).await;
    assert_eq!(invalid_width.status(), StatusCode::BAD_REQUEST);
    let stale = request(&app, "GET", &format!("{page_url}&v=stale"), None).await;
    assert_eq!(stale.status(), StatusCode::GONE);
}

#[tokio::test]
async fn tree_event_scanning_is_shared_and_emits_after_changes() {
    let temporary = tempfile::tempdir().unwrap();
    let (state, slug) = test_state(&temporary);
    let root = state.default_repository().unwrap().root;
    let app = build_router(state.clone());
    let mut streams = Vec::new();
    for _ in 0..2 {
        let response = request(
            &app,
            "GET",
            &format!("/{slug}/api/library/tree-events"),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        streams.push(Box::pin(response.into_body().into_data_stream()));
    }
    assert_eq!(state.trees.cached_roots(), 1);
    for stream in &mut streams {
        let mut handshake = String::new();
        while !handshake.contains("event: connected") {
            let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            handshake.push_str(&String::from_utf8_lossy(&chunk));
        }
    }
    std::fs::write(root.join("new-note.md"), "new").unwrap();
    for stream in &mut streams {
        let mut event = String::new();
        while !event.contains("event: tree") {
            let chunk = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            event.push_str(&String::from_utf8_lossy(&chunk));
        }
    }
    drop(streams);
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert_eq!(state.trees.cached_roots(), 1); // Reuse the idle cache on reconnect.
}

#[tokio::test]
async fn api_routes_keep_global_and_repository_operations_separate() {
    let temporary = tempfile::tempdir().unwrap();
    let (state, slug) = test_state(&temporary);
    let app = build_router(state.clone());
    for path in [
        "/api/tree",
        "/api/document?path=note.md",
        "/api/bookmarks",
        "/api/reading",
        "/api/recent-files",
        "/api/git/status",
        "/api/search?q=needle",
        "/api/search-repos?q=needle",
        "/api/library/tree-events",
        "/api/library/events?path=note.md",
        &format!("/{slug}/api/repos"),
        &format!("/{slug}/api/directories"),
        &format!("/{slug}/api/search-repos?q=needle"),
        &format!("/{slug}/api/library/session?client=separate-routes-1234"),
    ] {
        let response = request(&app, "GET", path, None).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert!(json(response).await["error"].is_string(), "{path}");
    }
    for path in ["/api/library/activity", "/api/library/open"] {
        let response = request(
            &app,
            "POST",
            &format!("/{slug}{path}"),
            Some(serde_json::json!({})),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    let response = request(
        &app,
        "POST",
        "/api/library/session-leases",
        Some(serde_json::json!({})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        request(&app, "GET", "/api/repos", None).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", &format!("/{slug}/api/tree"), None)
            .await
            .status(),
        StatusCode::OK
    );
    state.document_workers.shutdown().await;
    state.rendering.close().await;
}

#[tokio::test]
async fn text_document_variants_serialize_camel_case_line_counts() {
    let temporary = tempfile::tempdir().unwrap();
    let (state, slug) = test_state(&temporary);
    let root = state.default_repository().unwrap().root;
    for path in ["lines.md", "lines.typ", "lines.txt", "lines.html"] {
        std::fs::write(root.join(path), "first\nsecond").unwrap();
    }
    let app = build_router(state.clone());
    for (path, kind) in [
        ("lines.md", "markdown"),
        ("lines.typ", "typst"),
        ("lines.txt", "text"),
        ("lines.html", "html"),
    ] {
        let response = request(
            &app,
            "GET",
            &format!("/{slug}/api/document?path={path}&view=raw"),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let value = json(response).await;
        assert_eq!(value["type"], kind);
        assert_eq!(value["lineCount"], 2, "{path}: {value}");
        assert!(value.get("line_count").is_none());
        assert_eq!(value["source"], "first\nsecond");
    }
    let response = request(
        &app,
        "GET",
        &format!("/{slug}/api/library/events?path=lines.md"),
        None,
    )
    .await;
    let mut stream = response.into_body().into_data_stream();
    let chunk = stream.next().await.unwrap().unwrap();
    let event = String::from_utf8_lossy(&chunk);
    let payload = event
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(payload).unwrap();
    assert!(payload["modified"].is_string());
    drop(stream);
    state.document_workers.shutdown().await;
    state.rendering.close().await;
}

#[test]
fn directory_browser_includes_server_metadata_and_hides_private_data() {
    let temporary = tempfile::tempdir().unwrap();
    let private = temporary.path().join("data");
    std::fs::create_dir(&private).unwrap();
    std::fs::create_dir(temporary.path().join("notes")).unwrap();
    let listing = browse_directories(None, temporary.path(), &private).unwrap();
    assert!(!listing.hostname.is_empty());
    assert_eq!(listing.hostname, server_hostname());
    assert_eq!(listing.root_path, machine_root_path());
    assert_eq!(listing.directories.len(), 1);
    assert_eq!(listing.directories[0].name, "notes");
    assert!(!listing.path.is_empty());
}

#[cfg(windows)]
#[test]
fn directory_browser_machine_root_lists_drives_without_a_registerable_path() {
    let temporary = tempfile::tempdir().unwrap();
    let listing = browse_machine_root(temporary.path()).unwrap();
    assert!(listing.path.is_empty());
    assert!(listing.root_path.is_empty());
    assert!(listing.parent.is_none());
    assert_eq!(listing.name, server_hostname());
    assert!(!listing.directories.is_empty());
    for drive in listing.directories {
        assert!(Path::new(&drive.path).is_absolute());
        assert!(drive.name.ends_with(':'));
    }
}
