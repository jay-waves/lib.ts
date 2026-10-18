//! Desktop opening is performed on the service host. Keep this boundary separate
//! from media handling so another launch target can be added without changing previews.
use std::{io, path::Path, process::Stdio};

pub fn open(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    let mut command = tokio::process::Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = tokio::process::Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = tokio::process::Command::new("xdg-open");
    let mut child = command
        .arg(dunce::simplified(path))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    // A successful response acknowledges dispatch, not that the viewer displayed
    // the file. Reap the launcher even if it stays alive for the viewer's lifetime.
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) if status.success() => {}
            result => tracing::warn!(?result, "System opener failed"),
        }
    });
    Ok(())
}
