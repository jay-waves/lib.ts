#[path = "../src/resources.rs"]
mod resources;
#[path = "../src/typst/mod.rs"]
mod typst;

use std::{fs, path::PathBuf};

fn compiler() -> (tempfile::TempDir, typst::NativeTypstCompiler, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("links.typ");
    fs::write(&path, "").unwrap();
    let compiler = typst::NativeTypstCompiler::new(root.path().to_path_buf());
    (root, compiler, path)
}

#[test]
fn unchanged_compilations_reuse_ids_but_sources_themes_and_dependencies_invalidate() {
    let (root, compiler, path) = compiler();
    let dependency = root.path().join("dependency.typ");
    fs::write(&dependency, "#let title = [Alpha]").unwrap();
    let request = || typst::CompileRequest {
        path: path.to_string_lossy().into_owned(),
        source: "#import \"dependency.typ\": title\n= #title".into(),
        theme: None,
    };
    let first = compiler.compile(request()).unwrap();
    let first_svg = compiler.page(&first.id, 1).unwrap().svg;
    assert_eq!(first.id, compiler.compile(request()).unwrap().id);
    let modified = fs::metadata(&dependency).unwrap().modified().unwrap();
    fs::write(&dependency, "#let title = [Bravo]").unwrap();
    fs::File::options()
        .write(true)
        .open(&dependency)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let changed = compiler.compile(request()).unwrap();
    assert_ne!(first.id, changed.id);
    assert_ne!(first_svg, compiler.page(&changed.id, 1).unwrap().svg);
    assert_eq!(changed.id, compiler.compile(request()).unwrap().id);
    let mut dark = request();
    dark.theme = Some("dark".into());
    assert_ne!(changed.id, compiler.compile(dark).unwrap().id);
    let mut edited = request();
    edited.source.push_str("\nEdited");
    assert_ne!(changed.id, compiler.compile(edited).unwrap().id);
    fs::remove_file(&dependency).unwrap();
    assert!(compiler.compile(request()).is_err());
    // Published IDs remain immutable snapshots while the source changes.
    assert!(compiler.page(&changed.id, 1).is_ok());
}

#[test]
fn image_dependencies_invalidate_and_cancelled_compiles_are_not_cached() {
    let (root, compiler, path) = compiler();
    let image = root.path().join("image.svg");
    fs::write(&image, "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"><rect width=\"20\" height=\"20\" fill=\"red\"/></svg>").unwrap();
    let request = || typst::CompileRequest {
        path: path.to_string_lossy().into_owned(),
        source: "#image(\"image.svg\")".into(),
        theme: None,
    };
    let first = compiler.compile(request()).unwrap();
    fs::write(&image, "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"><rect width=\"20\" height=\"20\" fill=\"blue\"/></svg>").unwrap();
    let changed = compiler.compile(request()).unwrap();
    assert_ne!(first.id, changed.id);
    compiler.clear();
    assert!(compiler.page(&changed.id, 1).is_err());
    let cancellation = resources::Cancellation::default();
    cancellation.cancel();
    assert!(
        compiler
            .compile_cancellable(request(), &cancellation)
            .is_err()
    );
    let valid = compiler.compile(request()).unwrap();
    assert_eq!(valid.id, compiler.compile(request()).unwrap().id);
}

