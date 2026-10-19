#![allow(dead_code)]

#[path = "../src/markdown/mod.rs"]
mod markdown;
#[path = "../src/pdf/mod.rs"]
mod pdf;
#[path = "../src/resources.rs"]
mod resources;
#[path = "../src/typst/mod.rs"]
mod typst;

use comrak::{Arena, Options, parse_document};
use hayro_svg::{
    RenderCache, SvgRenderSettings, convert, hayro_interpret::InterpreterSettings,
    hayro_syntax::Pdf,
};
use serde::Serialize;
use std::{
    fs,
    hint::black_box,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Serialize)]
struct Report {
    schema_version: u32,
    implementation: &'static str,
    rustc_version: String,
    revision: Option<String>,
    os: &'static str,
    arch: &'static str,
    iterations: usize,
    fixture_bytes: FixtureSizes,
    rss_before_kib: Option<usize>,
    rss_after_kib: Option<usize>,
    peak_rss_before_kib: Option<usize>,
    peak_rss_after_kib: Option<usize>,
    results: Vec<Measurement>,
}

#[derive(Serialize)]
struct FixtureSizes {
    markdown: usize,
    typst: usize,
    pdf: usize,
    pdf_pages: usize,
}

#[derive(Serialize)]
struct Measurement {
    stage: &'static str,
    input_bytes: usize,
    iterations: usize,
    p50_ms: f64,
    p95_ms: f64,
    min_ms: f64,
    output_size: usize,
    output_unit: &'static str,
}

fn measure(
    stage: &'static str,
    input_bytes: usize,
    iterations: usize,
    output_unit: &'static str,
    mut operation: impl FnMut() -> usize,
) -> Measurement {
    let mut samples = Vec::with_capacity(iterations);
    let mut output_size = 0;
    for _ in 0..iterations {
        let start = Instant::now();
        output_size = black_box(operation());
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    let percentile = |percent: f64| {
        let index = ((samples.len().saturating_sub(1) as f64) * percent).ceil() as usize;
        samples[index]
    };
    Measurement {
        stage,
        input_bytes,
        iterations,
        p50_ms: percentile(0.50),
        p95_ms: percentile(0.95),
        min_ms: samples[0],
        output_size,
        output_unit,
    }
}

fn fixture_pdf(page_count: usize) -> Vec<u8> {
    let mut objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        format!(
            "<< /Type /Pages /Kids [{}] /Count {page_count} >>",
            (0..page_count)
                .map(|index| format!("{} 0 R", 3 + index * 2))
                .collect::<Vec<_>>()
                .join(" ")
        )
        .into_bytes(),
    ];
    for index in 0..page_count {
        let page_id = 3 + index * 2;
        let content_id = page_id + 1;
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents {content_id} 0 R >>"
            )
            .into_bytes(),
        );
        let mut content = String::from("q\n");
        for line in 0..80 {
            let y = 20 + line * 9;
            content.push_str(&format!("0.2 0.4 0.8 rg 40 {y} 480 1 re f\n"));
        }
        content.push_str("Q\n");
        objects.push(
            format!(
                "<< /Length {} >>\nstream\n{}endstream",
                content.len(),
                content
            )
            .into_bytes(),
        );
    }

    let mut bytes = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        bytes.extend_from_slice(object);
        bytes.extend_from_slice(b"\nendobj\n");
    }
    let xref_offset = bytes.len();
    bytes.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    bytes.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    bytes
}

fn process_memory_kib(key: &str) -> Option<usize> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name == key)
            .then(|| value.split_whitespace().next()?.parse::<usize>().ok())
            .flatten()
    })
}

