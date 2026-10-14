use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    path: String,
    #[serde(default)]
    position: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_visited_at: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct FileState {
    #[serde(default)]
    files: Vec<Record>,
}

pub struct ReadingStore {
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

impl ReadingStore {
    pub fn new(data_directory: PathBuf) -> Self {
        Self {
            directory: data_directory.join("reading"),
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
            .ok_or_else(|| "Reading state unavailable".into())
    }

    fn persist(&self, repo: &str, state: &FileState) -> Result<(), String> {
        fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        let path = self.directory.join(format!("{repo}.json"));
        let temporary = path.with_extension("json.tmp");
        let bytes =
            serde_json::to_vec(&serde_json::json!({"files":state.files,"updatedAt":timestamp()}))
                .map_err(|error| error.to_string())?;
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        fs::rename(temporary, path).map_err(|error| error.to_string())
    }

    pub fn read(&self, repo: &str) -> Result<Value, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Reading store lock poisoned")?;
        let state = self.ensure(&mut entries, repo)?;
        let positions = state
            .files
            .iter()
            .filter(|record| !record.position.is_empty())
            .map(|record| (record.path.clone(), Value::Object(record.position.clone())))
            .collect::<Map<_, _>>();
        Ok(Value::Object(positions))
    }

    pub fn recent(&self, repo: &str) -> Result<Value, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Reading store lock poisoned")?;
        let state = self.ensure(&mut entries, repo)?;
        let records = state
            .files
            .iter()
            .filter_map(|record| {
                record
                    .last_visited_at
                    .as_ref()
                    .map(|date| (record.path.clone(), date.clone()))
            })
            .collect::<Vec<_>>();
        Ok(
            serde_json::json!({"recent":records.iter().map(|(path,_)|path).collect::<Vec<_>>(),"visitedAt":records.into_iter().collect::<HashMap<_,_>>()}),
        )
    }

    pub fn save_positions(&self, repo: &str, value: Value) -> Result<(), String> {
        let positions = value.as_object().ok_or("Invalid reading positions")?;
        if positions.iter().any(|(path, position)| {
            !valid_path(path) || !position.is_object() || position.to_string().len() > 65_536
        }) {
            return Err("Invalid reading position".into());
        }
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Reading store lock poisoned")?;
        let state = self.ensure(&mut entries, repo)?;
        for (path, position) in positions {
            let Some(object) = position.as_object() else {
                continue;
            };
            if let Some(record) = state.files.iter_mut().find(|record| record.path == *path) {
                record.position.extend(object.clone());
            } else if state.files.len() < LIMIT {
                state.files.push(Record {
                    path: path.clone(),
                    position: object.clone(),
                    last_visited_at: None,
                });
            }
        }
        self.persist(repo, state)
    }

    pub fn visit(&self, repo: &str, path: &str) -> Result<(), String> {
        if !valid_path(path) {
            return Err("A repository-relative file path is required.".into());
        }
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Reading store lock poisoned")?;
        let state = self.ensure(&mut entries, repo)?;
        let record = state
            .files
            .iter()
            .position(|item| item.path == path)
            .map(|index| state.files.remove(index));
        let mut record = record.unwrap_or(Record {
            path: path.into(),
            position: Map::new(),
            last_visited_at: None,
        });
        record.last_visited_at = Some(timestamp());
        state.files.insert(0, record);
        state.files.truncate(LIMIT);
        self.persist(repo, state)
    }

    pub fn clear_recent(&self, repo: &str) -> Result<Value, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Reading store lock poisoned")?;
        let state = self.ensure(&mut entries, repo)?;
        state.files.retain_mut(|record| {
            record.last_visited_at = None;
            !record.position.is_empty()
        });
        self.persist(repo, state)?;
        let records = state
            .files
            .iter()
            .filter_map(|record| {
                record
                    .last_visited_at
                    .as_ref()
                    .map(|date| (record.path.clone(), date.clone()))
            })
            .collect::<Vec<_>>();
        Ok(
            serde_json::json!({"recent":records.iter().map(|(path,_)|path).collect::<Vec<_>>(),"visitedAt":records.into_iter().collect::<HashMap<_,_>>()}),
        )
    }
}

fn decode_state(bytes: &[u8]) -> Result<FileState, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if value.get("files").and_then(Value::as_array).is_some() {
        let mut state: FileState =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        if state.files.iter().any(|record| {
            !valid_path(&record.path)
                || serde_json::to_string(&record.position)
                    .map(|value| value.len() > 65_536)
                    .unwrap_or(true)
        }) {
            return Err("Invalid reading position".into());
        }
        for record in &mut state.files {
            if record
                .last_visited_at
                .as_deref()
                .is_some_and(|value| !valid_timestamp(value))
            {
                record.last_visited_at = None;
            }
        }
        state.files.truncate(LIMIT);
        return Ok(state);
    }
    let positions = value.get("positions").and_then(Value::as_object);
    let recent = value.get("recent").and_then(Value::as_array);
    let visited = value.get("recentVisitedAt").and_then(Value::as_object);
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(recent) = recent {
        for path in recent.iter().filter_map(Value::as_str) {
            if !valid_path(path) {
                return Err("A repository-relative file path is required.".into());
            }
            if seen.contains(path) {
                continue;
            }
            let last_visited_at = visited
                .and_then(|values| values.get(path))
                .and_then(Value::as_str)
                .filter(|value| valid_timestamp(value))
                .map(str::to_owned);
            if last_visited_at.is_none() {
                continue;
            }
            seen.insert(path.to_owned());
            let position = positions
                .and_then(|values| values.get(path))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            files.push(Record {
                path: path.to_owned(),
                position,
                last_visited_at,
            });
        }
    }
    if let Some(positions) = positions {
        for (path, position) in positions {
            if !valid_path(path) {
                return Err("A repository-relative file path is required.".into());
            }
            if !seen.insert(path.clone()) {
                continue;
            }
            let position = position
                .as_object()
                .cloned()
                .ok_or("Invalid reading position")?;
            if serde_json::to_string(&position)
                .map(|value| value.len() > 65_536)
                .unwrap_or(true)
            {
                return Err("Invalid reading position".into());
            }
            files.push(Record {
                path: path.clone(),
                position,
                last_visited_at: None,
            });
        }
    }
    files.truncate(LIMIT);
    Ok(FileState { files })
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\\', ':', '\0', '\r', '\n'])
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
