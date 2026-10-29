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
    let mut engine = Engine::default();
    let mut compilations = 0usize;
    loop {
        let found = Rc::new(RefCell::new(HashSet::new()));
        let start = Instant::now();
        let success = match document::compile_document(args, &engine, found.clone()) {
            Ok(()) => {
                eprintln!(
                    "compiled {} in {:.0?}; watching for changes",
                    args.output.display(),
                    start.elapsed()
                );
                true
            }
            Err(errors) => {
                for error in errors {
                    if args.short {
                        eprintln!(
                            "{}:{}:{}: error: {}",
                            args.input.display(),
                            error.line,
                            error.column,
                            error.message.replace(['\r', '\n'], " ")
                        );
                    } else {
                        eprintln!(
                            "error: {}\n  --> {}:{}:{}",
                            error.message,
                            args.input.display(),
                            error.line,
                            error.column
                        );
                    }
                }
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
            let event = rx
                .recv()
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("watch error: {e}"))?;
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
                    if rx.recv_timeout(Duration::from_millis(50)).is_err() {
                        break;
                    }
                }
                break;
            }
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
