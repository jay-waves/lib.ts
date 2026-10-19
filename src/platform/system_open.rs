//! Desktop opening is performed on the service host. Keep this boundary separate
//! from media handling so another launch target can be added without changing previews.
use std::{io, path::Path};

#[cfg(not(target_os = "windows"))]
mod desktop;
#[cfg(target_os = "windows")]
mod windows;

/// Dispatch an explicit user request on the service host. Foreground activation
/// is best effort: desktop focus policy still applies.
pub async fn open(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || windows::open(&path))
            .await
            .map_err(io::Error::other)?
    }
    #[cfg(not(target_os = "windows"))]
    desktop::open(path)
}