#[test]
fn concurrent_identical_compilations_reuse_one_layout() {
    let (_root, compiler, path) = compiler();
    let barrier = std::sync::Barrier::new(4);
    let ids = std::thread::scope(|scope| {
        let handles = (0..4)
            .map(|_| {
                let compiler = &compiler;
                let path = &path;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    compiler
                        .compile(typst::CompileRequest {
                            path: path.to_string_lossy().into_owned(),
                            source: "Shared layout".into(),
                            theme: None,
                        })
                        .unwrap()
                        .id
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(ids.iter().all(|id| id == &ids[0]));
}

#[test]
fn native_page_links_include_internal_targets_and_safe_external_urls() {
    let (_root, compiler, path) = compiler();
    let response = compiler
        .compile(typst::CompileRequest {
            path: path.to_string_lossy().into_owned(),
            source: "#set page(width: 300pt, height: 300pt)\n#link(<target>)[Go to target]\n\n#link(\"https://example.com/a?b=1&c=2\")[External]\n#pagebreak()\n= Target <target>".into(),
            theme: None,
        })
        .unwrap();
    let page = compiler.page(&response.id, 1).unwrap();

    assert!(!page.svg.is_empty());
    assert!(
        page.links
            .iter()
            .any(|link| link.page == Some(2) && link.x.is_some() && link.y.is_some())
    );
    assert!(
        page.links
            .iter()
            .any(|link| { link.href.as_deref() == Some("https://example.com/a?b=1&c=2") })
    );
    assert!(page.links.iter().all(|link| link.left >= 0.0
        && link.top >= 0.0
        && link.left + link.width <= 100.0 + 1e-6
        && link.top + link.height <= 100.0 + 1e-6));
}

#[test]
fn native_outline_includes_source_headings() {
    let (_root, compiler, path) = compiler();
    let response = compiler
        .compile(typst::CompileRequest {
            path: path.to_string_lossy().into_owned(),
            source: "= First\n\n== Second *heading*".into(),
            theme: None,
        })
        .unwrap();

    assert_eq!(response.outline.len(), 2, "{:?}", response.outline);
    assert_eq!(response.outline[0].name, "First");
    assert_eq!(response.outline[0].line, 1);
    assert_eq!(response.outline[1].name, "Second heading");
    assert_eq!(response.outline[1].level, 2);
}

#[test]
fn bundled_source_han_sc_aliases_are_available_without_system_font_scanning() {
    let (_root, compiler, path) = compiler();
    let response = compiler
        .compile(typst::CompileRequest {
            path: path.to_string_lossy().into_owned(),
            source: "#set text(font: \"Source Han Serif SC\")\n中文".into(),
            theme: None,
        })
        .unwrap();

    assert!(
        !response
            .diagnostics
            .iter()
            .any(|item| item.message.to_lowercase().contains("unknown font family")),
        "unexpected font diagnostics: {:?}",
        response.diagnostics
    );
}

#[test]
fn document_leases_protect_active_typst_pages_from_lru_eviction() {
    let (root, compiler, _) = compiler();
    let first_path = root.path().join("active.typ");
    fs::write(&first_path, "").unwrap();
    let first = compiler
        .compile(typst::CompileRequest {
            path: first_path.to_string_lossy().into_owned(),
            source: "Active page".into(),
            theme: None,
        })
        .unwrap();
    compiler.set_active_paths([first_path]);

    for index in 0..6 {
        let path = root.path().join(format!("idle-{index}.typ"));
        fs::write(&path, "").unwrap();
        compiler
            .compile(typst::CompileRequest {
                path: path.to_string_lossy().into_owned(),
                source: format!("Idle page {index}"),
                theme: None,
            })
            .unwrap();
    }
    assert!(!compiler.page(&first.id, 1).unwrap().svg.is_empty());

    compiler.set_active_paths(std::iter::empty());
    for index in 0..4 {
        let path = root.path().join(format!("last-{index}.typ"));
        fs::write(&path, "").unwrap();
        compiler
            .compile(typst::CompileRequest {
                path: path.to_string_lossy().into_owned(),
                source: format!("Last page {index}"),
                theme: None,
            })
            .unwrap();
    }
    assert!(compiler.page(&first.id, 1).is_err());
}

#[test]
fn idle_eviction_releases_unleased_pages_and_preserves_active_documents() {
    let (root, compiler, _) = compiler();
    let active_path = root.path().join("active-idle.typ");
    let inactive_path = root.path().join("inactive-idle.typ");
    fs::write(&active_path, "").unwrap();
    fs::write(&inactive_path, "").unwrap();
    let active = compiler
        .compile(typst::CompileRequest {
            path: active_path.to_string_lossy().into_owned(),
            source: "Active page".into(),
            theme: None,
        })
        .unwrap();
    let inactive = compiler
        .compile(typst::CompileRequest {
            path: inactive_path.to_string_lossy().into_owned(),
            source: "Inactive page".into(),
            theme: None,
        })
        .unwrap();
    compiler.set_active_paths([active_path.clone()]);

    assert!(compiler.evict_idle(std::time::Duration::ZERO));
    assert!(!compiler.page(&inactive.id, 1).is_ok());
    assert!(compiler.page(&active.id, 1).is_ok());

    compiler.set_active_paths(std::iter::empty());
    assert!(compiler.evict_idle(std::time::Duration::ZERO));
    assert!(compiler.page(&active.id, 1).is_err());
    let after_idle = compiler
        .compile(typst::CompileRequest {
            path: active_path.to_string_lossy().into_owned(),
            source: "Compiled after idle font release".into(),
            theme: None,
        })
        .unwrap();
    assert!(!compiler.page(&after_idle.id, 1).unwrap().svg.is_empty());
}

#[test]
fn all_active_documents_survive_capacity_and_old_revisions_are_reclaimed() {
    let (root, compiler, _) = compiler();
    let paths = (0..5)
        .map(|index| root.path().join(format!("pinned-{index}.typ")))
        .collect::<Vec<_>>();
    for path in &paths {
        fs::write(path, "").unwrap();
    }
    compiler.set_active_paths(paths.clone());
    assert!(compiler.has_active_documents());
    let responses = paths
        .iter()
        .map(|path| {
            compiler
                .compile(typst::CompileRequest {
                    path: path.to_string_lossy().into_owned(),
                    source: "Pinned".into(),
                    theme: None,
                })
                .unwrap()
        })
        .collect::<Vec<_>>();
    for response in &responses {
        assert!(compiler.page(&response.id, 1).is_ok());
    }
    for index in 0..3 {
        compiler
            .compile(typst::CompileRequest {
                path: paths[0].to_string_lossy().into_owned(),
                source: format!("Revision {index}"),
                theme: None,
            })
            .unwrap();
    }
    assert!(compiler.page(&responses[0].id, 1).is_err());
    for response in &responses[1..] {
        assert!(compiler.page(&response.id, 1).is_ok());
    }
}