fn command_line(program: &str, arguments: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(arguments)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn markdown_node_count(root: &comrak::nodes::AstNode<'_>) -> usize {
    let mut pending = vec![root];
    let mut count = 0;
    while let Some(node) = pending.pop() {
        count += 1;
        let mut child = node.first_child();
        while let Some(current) = child {
            pending.push(current);
            child = current.next_sibling();
        }
    }
    count
}

#[test]
#[ignore = "native edit/switch/cleanup benchmark; run explicitly with --ignored --nocapture"]
fn report_native_resource_lifecycle() {
    let temporary = tempfile::tempdir().unwrap();
    let compiler = typst::NativeTypstCompiler::new(temporary.path().to_owned());
    let renderer = pdf::NativePdfRenderer::default();
    let typst_paths = (0..8)
        .map(|index| temporary.path().join(format!("note-{index}.typ")))
        .collect::<Vec<_>>();
    let pdf_paths = (0..8)
        .map(|index| temporary.path().join(format!("book-{index}.pdf")))
        .collect::<Vec<_>>();
    compiler.set_active_paths(typst_paths.clone());
    renderer.set_active_paths(pdf_paths.clone());
    let rss_before = process_memory_kib("VmRSS");
    let started = Instant::now();
    let mut samples = Vec::new();
    for round in 0..128 {
        let index = round % 8;
        let source = format!(
            "#set page(width: 300pt, height: 300pt)\n= Document {index}\n中文 notes $x^2$ — revision {round}"
        );
        fs::write(&typst_paths[index], &source).unwrap();
        let request = || typst::CompileRequest {
            path: typst_paths[index].to_string_lossy().into_owned(),
            source: source.clone(),
            theme: Some(if round / 8 % 2 == 0 { "light" } else { "dark" }.into()),
        };
        let compiled = compiler.compile(request()).unwrap();
        assert_eq!(compiled.id, compiler.compile(request()).unwrap().id);
        assert!(!compiler.page(&compiled.id, 1).unwrap().svg.is_empty());
        let mut bytes = fixture_pdf(3);
        bytes.extend_from_slice(format!("\n% revision {round}\n").as_bytes());
        fs::write(&pdf_paths[index], bytes).unwrap();
        let revision = pdf::revision(&pdf_paths[index]).unwrap();
        renderer.document(&pdf_paths[index], &revision).unwrap();
        assert!(
            !renderer
                .page_svg(&pdf_paths[index], &revision, round % 3 + 1)
                .unwrap()
                .is_empty()
        );
        let typst = compiler.cache_usage();
        let pdf = renderer.cache_usage();
        assert!(
            typst.0 <= 32
                && typst.1 <= 16 * 1024 * 1024
                && typst.2 <= 64
                && typst.3 <= 16 * 1024 * 1024
        );
        assert!(
            pdf.0 <= 16 && pdf.1 <= 128 * 1024 * 1024 && pdf.2 <= 64 && pdf.3 <= 8 * 1024 * 1024
        );
        if round % 16 == 15 {
            samples.push(serde_json::json!({"round":round + 1,"rss_kib":process_memory_kib("VmRSS"),"typst":typst,"pdf":pdf}));
        }
    }
    compiler.clear();
    renderer.clear();
    comemo::evict(0);
    assert_eq!(compiler.cache_usage(), (0, 0, 0, 0));
    assert_eq!(renderer.cache_usage(), (0, 0, 0, 0));
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
        "scenario":"128 edits and page renders across 8 leased Typst/PDF documents",
        "usage_fields":["documents","source_bytes","pages","encoded_bytes"],
        "elapsed_ms":started.elapsed().as_secs_f64() * 1000.0,
        "rss_before_kib":rss_before,"samples":samples,"rss_after_clear_kib":process_memory_kib("VmRSS"),
        "typst_after_clear":compiler.cache_usage(),"pdf_after_clear":renderer.cache_usage()
    })).unwrap());
}

