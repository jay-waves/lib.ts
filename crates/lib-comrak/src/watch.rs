use crate::{cli::Args, document, engine::Engine};
use notify::{EventKind, RecursiveMode, Watcher};
use std::{
    cell::RefCell,
    collections::HashSet,
    path::{Path, PathBuf},
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};

#[derive(Debug)]
enum Input {
    Command(serde_json::Value),
    Closed,
}

fn emit(value: serde_json::Value) {
    println!("{value}");
}

// Watch parent directories, not file handles: editors commonly save by rename.
fn watch_directory(path: &Path) -> Option<PathBuf> {
    let mut parent = path.parent()?;
    while !parent.is_dir() {
        parent = parent.parent()?;
    }
    dunce::canonicalize(parent).ok()
}

fn affects_dependencies(paths: &[PathBuf], dependencies: &HashSet<PathBuf>) -> bool {
    paths.is_empty()
        || paths.iter().any(|path| {
            dependencies
                .iter()
                .any(|dep| dep == path || dep.starts_with(path))
        })
}

pub fn run(args: &Args) -> Result<(), String> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("comrak-watch".into())
            .stack_size(16 * 1024 * 1024)
            .spawn_scoped(scope, || run_inner(args))
            .map_err(|e| e.to_string())?
            .join()
            .map_err(|_| "watch compiler thread failed".to_string())?
    })
}

fn run_inner(args: &Args) -> Result<(), String> {
    let mut args = args.clone();
    let root = dunce::canonicalize(args.root.as_deref().unwrap_or(Path::new(".")))
        .map_err(|e| e.to_string())?;
    let input_path = dunce::canonicalize(&args.input).map_err(|e| e.to_string())?;
    let relative = input_path
        .strip_prefix(&root)
        .map_err(|_| "input must be inside --root")?;
    let cache = crate::assets::shared_base()?
        .parent()
        .ok_or("invalid cache directory")?
        .join("watch")
        .join(format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        ));
    args.output = crate::site::page_path(&cache.join(relative));
    args.site_root = Some(cache);
    args.standalone = false;
    let args = &args;
    let input = std::path::absolute(&args.input).map_err(|e| e.to_string())?;
    let input = dunce::canonicalize(&input).unwrap_or(input);
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })
    .map_err(|e| format!("cannot start watcher: {e}"))?;
    let mut directories = HashSet::new();
    let mut dependencies = HashSet::from([input.clone()]);
    update_watches(&mut watcher, &mut directories, &dependencies)?;
    let preview = crate::preview::Preview::start(args)?;
    let (input_tx, input_rx) = mpsc::channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    let parsed = serde_json::from_str(&line).unwrap_or(serde_json::Value::Null);
                    if input_tx.send(Input::Command(parsed)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = input_tx.send(Input::Closed);
    });
    let mut engine = Engine::default();
    let mut compilations = 0usize;
    let mut preview_emitted = false;
    loop {
        if handle_inputs(&input_rx, &preview) {
            emit(serde_json::json!({"type":"stopped","reason":"stdin_closed"}));
            return Ok(());
        }
        let found = Rc::new(RefCell::new(HashSet::new()));
        let start = Instant::now();
        let success = match document::compile_document(args, &engine, found.clone()) {
            Ok(warnings) => {
                preview.publish(std::fs::read_to_string(&args.output).map_err(|e| e.to_string())?);
                let diagnostics: Vec<_> = warnings
                    .into_iter()
                    .map(|warning| serde_json::json!({"severity":"warning","line":warning.line,"column":warning.column,"message":warning.message}))
                    .collect();
                emit(
                    serde_json::json!({"type":"compile","status":if diagnostics.is_empty() {"success"} else {"warning"},"input":input.display().to_string(),"duration_ms":start.elapsed().as_millis(),"diagnostics":diagnostics}),
                );
                if !preview_emitted {
                    emit(serde_json::json!({"type":"preview","url":preview.url()}));
                    preview_emitted = true;
                }
                true
            }
            Err(errors) => {
                let diagnostics: Vec<_> = errors.into_iter().map(|error| serde_json::json!({"severity":"error","line":error.line,"column":error.column,"message":error.message})).collect();
                emit(
                    serde_json::json!({"type":"compile","status":"error","input":input.display().to_string(),"duration_ms":start.elapsed().as_millis(),"diagnostics":diagnostics}),
                );
                false
            }
        };
        compilations += 1;
        if compilations >= 128 {
            // QuickJS retains evaluated ES modules; periodically release them in
            // a long-running watch while keeping the bounded shared cache.
            engine = Engine::default();
            compilations = 0;
        }
        // Keep existing dependencies after failure so fixing any source can recover.
        let found = found.borrow();
        if success {
            dependencies = HashSet::from([input.clone()]);
        }
        dependencies.extend(found.iter().cloned());
        // A dependency may have changed between reading it and installing its
        // first directory watch. Recompile once with the new watches in place.
        if update_watches(&mut watcher, &mut directories, &dependencies)? {
            continue;
        }
        loop {
            if handle_inputs(&input_rx, &preview) {
                emit(serde_json::json!({"type":"stopped","reason":"stdin_closed"}));
                return Ok(());
            }
            let event = match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(event) => event.map_err(|e| format!("watch error: {e}"))?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(e) => return Err(e.to_string()),
            };
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
            ) {
                continue;
            }
            if affects_dependencies(&event.paths, &dependencies) {
                // Coalesce editor save bursts. A bounded window prevents starvation.
                let until = Instant::now() + Duration::from_millis(200);
                while Instant::now() < until {
                    if handle_inputs(&input_rx, &preview) {
                        emit(serde_json::json!({"type":"stopped","reason":"stdin_closed"}));
                        return Ok(());
                    }
                    if rx.recv_timeout(Duration::from_millis(50)).is_err() {
                        break;
                    }
                }
                break;
            }
        }
    }
}

