use std::{io, path::Path, process::Stdio};

pub(super) fn open(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = tokio::process::Command::new("open");
    #[cfg(not(target_os = "macos"))]
    let mut command = tokio::process::Command::new("xdg-open");
    let mut child = command
        .arg(dunce::simplified(path))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) if status.success() => {}
            result => tracing::warn!(?result, "System opener failed"),
        }
    });
    Ok(())
}