#[test]
#[ignore = "performance benchmark; run with cargo test --test rust_backend_perf -- --ignored --nocapture"]
fn report_native_backend_parse_compile_performance() {
    let iterations = std::env::var("RUST_BACKEND_PERF_ITERATIONS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(25);
    let rss_before = process_memory_kib("VmRSS");
    let peak_before = process_memory_kib("VmHWM");
    let markdown_source = fs::read_to_string("tests/fixtures/backend-perf.md").unwrap();
    let typst_source = fs::read_to_string("tests/fixtures/backend-perf.typ").unwrap();
    let markdown_bytes = markdown_source.len();
    let typst_bytes = typst_source.len();
    let pdf_bytes = fixture_pdf(12);
    let pdf_size = pdf_bytes.len();
    let temporary = tempfile::tempdir().unwrap();
    let pdf_path = temporary.path().join("backend-perf.pdf");
    fs::write(&pdf_path, &pdf_bytes).unwrap();

    let mut results = Vec::new();
    results.push(measure(
        "pdf_parse",
        pdf_size,
        iterations,
        "objects",
        || Pdf::new(black_box(pdf_bytes.clone())).unwrap().len(),
    ));
    let parsed_pdf = Pdf::new(pdf_bytes.clone()).unwrap();
    let page = &parsed_pdf.pages()[0];
    results.push(measure(
        "pdf_render_page_svg",
        pdf_size,
        iterations,
        "bytes",
        || {
            let cache = RenderCache::new();
            convert(
                page,
                &cache,
                &InterpreterSettings::default(),
                &SvgRenderSettings::default(),
            )
            .len()
        },
    ));
    results.push(measure(
        "pdf_document_parse_and_cache",
        pdf_size,
        iterations,
        "pages",
        || {
            let renderer = pdf::NativePdfRenderer::default();
            renderer
                .document(&pdf_path, &pdf::revision(&pdf_path).unwrap())
                .unwrap()
                .pages
                .len()
        },
    ));
    results.push(measure(
        "pdf_document_parse_and_render_page_svg",
        pdf_size,
        iterations,
        "bytes",
        || {
            let renderer = pdf::NativePdfRenderer::default();
            renderer
                .page_svg(&pdf_path, &pdf::revision(&pdf_path).unwrap(), 1)
                .unwrap()
                .len()
        },
    ));

    results.push(measure(
        "markdown_parse",
        markdown_bytes,
        iterations,
        "ast_nodes",
        || {
            let arena = Arena::new();
            let mut options = Options::default();
            options.extension.table = true;
            options.extension.strikethrough = true;
            options.extension.autolink = true;
            options.extension.tasklist = true;
            options.extension.footnotes = true;
            options.extension.math_dollars = true;
            options.extension.math_latex = true;
            let root = parse_document(&arena, &markdown_source, &options);
            markdown_node_count(root)
        },
    ));
    results.push(measure(
        "markdown_parse_and_render_html",
        markdown_bytes,
        iterations,
        "bytes",
        || {
            markdown::render_markdown(black_box(&markdown_source), true)
                .unwrap()
                .len()
        },
    ));

    results.push(measure(
        "typst_parse",
        typst_bytes,
        iterations,
        "source_bytes",
        || typst_syntax::parse(black_box(&typst_source)).len(),
    ));
    let root = temporary.path().join("typst");
    fs::create_dir_all(&root).unwrap();
    let typst_path = root.join("backend-perf.typ");
    fs::write(&typst_path, &typst_source).unwrap();
    let compiler = typst::NativeTypstCompiler::new(root.clone());
    let compile_request = || typst::CompileRequest {
        path: typst_path.to_string_lossy().into_owned(),
        source: typst_source.clone(),
        theme: None,
    };
    results.push(measure(
        "typst_compile_cold",
        typst_bytes,
        1,
        "pages",
        || {
            let response = compiler.compile(compile_request()).unwrap();
            response.pages.len()
        },
    ));
    let mut warm_version = 0;
    results.push(measure(
        "typst_compile_warm",
        typst_bytes,
        iterations,
        "pages",
        || {
            warm_version += 1;
            let mut request = compile_request();
            request
                .source
                .push_str(&format!("\n// warm revision {warm_version}\n"));
            compiler.compile(request).unwrap().pages.len()
        },
    ));

    compiler.compile(compile_request()).unwrap();
    results.push(measure(
        "typst_compile_cache_hit",
        typst_bytes,
        iterations,
        "pages",
        || compiler.compile(compile_request()).unwrap().pages.len(),
    ));

    let mut renderers = (0..iterations)
        .map(|_| {
            let renderer = typst::NativeTypstCompiler::new(root.clone());
            let id = renderer.compile(compile_request()).unwrap().id;
            (renderer, id)
        })
        .collect::<Vec<_>>()
        .into_iter();
    results.push(measure(
        "typst_render_page_svg_uncached",
        typst_bytes,
        iterations,
        "bytes",
        || {
            let (renderer, id) = renderers.next().expect("one renderer per sample");
            renderer.page_svg(&id, 1).unwrap().len()
        },
    ));
    // Include the backend's idle reclamation path in the post-work RSS sample.
    compiler.evict_idle(Duration::ZERO);
    comemo::evict(0);
    let report = Report {
        schema_version: 1,
        implementation: "rust-native",
        rustc_version: command_line("rustc", &["--version"]).unwrap_or_else(|| "unknown".into()),
        revision: command_line("git", &["rev-parse", "--short", "HEAD"]),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        iterations,
        fixture_bytes: FixtureSizes {
            markdown: markdown_bytes,
            typst: typst_bytes,
            pdf: pdf_size,
            pdf_pages: 12,
        },
        rss_before_kib: rss_before,
        rss_after_kib: process_memory_kib("VmRSS"),
        peak_rss_before_kib: peak_before,
        peak_rss_after_kib: process_memory_kib("VmHWM"),
        results,
    };
    let json = serde_json::to_string_pretty(&report).unwrap();
    println!("{json}");
    if let Some(path) = std::env::var_os("RUST_BACKEND_PERF_OUTPUT") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, json).unwrap();
    }
}