fn handle_inputs(input_rx: &mpsc::Receiver<Input>, preview: &crate::preview::Preview) -> bool {
    loop {
        match input_rx.try_recv() {
            Ok(Input::Closed) | Err(mpsc::TryRecvError::Disconnected) => return true,
            Ok(Input::Command(value)) => match value.get("action").and_then(|v| v.as_str()) {
                Some("quit") => return true,
                Some("navigate") => {
                    if let Some(line) = value
                        .get("line")
                        .and_then(|v| v.as_u64())
                        .filter(|line| *line > 0)
                    {
                        preview.navigate(line);
                    }
                }
                _ => emit(
                    serde_json::json!({"type":"protocol_error","message":"expected navigate with positive line or quit"}),
                ),
            },
            Err(mpsc::TryRecvError::Empty) => return false,
        }
    }
}

fn update_watches(
    watcher: &mut notify::RecommendedWatcher,
    directories: &mut HashSet<PathBuf>,
    dependencies: &HashSet<PathBuf>,
) -> Result<bool, String> {
    let mut added = false;
    let desired: HashSet<_> = dependencies
        .iter()
        .filter_map(|path| watch_directory(path))
        .collect();
    for stale in directories
        .difference(&desired)
        .cloned()
        .collect::<Vec<_>>()
    {
        let _ = watcher.unwatch(&stale);
        directories.remove(&stale);
    }
    for directory in desired {
        if directories.insert(directory.clone()) {
            watcher
                .watch(&directory, RecursiveMode::NonRecursive)
                .map_err(|e| format!("cannot watch {}: {e}", directory.display()))?;
            added = true;
        }
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relevant_files_and_missing_parent_directories_trigger_rebuild() {
        let dependencies = HashSet::from([
            PathBuf::from("/notes/a.md"),
            PathBuf::from("/notes/charts/a.js"),
        ]);
        assert!(affects_dependencies(
            &[PathBuf::from("/notes/a.md")],
            &dependencies
        ));
        assert!(affects_dependencies(
            &[PathBuf::from("/notes/charts")],
            &dependencies
        ));
        assert!(!affects_dependencies(
            &[PathBuf::from("/notes/a.html")],
            &dependencies
        ));
    }
}
