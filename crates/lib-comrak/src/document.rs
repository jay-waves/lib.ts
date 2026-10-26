use crate::{
    assets::{self, escape},
    cli::{Args, Images},
    engine::Engine,
    headings::HeadingIds,
};
use comrak::{
    Arena, Options, format_html_with_plugins, nodes::NodeValue, options::Plugins, parse_document,
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use url::Url;

#[derive(Debug)]
pub struct Diagnostic {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

pub struct Attachments {
    input: Url,
    root: PathBuf,
    mode: Images,
    standalone: bool,
}

impl Attachments {
    pub fn new(
        input: &Path,
        _output: &Path,
        root: PathBuf,
        mode: Images,
        standalone: bool,
    ) -> Result<Self, String> {
        Ok(Self {
            input: assets::file_url(input)?,
            root,
            mode,
            standalone,
        })
    }

    pub fn resolve(&self, original: &str, image: bool) -> Result<String, String> {
        if original.is_empty() || original.starts_with('#') {
            return Ok(original.to_owned());
        }
        let url = self
            .input
            .join(original)
            .map_err(|e| format!("invalid URL {original:?}: {e}"))?;
        if url.scheme() != "file" {
            if !matches!(url.scheme(), "http" | "https" | "mailto" | "tel" | "data") {
                return Err(format!("unsupported URL scheme in {original:?}"));
            }
            if image && !matches!(url.scheme(), "http" | "https" | "data") {
                return Err(format!("unsupported image URL {original:?}"));
            }
            if image && self.standalone && url.scheme() != "data" {
                return Err(format!(
                    "remote image {original:?} cannot be embedded offline; download it and use a local path"
                ));
            }
            return Ok(original.to_owned());
        }
        let path = url
            .to_file_path()
            .map_err(|_| format!("invalid local path {original:?}"))?;
        let path = match dunce::canonicalize(&path) {
            Ok(path) => path,
            // Links do not read their target; allow documents to reference files
            // that will be supplied later. Images still require an existing file.
            Err(error) if !image && error.kind() == std::io::ErrorKind::NotFound => {
                resolve_missing_link(&path)
                    .map_err(|e| format!("cannot resolve attachment {original:?}: {e}"))?
            }
            Err(error) => return Err(format!("cannot read attachment {original:?}: {error}")),
        };
        if !path.starts_with(&self.root) {
            return Err(format!(
                "attachment {original:?} is outside root {}; pass a wider --root",
                self.root.display()
            ));
        }
        if image && !path.is_file() {
            return Err(format!("image {original:?} is not a file"));
        }
        if image && self.mode == Images::Embed {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            if !mime.essence_str().starts_with("image/") {
                return Err(format!("attachment {original:?} is not a recognized image"));
            }
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            let mut result = assets::data_url(&bytes, mime.essence_str());
            if let Some(hash) = url.fragment() {
                result.push('#');
                result.push_str(hash);
            }
            return Ok(result);
        }
        let mut target = assets::file_url(&path)?;
        target.set_query(url.query());
        target.set_fragment(url.fragment());
        // The output HTML may live in a temporary compilation directory.
        // Keep every local attachment anchored to its source path instead of
        // making it relative to the generated document.
        Ok(target.to_string())
    }
}

// Resolve the nearest existing ancestor before restoring missing components.
// A dangling symlink must fail rather than become an unchecked lexical path.
fn resolve_missing_link(path: &Path) -> std::io::Result<PathBuf> {
    let mut ancestor = path;
    let mut missing = Vec::new();
    loop {
        match dunce::canonicalize(ancestor) {
            Ok(mut resolved) => {
                if !missing.is_empty() && !resolved.is_dir() {
                    return Err(std::io::Error::other("link parent is not a directory"));
                }
                for component in missing.into_iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match fs::symlink_metadata(ancestor) {
                    Ok(_) => return Err(error),
                    Err(metadata_error)
                        if metadata_error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(metadata_error) => return Err(metadata_error),
                }
                let Some(name) = ancestor.file_name() else {
                    return Err(error);
                };
                missing.push(name.to_owned());
                ancestor = ancestor.parent().ok_or(error)?;
            }
            Err(error) => return Err(error),
        }
    }
}

pub fn render(
    source: &str,
    engine: &Engine,
    attachments: &Attachments,
) -> Result<String, Vec<Diagnostic>> {
    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.extension.front_matter_delimiter = Some("---".into());
    options.extension.math_dollars = true;
    options.extension.math_latex = true;
    // Raw HTML is intentionally preserved for documents that use HTML elements.
    options.render.r#unsafe = true;
    let root = parse_document(&arena, source, &options);
    crate::markdown::ast::add_static_heading_sections(&arena, root);
    let headings = HeadingIds::default();
    let mut plugins = Plugins::default();
    plugins.render.heading_adapter = Some(&headings);
    let diagnostics: Vec<_> = root
        .descendants()
        .enumerate()
        .filter_map(|(index, node)| {
            let mut data = node.data.borrow_mut();
            let position = data.sourcepos.start;
            match transform(&data.value, engine, attachments, index) {
                Ok(Some(value)) => {
                    data.value = value;
                    None
                }
                Ok(None) => None,
                Err(message) => Some(Diagnostic {
                    line: position.line.max(1),
                    column: position.column.max(1),
                    message,
                }),
            }
        })
        .collect();
    if !diagnostics.is_empty() {
        return Err(diagnostics);
    }
    let mut html = String::new();
    format_html_with_plugins(root, &options, &mut html, &plugins).map_err(failure)?;
    Ok(html)
}

fn transform(
    value: &NodeValue,
    engine: &Engine,
    attachments: &Attachments,
    index: usize,
) -> Result<Option<NodeValue>, String> {
    match value {
        NodeValue::CodeBlock(code) => {
            let language = code.info.split_whitespace().next().unwrap_or("");
            match language {
                "mermaid" => engine
                    .render("diagram", &code.literal, "", index)
                    .map(|svg| svg.map(|svg| format!("<div class=\"diagram\">{svg}</div>\n"))),
                "math" => engine.render("display", &code.literal, "", index),
                _ => {
                    let html = if language.is_empty() {
                        None
                    } else {
                        engine.render("code", &code.literal, language, index)?
                    };
                    let class = if language.is_empty() {
                        "hljs".to_owned()
                    } else {
                        format!("hljs language-{}", escape(language))
                    };
                    Ok(Some(format!(
                        "<div class=\"code-wrap\"><pre><code class=\"{class}\">{}</code></pre></div>\n",
                        html.unwrap_or_else(|| escape(&code.literal))
                    )))
                }
            }
        }
        NodeValue::Math(math) => engine.render(
            if math.display_math { "display" } else { "math" },
            &math.literal,
            "",
            index,
        ),
        NodeValue::Image(link) => {
            let mut link = link.clone();
            link.url = attachments.resolve(&link.url, true)?;
            return Ok(Some(NodeValue::Image(link)));
        }
        NodeValue::Link(link) => {
            let mut link = link.clone();
            link.url = attachments.resolve(&link.url, false)?;
            return Ok(Some(NodeValue::Link(link)));
        }
        NodeValue::HtmlInline(html) => {
            crate::raw_html::rewrite(&strip_script_elements(html), attachments).map(Some)
        }
        NodeValue::HtmlBlock(html) => {
            crate::raw_html::rewrite(&strip_script_elements(&html.literal), attachments).map(Some)
        }
        _ => Ok(None),
    }
    .map(|html| html.map(NodeValue::Raw))
}

fn strip_script_elements(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut output = String::with_capacity(html.len());
    let mut cursor = 0;
    while let Some(relative) = find_ascii_case_insensitive(bytes, b"<script", cursor) {
        let start = relative;
        let after_name = start + b"<script".len();
        if bytes
            .get(after_name)
            .is_some_and(|byte| !byte.is_ascii_whitespace() && *byte != b'>' && *byte != b'/')
        {
            output.push_str(&html[cursor..after_name]);
            cursor = after_name;
            continue;
        }
        output.push_str(&html[cursor..start]);
        let Some(open_end) = html[after_name..].find('>').map(|end| after_name + end + 1) else {
            return output;
        };
        let self_closing = bytes[start..open_end - 1]
            .iter()
            .rev()
            .find(|byte| !byte.is_ascii_whitespace())
            == Some(&b'/');
        if self_closing {
            cursor = open_end;
            continue;
        }
        let Some(close_start) = find_ascii_case_insensitive(bytes, b"</script", open_end) else {
            return output;
        };
        let Some(close_end) = html[close_start..]
            .find('>')
            .map(|end| close_start + end + 1)
        else {
            return output;
        };
        cursor = close_end;
    }
    output.push_str(&html[cursor..]);
    output
}

fn find_ascii_case_insensitive(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|window| {
            window
                .iter()
                .zip(needle)
                .all(|(actual, expected)| actual.eq_ignore_ascii_case(expected))
        })
        .map(|offset| from + offset)
}

fn failure(message: impl ToString) -> Vec<Diagnostic> {
    vec![Diagnostic {
        line: 1,
        column: 1,
        message: message.to_string(),
    }]
}

pub fn compile(args: &Args) -> Result<(), Vec<Diagnostic>> {
    // QuickJS uses the native thread stack for parsing and execution. Reserve
    // more than its 4 MiB budget instead of relying on the platform main stack
    // (notably smaller on Windows). Create and drop the runtime on this thread.
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("comrak-compiler".into())
            .stack_size(16 * 1024 * 1024)
            .spawn_scoped(scope, || compile_document(args))
            .map_err(|error| failure(format!("cannot start compiler thread: {error}")))?
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

fn compile_document(args: &Args) -> Result<(), Vec<Diagnostic>> {
    let input =
        dunce::canonicalize(&args.input).map_err(|e| failure(format!("cannot open input: {e}")))?;
    let source =
        fs::read_to_string(&input).map_err(|e| failure(format!("cannot read UTF-8 input: {e}")))?;
    let root = dunce::canonicalize(args.root.as_deref().unwrap_or(input.parent().unwrap()))
        .map_err(|e| failure(format!("cannot open root: {e}")))?;
    if !root.is_dir() || !input.starts_with(&root) {
        return Err(failure("input must be inside the --root directory"));
    }
    let output = std::path::absolute(&args.output).map_err(failure)?;
    let parent = output
        .parent()
        .ok_or_else(|| failure("output must have a parent directory"))?;
    fs::create_dir_all(parent).map_err(failure)?;
    let output = dunce::canonicalize(parent).map_err(failure)?.join(
        output
            .file_name()
            .ok_or_else(|| failure("output must be a file"))?,
    );
    if output == input || dunce::canonicalize(&output).ok().as_ref() == Some(&input) {
        return Err(failure("output would overwrite the Markdown input"));
    }
    let attachments =
        Attachments::new(&input, &output, root, args.images, args.standalone).map_err(failure)?;
    let engine = Engine::default();
    let body = render(&source, &engine, &attachments)?;
    let stylesheet =
        assets::stylesheet(args.standalone, args.asset_dir.as_deref()).map_err(failure)?;
    let title = args.title.as_deref().unwrap_or_else(|| {
        input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Document")
    });
    let html = format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"generator\" content=\"lib.comrak {}\"><title>{}</title>\n{stylesheet}\n</head><body><main id=\"content\">\n{body}</main></body></html>\n",
        env!("CARGO_PKG_VERSION"),
        escape(title)
    );
    assets::atomic_write(&output, html.as_bytes()).map_err(failure)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compilation_does_not_depend_on_callers_stack_size() {
        std::thread::Builder::new()
            .stack_size(512 * 1024)
            .spawn(|| {
                let temp = tempfile::tempdir().unwrap();
                let input = temp.path().join("note.md");
                let output = temp.path().join("note.html");
                fs::write(
                    &input,
                    "$x^2$\n\n```js\nconst x = 1;\n```\n\n```mermaid\nflowchart LR\n A --> B\n```\n",
                )
                .unwrap();
                let args = crate::cli::parse([
                    input.to_str().unwrap().to_owned(),
                    output.to_str().unwrap().to_owned(),
                    "--standalone".to_owned(),
                ])
                .unwrap()
                .unwrap();
                compile(&args).unwrap();
                let html = fs::read_to_string(output).unwrap();
                for marker in ["katex", "hljs-keyword", "<svg"] {
                    assert!(html.contains(marker), "missing renderer output: {marker}");
                }
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn compile_references_images_and_preserves_output_on_error() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("note.md");
        let output = temp.path().join("out/note.html");
        fs::write(temp.path().join("image.png"), b"image bytes").unwrap();
        fs::write(
            &input,
            "# Example\n\n$x^2$\n\n![image](image.png)\n\n<figure>\n<img src=\"image.png\">\n</figure>\n",
        )
        .unwrap();
        let mut args = Args {
            input: input.clone(),
            output: output.clone(),
            root: None,
            images: Images::Reference,
            standalone: false,
            asset_dir: Some(temp.path().join("shared")),
            title: Some("<Example>".into()),
            short: true,
        };
        compile(&args).unwrap();
        let shared = fs::read_to_string(&output).unwrap();
        assert!(shared.contains("<title>&lt;Example&gt;</title>"));
        assert!(shared.contains("file:///"));
        // Attachment resolution canonicalizes the path. On Windows that can
        // normalize the temporary directory's path representation, so build
        // the expected URL from the same canonical path.
        let image_path = dunce::canonicalize(temp.path().join("image.png")).unwrap();
        let image_url = assets::file_url(&image_path).unwrap();
        assert_eq!(shared.matches(&format!("src=\"{image_url}\"")).count(), 2);
        assert!(!temp.path().join("out/note.assets").exists());
        assert_eq!(
            fs::read(temp.path().join("image.png")).unwrap(),
            b"image bytes"
        );
        args.standalone = true;
        args.images = Images::Embed;
        compile(&args).unwrap();
        let standalone = fs::read_to_string(&output).unwrap();
        assert!(standalone.contains("data:image/png;base64,"));
        assert_eq!(standalone.matches("data:image/png;base64,").count(), 2);
        assert!(standalone.contains("data:font/woff2;base64,"));
        assert!(!standalone.contains("file:///"));
        assert!(!standalone.contains("<script"));
        fs::write(&input, "# Broken\n\n$\\unknowncommand$\n").unwrap();
        let errors = compile(&args).unwrap_err();
        assert_eq!(errors[0].line, 3);
        assert_eq!(fs::read_to_string(&output).unwrap(), standalone);
        args.output = input.clone();
        assert!(compile(&args).unwrap_err()[0].message.contains("overwrite"));
    }
    #[test]
    fn root_relative_images_and_output_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        fs::create_dir_all(root.join("notes/topic")).unwrap();
        fs::create_dir_all(root.join("out")).unwrap();
        fs::write(root.join("a b.png"), b"png").unwrap();
        let mut attachments = Attachments::new(
            &root.join("notes/topic/a.md"),
            &root.join("out/a.html"),
            root.clone(),
            Images::Reference,
            false,
        )
        .unwrap();
        assert_eq!(
            attachments
                .resolve("../../a%20b.png?size=2#test", true)
                .unwrap(),
            format!(
                "{}?size=2#test",
                assets::file_url(&root.join("a b.png")).unwrap()
            )
        );
        assert_eq!(
            attachments.resolve("../../a%20b.png", true).unwrap(),
            assets::file_url(&root.join("a b.png")).unwrap().to_string()
        );
        assert_eq!(
            attachments
                .resolve("license.md?download=1#license", false)
                .unwrap(),
            format!(
                "{}?download=1#license",
                assets::file_url(&root.join("notes/topic/license.md")).unwrap()
            )
        );
        assert!(attachments.resolve("license.md", true).is_err());
        assert!(attachments.resolve("../../../missing.md", false).is_err());
        attachments.mode = Images::Embed;
        assert_eq!(
            attachments.resolve("../../a%20b.png#part", true).unwrap(),
            "data:image/png;base64,cG5n#part"
        );
        assert_eq!(
            attachments
                .resolve("../../a%20b.png?size=2#part", false)
                .unwrap(),
            format!(
                "{}?size=2#part",
                assets::file_url(&root.join("a b.png")).unwrap()
            )
        );
        attachments.root = root.join("notes");
        assert!(
            attachments
                .resolve("../../a%20b.png", true)
                .unwrap_err()
                .contains("outside root")
        );
        attachments.standalone = true;
        assert!(
            attachments
                .resolve("https://example.com/a.png", true)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_cannot_escape_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.png"), b"image").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
        let attachments = Attachments::new(
            &root.path().join("a.md"),
            &root.path().join("a.html"),
            root.path().to_owned(),
            Images::Reference,
            false,
        )
        .unwrap();
        assert!(
            attachments
                .resolve("linked/missing/note.md", false)
                .unwrap_err()
                .contains("outside root")
        );
        std::os::unix::fs::symlink(root.path().join("absent"), root.path().join("dangling"))
            .unwrap();
        assert!(attachments.resolve("dangling/note.md", false).is_err());
        fs::create_dir(root.path().join("inside")).unwrap();
        std::os::unix::fs::symlink(root.path().join("inside"), root.path().join("alias")).unwrap();
        assert_eq!(
            attachments
                .resolve("alias/missing/note.md#part", false)
                .unwrap(),
            format!(
                "{}#part",
                assets::file_url(&root.path().join("inside/missing/note.md")).unwrap()
            )
        );
        assert!(
            attachments
                .resolve("linked/secret.png", true)
                .unwrap_err()
                .contains("outside root")
        );
    }

    #[test]
    fn static_document_and_diagnostic_positions() {
        let temp = tempfile::tempdir().unwrap();
        let attachments = Attachments::new(
            &temp.path().join("a.md"),
            &temp.path().join("a.html"),
            temp.path().to_owned(),
            Images::Reference,
            false,
        )
        .unwrap();
        let engine = Engine::default();
        let source = "# Hello\n\n$x^2$\n\n```js\nconst x = 1;\n```\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nNote[^n]\n\n[^n]: Visible footnote\n\n<script>alert(1)</script>\n";
        let html = render(source, &engine, &attachments).unwrap();
        assert!(html.contains("katex"));
        assert!(html.contains("hljs-keyword"));
        assert!(html.contains("<svg"));
        assert!(html.contains("Visible footnote"));
        assert!(!html.contains("<script>"));
        assert!(!html.contains(" hidden"));
        let errors = render("# Hi\n\n![missing](missing.png)", &engine, &attachments).unwrap_err();
        assert_eq!(errors[0].line, 3);
        assert!(errors[0].message.contains("missing.png"));
    }
}
