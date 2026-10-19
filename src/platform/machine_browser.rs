use axum::http::StatusCode;
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::client_path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryListing {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) parent: Option<String>,
    pub(crate) directories: Vec<DirectoryEntry>,
    pub(crate) hostname: String,
    pub(crate) root_path: String,
}

#[derive(Serialize)]
pub(crate) struct DirectoryEntry {
    pub(crate) name: String,
    pub(crate) path: String,
}

pub(crate) fn server_hostname() -> &'static str {
    static HOSTNAME: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        let name = std::env::var(if cfg!(windows) {
            "COMPUTERNAME"
        } else {
            "HOSTNAME"
        })
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| std::fs::read_to_string("/proc/sys/kernel/hostname").ok())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        })
        .unwrap_or_else(|| "Computer".into());
        name.trim().to_owned()
    });
    &HOSTNAME
}

pub(crate) fn machine_root_path() -> &'static str {
    if cfg!(windows) { "" } else { "/" }
}

pub(crate) fn browse_machine_root(
    data_directory: &Path,
) -> Result<DirectoryListing, (StatusCode, String)> {
    #[cfg(windows)]
    {
        let directories = (b'A'..=b'Z')
            .filter_map(|drive| {
                let path = PathBuf::from(format!("{}:/", drive as char));
                path.exists().then(|| DirectoryEntry {
                    name: format!("{}:", drive as char),
                    path: client_path(&path),
                })
            })
            .collect();
        let _ = data_directory;
        Ok(DirectoryListing {
            path: String::new(),
            name: server_hostname().into(),
            parent: None,
            directories,
            hostname: server_hostname().into(),
            root_path: String::new(),
        })
    }
    #[cfg(not(windows))]
    browse_directories(Some("/"), Path::new("/"), data_directory)
}

pub(crate) fn browse_directories(
    path: Option<&str>,
    initial_root: &Path,
    data_directory: &Path,
) -> Result<DirectoryListing, (StatusCode, String)> {
    let requested = path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| initial_root.to_path_buf());
    let directory = requested.canonicalize().map_err(|error| {
        let status = if error.kind() == std::io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        (status, error.to_string())
    })?;
    let private_directory = data_directory
        .canonicalize()
        .unwrap_or_else(|_| data_directory.to_path_buf());
    if !directory.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "Not a directory".into()));
    }
    if directory.starts_with(&private_directory) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Application data is private".into(),
        ));
    }
    let mut directories = Vec::new();
    for item in std::fs::read_dir(&directory)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?
    {
        let item = item.map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if item
            .file_type()
            .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?
            .is_dir()
        {
            let candidate = item.path();
            if candidate.starts_with(&private_directory) {
                continue;
            }
            directories.push(DirectoryEntry {
                name,
                path: client_path(&candidate),
            });
        }
    }
    directories.sort_by_key(|directory| directory.name.to_lowercase());
    let parent = directory.parent().filter(|parent| *parent != directory);
    Ok(DirectoryListing {
        path: client_path(&directory),
        name: directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| directory.as_os_str().to_string_lossy().into_owned()),
        parent: parent.map(client_path),
        directories,
        hostname: server_hostname().into(),
        root_path: machine_root_path().into(),
    })
}
