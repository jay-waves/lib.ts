use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub path: String,
    pub updated_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub root: PathBuf,
    pub created_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
}

#[derive(Serialize, Deserialize)]
struct FileState {
    version: u8,
    repos: Vec<Repository>,
}

pub struct RepositoryStore {
    file: PathBuf,
    state: Mutex<FileState>,
}

fn now() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as i128;
    time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .ok()
        .and_then(|value| {
            value
                .format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into())
}

fn slug(root: &Path) -> String {
    root.file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "root".into())
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn same_bookmark_path(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn same_slug(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn root_exists(root: &Path) -> bool {
    match fs::metadata(root) {
        Ok(metadata) => metadata.is_dir(),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.kind() == std::io::ErrorKind::NotADirectory =>
        {
            false
        }
        Err(_) => true,
    }
}

impl RepositoryStore {
    pub fn open(data_directory: &Path, initial_root: Option<&Path>) -> Result<Self, String> {
        fs::create_dir_all(data_directory).map_err(|error| error.to_string())?;
        let file = data_directory.join("repos.json");
        let mut state = match fs::read(&file) {
            Ok(bytes) => serde_json::from_slice::<FileState>(&bytes)
                .map_err(|error| format!("Invalid data/repos.json: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => FileState {
                version: 1,
                repos: Vec::new(),
            },
            Err(error) => return Err(error.to_string()),
        };
        if state.version != 1
            || state.repos.iter().any(|repo| {
                !regex::Regex::new(r"^[a-zA-Z0-9-]+$")
                    .unwrap()
                    .is_match(&repo.id)
                    || repo.root.as_os_str().is_empty()
            })
        {
            return Err("Invalid or unsupported data/repos.json".into());
        }
        let mut ids = std::collections::HashSet::new();
        if state.repos.iter().any(|repo| !ids.insert(repo.id.clone())) {
            return Err("Invalid or unsupported data/repos.json".into());
        }
        state.repos.retain(|repo| root_exists(&repo.root));
        let mut slugs = std::collections::HashSet::new();
        for repo in &mut state.repos {
            repo.slug = slug(&repo.root);
            if matches!(repo.slug.to_ascii_lowercase().as_str(), "api" | "assets") {
                return Err(format!("Repository folder name is reserved: {}", repo.slug));
            }
            #[cfg(windows)]
            let unique = slugs.insert(repo.slug.to_ascii_lowercase());
            #[cfg(not(windows))]
            let unique = slugs.insert(repo.slug.clone());
            if !unique {
                return Err(format!(
                    "Repository folder name already registered: {}",
                    repo.slug
                ));
            }
        }
        if let Some(initial_root) = initial_root {
            let root = initial_root
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !state.repos.iter().any(|repo| same_path(&repo.root, &root)) {
                let id = new_id()?;
                let name = slug(&root);
                state.repos.push(Repository {
                    id,
                    slug: name.clone(),
                    name,
                    root,
                    created_at: now(),
                    last_used_at: None,
                    bookmarks: Vec::new(),
                });
            }
        }
        let store = Self {
            file,
            state: Mutex::new(state),
        };
        store.persist()?;
        Ok(store)
    }

    fn persist(&self) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Repository store lock poisoned")?;
        let temporary = self.file.with_file_name(format!("repos.{}.tmp", new_id()?));
        let bytes = serde_json::to_vec_pretty(&*state).map_err(|error| error.to_string())?;
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        fs::rename(temporary, &self.file).map_err(|error| error.to_string())
    }

    pub fn list(&self) -> Result<Vec<Repository>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Repository store lock poisoned")?;
        let mut repos = state.repos.clone();
        repos.sort_by(|a, b| {
            b.last_used_at
                .as_deref()
                .unwrap_or(&b.created_at)
                .cmp(a.last_used_at.as_deref().unwrap_or(&a.created_at))
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(repos)
    }

    pub fn prune_missing(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Repository store lock poisoned")?;
        let before = state.repos.len();
        state.repos.retain(|repo| root_exists(&repo.root));
        let changed = before != state.repos.len();
        drop(state);
        if changed {
            self.persist()?;
        }
        Ok(())
    }

    pub fn find(&self, value: &str) -> Result<Option<Repository>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Repository store lock poisoned")?;
        Ok(state
            .repos
            .iter()
            .find(|repo| repo.id == value || same_slug(&repo.slug, value))
            .cloned())
    }

    pub fn root_available(&self, id: &str) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .repos
                    .iter()
                    .find(|repo| repo.id == id || repo.slug == id)
                    .map(|repo| root_exists(&repo.root))
            })
            .unwrap_or(false)
    }

    pub fn add(&self, path: &str, name: Option<&str>) -> Result<Repository, String> {
        if path.trim().is_empty() {
            return Err("A directory path is required".into());
        }
        if name.is_some_and(|value| value.trim().is_empty()) {
            return Err("Invalid repo name".into());
        }
        let root = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !root.is_dir() {
            return Err("Repo root must be a directory".into());
        }
        let slug = slug(&root);
        if matches!(slug.to_ascii_lowercase().as_str(), "api" | "assets") {
            return Err(format!("Repository folder name is reserved: {slug}"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Repository store lock poisoned")?;
        if let Some(existing) = state.repos.iter().find(|repo| same_path(&repo.root, &root)) {
            return Ok(existing.clone());
        }
        if state
            .repos
            .iter()
            .any(|repo| repo.slug.eq_ignore_ascii_case(&slug))
        {
            return Err(format!("Repository folder name already registered: {slug}"));
        }
        let repo = Repository {
            id: new_id()?,
            slug: slug.clone(),
            name: name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&slug)
                .to_owned(),
            root,
            created_at: now(),
            last_used_at: None,
            bookmarks: Vec::new(),
        };
        state.repos.push(repo.clone());
        drop(state);
        self.persist()?;
        Ok(repo)
    }

    pub fn touch(&self, id: &str) -> Result<Option<Repository>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Repository store lock poisoned")?;
        let Some(repo) = state
            .repos
            .iter_mut()
            .find(|repo| repo.id == id || same_slug(&repo.slug, id))
        else {
            return Ok(None);
        };
        repo.last_used_at = Some(now());
        let output = repo.clone();
        drop(state);
        self.persist()?;
        Ok(Some(output))
    }

    pub fn set_bookmark(
        &self,
        id: &str,
        path: &str,
        bookmarked: bool,
    ) -> Result<Vec<Bookmark>, String> {
        if path.is_empty()
            || path.len() > 4096
            || path.contains(['\\', ':', '\0', '\r', '\n'])
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("A repository-relative file path is required.".into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Repository store lock poisoned")?;
        let repo = state
            .repos
            .iter_mut()
            .find(|repo| repo.id == id || same_slug(&repo.slug, id))
            .ok_or("Repo not found")?;
        repo.bookmarks
            .retain(|item| !same_bookmark_path(&item.path, path));
        if bookmarked {
            repo.bookmarks.push(Bookmark {
                path: path.into(),
                updated_at: now(),
            });
        }
        let result = repo.bookmarks.clone();
        drop(state);
        self.persist()?;
        Ok(result)
    }
}

fn new_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
