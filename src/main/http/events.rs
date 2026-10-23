use super::*;

pub(super) async fn library_events(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let query = match library_events_query(&uri) {
        Ok(query) => query,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error).into_response(),
    };
    let root = state.root_for_uri(uri.path());
    let private = state.data_directory.clone();
    let document = match checked_library_path(&root, &query.path, &private) {
        Ok(path) => path,
        Err((status, message)) => return json_error(status, message).into_response(),
    };
    let mut assets = Vec::new();
    for value in query.asset.into_iter().take(128) {
        if let Ok(path) = checked_library_path(&root, &value, &private)
            && !assets.iter().any(|(existing, _)| existing == &path)
        {
            assets.push((path, value));
        }
    }
    let receiver = state
        .runtime
        .subscribe_file_events(document.clone(), assets.clone());
    let snapshot = serde_json::json!({
        "modified": modified_rfc3339(&document),
        "assets": assets.iter().map(|(path, name)| {
            (name.clone(), file_signature(path).map(|(modified, size)| format!("{modified}:{size}")))
        }).collect::<std::collections::HashMap<_, _>>()
    }).to_string();
    let events: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> =
        Box::pin(stream::unfold(
            (
                Some(receiver),
                true,
                Some(snapshot),
                VecDeque::<Event>::new(),
            ),
            |(mut receiver, mut initial, mut snapshot, mut pending)| async move {
                if initial {
                    initial = false;
                    let event = Event::default()
                        .event("connected")
                        .data(snapshot.take().unwrap_or_default());
                    return Some((Ok(event), (receiver, initial, snapshot, pending)));
                }
                loop {
                    if let Some(event) = pending.pop_front() {
                        return Some((Ok(event), (receiver, initial, snapshot, pending)));
                    }
                    let current = receiver.as_mut()?.recv().await;
                    match current {
                        Ok(change) => {
                            if change.document_changed {
                                pending.push_back(Event::default().event("document").data("{}"));
                            }
                            if !change.assets.is_empty() {
                                pending.push_back(
                                    Event::default().event("assets").data(
                                        serde_json::json!({"paths":change.assets}).to_string(),
                                    ),
                                );
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            pending.push_back(Event::default().event("document").data("{}"));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                    }
                }
            },
        ));
    Sse::new(events.take_until(wait_for_shutdown(state.shutdown.subscribe())))
        .keep_alive(
            KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}

pub(super) async fn tree_events(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<TreeQuery>,
) -> Response {
    let root = state.root_for_uri(uri.path());
    let entry = match state.trees.entry(
        (*root).clone(),
        (*state.data_directory).clone(),
        query.show_hidden,
    ) {
        Ok(entry) => entry,
        Err(error) => return json_error(StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    // Subscribe before reading the snapshot so initialization and concurrent
    // updates cannot leave a gap between the HTTP tree and event stream.
    let receiver = entry.subscribe();
    let snapshot = match entry.snapshot().await {
        Ok(snapshot) => snapshot,
        Err(error) => return json_error(StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    let events = stream::unfold(
        (entry, receiver, true, snapshot.revision),
        |(entry, mut receiver, initial, mut revision)| async move {
            if initial {
                let data = serde_json::json!({"revision": revision.to_string()}).to_string();
                return Some((
                    Ok::<_, Infallible>(Event::default().event("connected").data(data)),
                    (entry, receiver, false, revision),
                ));
            }
            loop {
                let current = match receiver.recv().await {
                    Ok(tree::Event::Changed(current)) => current,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        match entry.snapshot().await {
                            Ok(snapshot) => snapshot.revision,
                            Err(_) => return None,
                        }
                    }
                    Ok(tree::Event::Removed)
                    | Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                };
                if current <= revision {
                    continue;
                }
                revision = current;
                return Some((
                    Ok(Event::default()
                        .event("tree")
                        .data(serde_json::json!({"revision":revision.to_string()}).to_string())),
                    (entry, receiver, false, revision),
                ));
            }
        },
    );
    Sse::new(events.take_until(wait_for_shutdown(state.shutdown.subscribe())))
        .keep_alive(
            KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}
