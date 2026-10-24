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
    output: Url,
    root: PathBuf,
    mode: Images,
    standalone: bool,
}

impl Attachments {
    pub fn new(
        input: &Path,
        output: &Path,
        root: PathBuf,
        mode: Images,
        standalone: bool,
    ) -> Result<Self, String> {
        Ok(Self {
            input: assets::file_url(input)?,
            output: assets::file_url(output)?,
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
        let path = dunce::canonicalize(&path)
            .map_err(|e| format!("cannot read attachment {original:?}: {e}"))?;
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
        Ok(assets::reference_url(&self.output, &target))
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
    // Only our generated fragments bypass escaping; input HTML stays inert.
    options.render.r#unsafe = true;
    let root = parse_document(&arena, source, &options);
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
        NodeValue::HtmlInline(html) => Ok(Some(escape(html))),
        NodeValue::HtmlBlock(html) => Ok(Some(escape(&html.literal))),
        _ => Ok(None),
    }
    .map(|html| html.map(NodeValue::Raw))
}

fn failure(message: impl ToString) -> Vec<Diagnostic> {
    vec![Diagnostic {
        line: 1,
        column: 1,
        message: message.to_string(),
    }]
}

pub fn compile(args: &Args) -> Result<(), Vec<Diagnostic>> {
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
    fn compile_references_images_and_preserves_output_on_error() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("note.md");
        let output = temp.path().join("out/note.html");
        fs::write(temp.path().join("image.png"), b"image bytes").unwrap();
        fs::write(&input, "# Example\n\n$x^2$\n\n![image](image.png)\n").unwrap();
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
        assert!(shared.contains("src=\"../image.png\""));
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
            "../a%20b.png?size=2#test"
        );
        assert_eq!(
            attachments.resolve("../../a%20b.png", true).unwrap(),
            "../a%20b.png"
        );
        attachments.mode = Images::Embed;
        assert_eq!(
            attachments.resolve("../../a%20b.png#part", true).unwrap(),
            "data:image/png;base64,cG5n#part"
        );
        assert_eq!(
            attachments
                .resolve("../../a%20b.png?size=2#part", false)
                .unwrap(),
            "../a%20b.png?size=2#part"
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
        assert!(!html.contains(" hidden"));
        assert!(!html.contains("<script>"));
        let errors = render("# Hi\n\n![missing](missing.png)", &engine, &attachments).unwrap_err();
        assert_eq!(errors[0].line, 3);
        assert!(errors[0].message.contains("missing.png"));
    }
}
