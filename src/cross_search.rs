use crate::{AppState, json_error, search};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

#[derive(Default)]
pub(super) struct Service {
    snapshots: Mutex<HashMap<String, CrossSearchSnapshot>>,
}

struct CrossSearchSnapshot {
    key: String,
    expires_at: Instant,
    files: Arc<Vec<CrossSearchFile>>,
    facets: Arc<CrossSearchFacets>,
    truncated: bool,
    match_count: usize,
    bytes: usize,
}
static NEXT_CROSS_SEARCH_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrossSearchFile {
    #[serde(flatten)]
    file: search::FileResult,
    repo_id: String,
    repo_name: String,
}

#[derive(Clone, Default, Serialize)]
struct CrossSearchFacets {
    languages: Vec<search::SearchFacet>,
    paths: Vec<search::SearchFacet>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct CrossSearchQuery {
    q: String,
    repo: Option<String>,
    #[serde(rename = "currentRepo")]
    current_repo: Option<String>,
    #[serde(rename = "currentFile")]
    current_file: Option<String>,
    search_id: Option<String>,
    offset: Option<usize>,
    lang: Option<String>,
    language: Option<String>,
    path: Option<String>,
    scope: Option<search::SearchScope>,
}

fn accumulate_facets(counts: &mut HashMap<String, usize>, facets: Vec<search::SearchFacet>) {
    for facet in facets {
        *counts.entry(facet.value).or_default() += facet.count;
    }
}

fn sorted_facets(counts: HashMap<String, usize>) -> Vec<search::SearchFacet> {
    let mut facets = counts
        .into_iter()
        .map(|(value, count)| search::SearchFacet { value, count })
        .collect::<Vec<_>>();
    search::sort_facets(&mut facets);
    facets
}

pub(super) async fn search_repositories(
    State(state): State<AppState>,
    Query(query): Query<CrossSearchQuery>,
) -> Response {
    let selected = match query.repo.as_deref().unwrap_or("") {
        "*" => match state.repositories.list() {
            Ok(repos) => repos,
            Err(error) => {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
            }
        },
        "" => {
            let value = state.default_repository();
            value.into_iter().collect()
        }
        value => match state.repositories.find(value) {
            Ok(Some(repo)) => vec![repo],
            Ok(None) => return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response(),
            Err(error) => {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
            }
        },
    };
    if selected.is_empty() {
        return json_error(StatusCode::NOT_FOUND, "Repo not found").into_response();
    }
    let key = serde_json::to_string(&(
        query.q.as_str(),
        query.repo.as_deref(),
        query.current_repo.as_deref(),
        query.current_file.as_deref(),
        query.lang.as_deref(),
        query.language.as_deref(),
        query.path.as_deref(),
        query.scope,
    ))
    .unwrap_or_default();
    let snapshot_id = query.search_id.clone().unwrap_or_default();
    let existing = if snapshot_id.is_empty() {
        None
    } else {
        match state.cross_search.snapshots.lock() {
            Ok(mut cache) => {
                cache.retain(|_, item| item.expires_at > Instant::now());
                match cache.get(&snapshot_id) {
                    Some(item) if item.key == key => Some((
                        item.files.clone(),
                        item.facets.clone(),
                        item.truncated,
                        item.match_count,
                    )),
                    _ => {
                        return json_error(
                            StatusCode::BAD_REQUEST,
                            "Search expired. Run the search again.",
                        )
                        .into_response();
                    }
                }
            }
            Err(_) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Search cache lock poisoned",
                )
                .into_response();
            }
        }
    };
    let (files, facets, truncated, match_count, search_id) =
        if let Some((files, facets, truncated, matches)) = existing {
            (files, facets, truncated, matches, snapshot_id)
        } else {
            let services = selected
                .into_iter()
                .map(|repo| (repo.clone(), state.search.clone()))
                .collect::<Vec<_>>();
            let mut request = query.clone();
            let current_repo =
                query
                    .current_repo
                    .as_deref()
                    .and_then(|value| state.repositories.find(value).ok().flatten())
                    .or_else(|| {
                        state.repositories.list().ok().and_then(|repos| {
                            repos.into_iter().find(|repo| repo.root == *state.root)
                        })
                    });
            request.current_repo = current_repo.map(|repo| repo.id);
            let private = state.data_directory.clone();
            let result = tokio::task::spawn_blocking(move || -> Result<_, String> {
                let mut files = Vec::new();
                let mut language_counts = HashMap::<String, usize>::new();
                let mut path_counts = HashMap::<String, usize>::new();
                let mut truncated = false;
                let mut cached_bytes = 0usize;
                let mut match_count = 0usize;

                for (repo, service) in services {
                    let mut search_id = None;
                    let mut offset = 0;
                    let bookmarks = repo
                        .bookmarks
                        .iter()
                        .map(|bookmark| bookmark.path.clone())
                        .collect::<Vec<_>>();

                    loop {
                        let params = search::SearchParams {
                            q: request.q.clone(),
                            scope: request.scope.clone(),
                            current_file: request.current_file.clone(),
                            search_id,
                            offset: Some(offset),
                            lang: request.lang.clone(),
                            language: request.language.clone(),
                            path: request.path.clone(),
                        };
                        let page = service.search_with_private(
                            &repo.root,
                            params,
                            Some(&bookmarks),
                            Some(&private),
                        )?;
                        truncated |= page.truncated;
                        if offset == 0 {
                            match_count += page.match_count;
                            accumulate_facets(&mut language_counts, page.facets.languages);
                            accumulate_facets(&mut path_counts, page.facets.paths);
                        }
                        for file in page.files {
                            let file = CrossSearchFile {
                                file,
                                repo_id: repo.id.clone(),
                                repo_name: repo.name.clone(),
                            };
                            cached_bytes = cached_bytes.saturating_add(
                                serde_json::to_vec(&file)
                                    .map_err(|error| error.to_string())?
                                    .len(),
                            );
                            if cached_bytes > 8 * 1024 * 1024 {
                                return Err(
                                "Search result exceeds cache budget. Try a more specific query."
                                    .into(),
                            );
                            }
                            files.push(file);
                        }
                        let Some(next_offset) = page.next_offset else {
                            break;
                        };
                        offset = next_offset;
                        search_id = Some(page.search_id);
                    }
                }

                let current_repo = request.current_repo.as_deref().unwrap_or_default();
                let current_file = request.current_file.as_deref().unwrap_or_default();
                files.sort_by(|left, right| {
                    let preferred = |file: &CrossSearchFile| {
                        file.repo_id == current_repo && file.file.path == current_file
                    };
                    (!preferred(left))
                        .cmp(&(!preferred(right)))
                        .then_with(|| left.repo_name.cmp(&right.repo_name))
                        .then_with(|| left.file.path.cmp(&right.file.path))
                });

                let facets = CrossSearchFacets {
                    languages: sorted_facets(language_counts),
                    paths: sorted_facets(path_counts),
                };
                Ok((files, facets, truncated, match_count))
            })
            .await;
            let (files, facets, truncated, match_count) = match result {
                Ok(Ok(value)) => value,
                Ok(Err(error)) => {
                    return json_error(StatusCode::BAD_REQUEST, error).into_response();
                }
                Err(error) => {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                        .into_response();
                }
            };
            let files = Arc::new(files);
            let facets = Arc::new(facets);
            let id = format!(
                "{}-{}",
                std::process::id(),
                NEXT_CROSS_SEARCH_ID.fetch_add(1, Ordering::Relaxed)
            );
            if let Ok(mut cache) = state.cross_search.snapshots.lock() {
                cache.retain(|_, item| item.expires_at > Instant::now());
                let bytes = files
                    .iter()
                    .map(|file| serde_json::to_vec(file).map_or(0, |json| json.len()))
                    .sum::<usize>()
                    + serde_json::to_vec(facets.as_ref()).map_or(0, |json| json.len());
                while cache.values().map(|item| item.bytes).sum::<usize>() + bytes > 8 * 1024 * 1024
                {
                    let Some(oldest) = cache
                        .iter()
                        .min_by_key(|(_, item)| item.expires_at)
                        .map(|(key, _)| key.clone())
                    else {
                        break;
                    };
                    cache.remove(&oldest);
                }
                cache.insert(
                    id.clone(),
                    CrossSearchSnapshot {
                        key,
                        expires_at: Instant::now() + std::time::Duration::from_secs(300),
                        files: files.clone(),
                        facets: facets.clone(),
                        truncated,
                        match_count,
                        bytes,
                    },
                );
            }
            (files, facets, truncated, match_count, id)
        };
    let offset = query.offset.unwrap_or(0);
    let page = files
        .iter()
        .skip(offset)
        .take(20)
        .cloned()
        .collect::<Vec<_>>();
    let next = (offset + page.len() < files.len()).then_some(offset + page.len());
    Json(serde_json::json!({"searchId":search_id,"total":files.len(),"files":page,"truncated":truncated,"matchCount":match_count,"nextOffset":next,"facets":facets.as_ref()})).into_response()
}
