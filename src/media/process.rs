//! Bounded subprocesses for optional media metadata and previews.
use std::{
    io,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

pub fn run(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    let mut child = command.stdin(Stdio::null()).stderr(Stdio::null()).spawn()?;
    let started = Instant::now();
    loop {
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Media processing timed out",
            ));
        }
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output(),
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_output_and_terminates_on_deadline() {
        let executable = std::env::current_exe().unwrap();
        let mut command = Command::new(&executable);
        command
            .args(["--list", "media::process::tests"])
            .stdout(Stdio::piped());
        let output = run(&mut command, Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("collects_output"));
        let mut command = Command::new(executable);
        command.arg("--list").stdout(Stdio::null());
        assert_eq!(
            run(&mut command, Duration::ZERO).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }
}
