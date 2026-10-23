use super::*;

pub(super) async fn session_leases(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Json(request): Json<LeaseRequest>,
) -> Response {
    if !LEASE_CLIENT_RE.is_match(&request.client) || request.paths.len() > 64 {
        return json_error(StatusCode::BAD_REQUEST, "Invalid session lease").into_response();
    }
    let mut paths = Vec::new();
    for value in request.paths {
        match checked_library_path(
            &state.root_for_uri(uri.path()),
            &value,
            &state.data_directory,
        ) {
            Ok(path) => paths.push(path),
            Err((StatusCode::NOT_FOUND, _)) => {}
            Err((_, error)) => return json_error(StatusCode::BAD_REQUEST, error).into_response(),
        }
    }
    match state
        .runtime
        .update_lease(&request.client, request.version, paths)
    {
        Ok(()) => {}
        Err(LeaseUpdateError::Busy) => return worker_error(worker::WorkerError::Busy),
        Err(LeaseUpdateError::Poisoned) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Lease store lock poisoned",
            )
            .into_response();
        }
    }
    state.refresh_document_leases();
    Json(serde_json::json!({"ok":true})).into_response()
}

pub(super) async fn library_session(
    State(state): State<AppState>,
    Query(query): Query<LibrarySessionQuery>,
) -> Response {
    let repo_exists = if query.repo.is_empty() {
        state.repository_for_uri("/").is_some()
    } else {
        state
            .repositories
            .find(&query.repo)
            .ok()
            .flatten()
            .is_some()
    };
    if !SESSION_CLIENT_RE.is_match(&query.client) || !repo_exists {
        return json_error(StatusCode::BAD_REQUEST, "Invalid library client").into_response();
    }
    let (receiver, guard) = match state
        .runtime
        .library_events
        .subscribe(query.client, query.repo)
    {
        Ok(subscription) => subscription,
        Err(ClientStateError::Poisoned) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Library session store unavailable",
            )
            .into_response();
        }
    };
    let connected = stream::once(async {
        Ok::<Event, Infallible>(Event::default().event("connected").data("{}"))
    });
    let events = stream::unfold(
        (
            receiver,
            tokio::time::interval(std::time::Duration::from_secs(15)),
            guard,
        ),
        |(mut receiver, mut ticker, guard)| async move {
            tokio::select! {
                value = receiver.recv() => match value {
                    Some(value) => {
                        let data = serde_json::to_string(&value)
                            .expect("library event serialization is infallible");
                        Some((Ok::<Event, Infallible>(Event::default().event("document-open").data(data)), (receiver, ticker, guard)))
                    },
                    None => None,
                },
                _ = ticker.tick() => Some((Ok::<Event, Infallible>(Event::default().event("ping").data("{}")), (receiver, ticker, guard))),
            }
        },
    );
    Sse::new(
        connected
            .chain(events)
            .take_until(wait_for_shutdown(state.shutdown.subscribe())),
    )
    .keep_alive(KeepAlive::default())
    .into_response()
}

pub(super) async fn library_activity(
    State(state): State<AppState>,
    Json(request): Json<ClientRequest>,
) -> Response {
    let active = state
        .runtime
        .library_events
        .record_library_activity(&request.client, Instant::now());
    Json(serde_json::json!({"ok":active})).into_response()
}

