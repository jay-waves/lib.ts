//! Bounded subprocesses for optional media metadata and previews.
use std::{
    io::{self, Read},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

pub fn run(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_reader = std::thread::spawn(move || {
        const MAX_CAPTURE: usize = 16 * 1024;
        let mut captured = Vec::with_capacity(MAX_CAPTURE);
        let mut buffer = [0; 1024];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let remaining = MAX_CAPTURE - captured.len();
                    captured.extend_from_slice(&buffer[..count.min(remaining)]);
                }
            }
        }
        captured
    });
    let started = Instant::now();
    loop {
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_reader.join();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Media processing timed out",
            ));
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                let mut output = child.wait_with_output()?;
                output.stderr = stderr_reader.join().unwrap_or_default();
                return Ok(output);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stderr_reader.join();
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
