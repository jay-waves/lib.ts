use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const LIMIT: usize = 100;

fn valid_timestamp(value: &str) -> bool {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).is_ok()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    path: String,
    last_visited_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct FileState {
    files: Vec<Record>,
}

pub struct FileHistory {
    directory: PathBuf,
    entries: Mutex<HashMap<String, FileState>>,
}

fn timestamp() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as i128;
    time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .ok()
        .and_then(|date| {
            date.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_default()
}

impl FileHistory {
    pub fn new(data_directory: PathBuf) -> Self {
        Self {
            directory: data_directory.join("file-history"),
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn ensure<'a>(
        &self,
        entries: &'a mut HashMap<String, FileState>,
        repo: &str,
    ) -> Result<&'a mut FileState, String> {
        if !entries.contains_key(repo) {
            if entries.len() >= 4 {
                if let Some(oldest) = entries.keys().next().cloned() {
                    entries.remove(&oldest);
                }
            }
            let path = self.directory.join(format!("{repo}.json"));
            let state = match fs::read(path) {
                Ok(bytes) => decode_state(&bytes)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => FileState::default(),
                Err(error) => return Err(error.to_string()),
            };
            entries.insert(repo.to_owned(), state);
        }
        entries
            .get_mut(repo)
            .ok_or_else(|| "File history unavailable".into())
    }

    fn persist(&self, repo: &str, state: &FileState) -> Result<(), String> {
        fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        let path = self.directory.join(format!("{repo}.json"));
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        fs::rename(temporary, path).map_err(|error| error.to_string())
    }

    pub fn recent(&self, repo: &str) -> Result<Value, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "File history lock poisoned")?;
        let state = self.ensure(&mut entries, repo)?;
        let records = state
            .files
            .iter()
            .map(|record| (record.path.clone(), record.last_visited_at.clone()))
            .collect::<Vec<_>>();
        Ok(
            serde_json::json!({"recent":records.iter().map(|(path,_)|path).collect::<Vec<_>>(),"visitedAt":records.into_iter().collect::<HashMap<_,_>>()}),
        )
    }

    pub fn visit(&self, repo: &str, path: &str) -> Result<(), String> {
        if !valid_path(path) {
            return Err("A repository-relative file path is required.".into());
        }
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "File history lock poisoned")?;
        let state = self.ensure(&mut entries, repo)?;
        state.files.retain(|record| record.path != path);
        state.files.insert(
            0,
            Record {
                path: path.into(),
                last_visited_at: timestamp(),
            },
        );
        state.files.truncate(LIMIT);
        self.persist(repo, state)
    }

    pub fn clear_recent(&self, repo: &str) -> Result<Value, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "File history lock poisoned")?;
        let state = self.ensure(&mut entries, repo)?;
        state.files.clear();
        self.persist(repo, state)?;
        Ok(serde_json::json!({"recent":[],"visitedAt":{}}))
    }
}

fn decode_state(bytes: &[u8]) -> Result<FileState, String> {
    let mut state: FileState = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if state
        .files
        .iter()
        .any(|record| !valid_path(&record.path) || !valid_timestamp(&record.last_visited_at))
    {
        return Err("Invalid file history record".into());
    }
    state.files.truncate(LIMIT);
    Ok(state)
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\\', ':', '\0', '\r', '\n'])
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_requires_paths_and_visit_times() {
        let state = decode_state(
            br#"{"files":[{"path":"notes/a.md","lastVisitedAt":"2026-10-19T00:00:00Z"}]}"#,
        )
        .unwrap();
        assert_eq!(state.files[0].path, "notes/a.md");
        for bytes in [
            br#"{"files":[{"path":"../outside","lastVisitedAt":"2026-10-19T00:00:00Z"}]}"#
                .as_slice(),
            br#"{"files":[{"path":"a.md","lastVisitedAt":"invalid"}]}"#.as_slice(),
            br#"{"files":[{"path":"a.md"}]}"#.as_slice(),
        ] {
            assert!(decode_state(bytes).is_err());
        }
    }

    #[test]
    fn visits_persist_only_file_history_and_clear_independently_per_repository() {
        let directory = tempfile::tempdir().unwrap();
        let history = FileHistory::new(directory.path().into());
        history.visit("repo", "a.md").unwrap();
        history.visit("repo", "b.md").unwrap();
        history.visit("repo", "a.md").unwrap();
        history.visit("other", "c.md").unwrap();
        assert_eq!(
            history.recent("repo").unwrap()["recent"],
            serde_json::json!(["a.md", "b.md"])
        );
        let saved = fs::read_to_string(directory.path().join("file-history/repo.json")).unwrap();
        assert!(!saved.contains("position"));
        assert!(history.visit("repo", "../outside").is_err());
        history.clear_recent("repo").unwrap();
        let restored = FileHistory::new(directory.path().into());
        assert_eq!(
            restored.recent("repo").unwrap()["recent"],
            serde_json::json!([])
        );
        assert_eq!(
            restored.recent("other").unwrap()["recent"],
            serde_json::json!(["c.md"])
        );
    }
}