pub(super) async fn library_open(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Json(request): Json<LibraryOpenRequest>,
) -> Response {
    if request.line.is_some_and(|line| line < 1)
        || request
            .view
            .as_deref()
            .is_some_and(|view| !matches!(view, "preview" | "raw"))
    {
        return json_error(StatusCode::BAD_REQUEST, "Invalid source line or view").into_response();
    }
    let (repo, canonical_file) = match request.file.as_deref() {
        Some(file) => {
            let requested_file = Path::new(file);
            if !requested_file.is_absolute() {
                return json_error(StatusCode::BAD_REQUEST, "file must be an absolute path")
                    .into_response();
            }
            let Ok(canonical_file) = requested_file.canonicalize() else {
                return json_error(StatusCode::NOT_FOUND, "File not found").into_response();
            };
            let mut repos = match state.repositories.list() {
                Ok(repos) => repos,
                Err(error) => {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
                }
            };
            repos.sort_by_key(|repo| std::cmp::Reverse(repo.root.as_os_str().len()));
            let Some(repo) = repos
                .into_iter()
                .find(|repo| canonical_file.starts_with(&repo.root))
            else {
                return json_error(
                    StatusCode::NOT_FOUND,
                    "File does not belong to a registered repository",
                )
                .into_response();
            };
            (repo, Some(canonical_file))
        }
        None => {
            let repo = request
                .repo
                .as_deref()
                .and_then(|value| state.repositories.find(value).ok().flatten())
                .or_else(|| state.repository_for_uri(uri.path()));
            let Some(repo) = repo else {
                return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
            };
            (repo, None)
        }
    };
    let root = repo.root.clone();
    let relative = match canonical_file {
        Some(file) => file
            .strip_prefix(&root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/"),
        None => request.path.unwrap_or_default(),
    };
    let file = match checked_library_path(&root, &relative, &state.data_directory) {
        Ok(file) => file,
        Err((status, error)) => return json_error(status, error).into_response(),
    };
    if !file.is_file() {
        return json_error(StatusCode::BAD_REQUEST, "Not a file").into_response();
    }
    let relative = file
        .strip_prefix(&*root)
        .unwrap_or(&file)
        .to_string_lossy()
        .replace('\\', "/");
    let repo_slug = repo.slug.clone();
    let mut query = Vec::new();
    if let Some(line) = request.line {
        query.push(format!("line={line}"));
    }
    if let Some(view) = request.view.as_deref() {
        query.push(format!("view={view}"));
    }
    let url = format!(
        "/{}/tree/{}{}",
        encode_query_component(&repo_slug),
        encode_path(&relative),
        if query.is_empty() {
            String::new()
        } else {
            format!("?{}", query.join("&"))
        }
    );
    let payload = LibraryOpenEvent {
        repo: repo_slug,
        path: relative,
        line: request.line,
        view: request
            .view
            .or_else(|| request.line.map(|_| "raw".into()))
            .unwrap_or_else(|| "preview".into()),
        url: url.clone(),
    };
    match state
        .runtime
        .library_events
        .dispatch_open(&payload, &repo.id, &repo.slug)
    {
        Ok(true) => return Json(serde_json::json!({"reused":true,"url":url})).into_response(),
        Ok(false) => {}
        Err(ClientStateError::Poisoned) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Library session store unavailable",
            )
            .into_response();
        }
    }
    let browser_url = format!("{}{url}", state.base_url);
    #[cfg(target_os = "windows")]
    let launched = tokio::process::Command::new(
        std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("WINDIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("explorer.exe"),
    )
    .arg(&browser_url)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn();
    #[cfg(target_os = "macos")]
    let launched = tokio::process::Command::new("open")
        .arg(&browser_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let launched = tokio::process::Command::new("xdg-open")
        .arg(&browser_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match launched {
        Ok(_child) => Json(serde_json::json!({"reused":false,"url":url})).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":"Could not open browser","reused":false,"url":url})),
        )
            .into_response(),
    }
}

pub(super) async fn open_directory(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Json(request): Json<OpenDirectoryRequest>,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let requested = request.path.unwrap_or_default();
    if requested.contains('\0') {
        return json_error(StatusCode::BAD_REQUEST, "Invalid directory path").into_response();
    }
    let candidate = root.join(if requested.is_empty() {
        "."
    } else {
        &requested
    });
    let directory = match candidate.canonicalize() {
        Ok(path) if path.starts_with(&*root) && !path.starts_with(&*state.data_directory) => path,
        Ok(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Directory is outside the repository root",
            )
            .into_response();
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return json_error(StatusCode::NOT_FOUND, "Not found").into_response();
        }
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, error.to_string()).into_response();
        }
    };
    if !directory.is_dir() {
        return json_error(StatusCode::BAD_REQUEST, "Not a directory").into_response();
    }
    let result = system_open::open(&directory).await;
    match result {
        Ok(()) => Json(serde_json::json!({"ok":true})).into_response(),
        Err(error) => {
            let status = if error.kind() == std::io::ErrorKind::NotFound {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            json_error(status, error.to_string()).into_response()
        }
    }
}
