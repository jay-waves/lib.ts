use std::path::PathBuf;

pub const HELP: &str = "lib.comrak — compile Markdown to static HTML

Usage: lib.comrak <compile|watch> [OPTIONS] <INPUT> [OUTPUT]

Options:
  -o, --output <PATH>                 Output HTML (default: input with .html)
      --root <DIR>                    Allowed local attachment root (default: input directory)
      --images <reference|embed>  Local image handling (default: reference)
      --standalone                    Inline CSS, fonts and local images
      --asset-dir <DIR>               Override the shared resource directory
      --no-fullscreen                 Print normal output lines (watch)
      --color <never|auto>             Output color (default: never)
      --diagnostic-format <short|human>  Diagnostic format (default: human)
      --title <TEXT>                  Document title (default: input filename)
  -h, --help                         Show help
  -V, --version                      Show version

Shared resources default to LocalAppData/lib.comrak/assets on Windows (Known Folder API),
~/Library/Caches/lib.comrak/assets on macOS, or $XDG_CACHE_HOME/lib.comrak/assets
on Linux. They are versioned automatically. Interactive viz modules use browser JavaScript.
Remote image URLs are preserved; standalone rejects them to avoid hidden network dependencies.
";

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Images {
    Reference,
    Embed,
}

#[derive(Debug)]
pub struct Args {
    pub watch: bool,
    pub input: PathBuf,
    pub output: PathBuf,
    pub root: Option<PathBuf>,
    pub images: Images,
    pub standalone: bool,
    pub asset_dir: Option<PathBuf>,
    pub title: Option<String>,
    pub short: bool,
}

pub fn parse(values: impl IntoIterator<Item = String>) -> Result<Option<Args>, String> {
    let mut values = values.into_iter().peekable();
    let watch = values.peek().is_some_and(|s| s == "watch");
    if values
        .peek()
        .is_some_and(|s| s == "compile" || s == "watch")
    {
        values.next();
    }
    let mut paths = Vec::new();
    let mut output = None;
    let mut root = None;
    let mut images = Images::Reference;
    let mut standalone = false;
    let mut asset_dir = None;
    let mut title = None;
    let mut short = false;
    let mut positional = false;
    while let Some(value) = values.next() {
        if positional {
            paths.push(PathBuf::from(value));
            continue;
        }
        let (flag, inline) = value
            .split_once('=')
            .map_or((value.as_str(), None), |(a, b)| (a, Some(b)));
        let mut argument = || {
            inline
                .map(str::to_owned)
                .or_else(|| values.next())
                .ok_or_else(|| format!("missing value for {flag}"))
        };
        match flag {
            "--" => positional = true,
            "-h" | "--help" => {
                print!("{HELP}");
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("lib.comrak {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "-o" | "--output" => output = Some(PathBuf::from(argument()?)),
            "--root" => root = Some(PathBuf::from(argument()?)),
            "--asset-dir" => asset_dir = Some(PathBuf::from(argument()?)),
            "--title" => title = Some(argument()?),
            "--standalone" if inline.is_none() => standalone = true,
            "--no-fullscreen" if inline.is_none() && watch => {}
            "--color" => match argument()?.as_str() {
                "never" | "auto" => {}
                _ => return Err("--color must be never or auto".into()),
            },
            "--images" => {
                images = match argument()?.as_str() {
                    "reference" => Images::Reference,
                    "embed" => Images::Embed,
                    _ => return Err("--images must be reference or embed".into()),
                }
            }
            "--diagnostic-format" => {
                short = match argument()?.as_str() {
                    "short" => true,
                    "human" => false,
                    _ => return Err("--diagnostic-format must be short or human".into()),
                }
            }
            s if s.starts_with('-') => return Err(format!("unknown option {s}")),
            _ => paths.push(PathBuf::from(value)),
        }
    }
    if paths.is_empty() {
        return Err("missing input; use --help for usage".into());
    }
    if paths.len() > 2 || (paths.len() == 2 && output.is_some()) {
        return Err("provide one input and one output".into());
    }
    let mut paths = paths.into_iter();
    let input = paths.next().unwrap();
    let output = output
        .or_else(|| paths.next())
        .unwrap_or_else(|| input.with_extension("html"));
    Ok(Some(Args {
        watch,
        input,
        output,
        root,
        images: if standalone { Images::Embed } else { images },
        standalone,
        asset_dir,
        title,
        short,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_modes() {
        let parse_args = |values: &[&str]| parse(values.iter().map(|value| (*value).to_owned()));
        assert_eq!(
            parse_args(&["a.md"]).unwrap().unwrap().images,
            Images::Reference
        );
        assert_eq!(
            parse_args(&["a.md", "--images=embed"])
                .unwrap()
                .unwrap()
                .images,
            Images::Embed
        );
        for values in [
            vec!["a.md", "--standalone", "--images=reference"],
            vec!["a.md", "--images=reference", "--standalone"],
        ] {
            assert_eq!(parse_args(&values).unwrap().unwrap().images, Images::Embed);
        }
        assert!(parse_args(&["a.md", "--images=copy"]).is_err());
    }

    #[test]
    fn typst_style_and_inline_arguments() {
        let args = parse(
            [
                "compile",
                "a.md",
                "b.html",
                "--root=..",
                "--diagnostic-format",
                "short",
                "--standalone",
            ]
            .map(String::from),
        )
        .unwrap()
        .unwrap();
        assert_eq!(args.output, PathBuf::from("b.html"));
        assert_eq!(args.images, Images::Embed);
        assert!(args.short);
        assert!(parse(["a.md", "b.html", "-o", "c.html"].map(String::from)).is_err());
        let watch = parse(["watch", "a.md", "b.html"].map(String::from))
            .unwrap()
            .unwrap();
        assert!(watch.watch);
        assert_eq!(watch.output, PathBuf::from("b.html"));
    }
}
