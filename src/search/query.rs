use super::*;
use ignore::overrides::{Override, OverrideBuilder};

pub(super) struct SearchSpec {
    pub(super) text: String,
    pub(super) regex: bool,
    pub(super) case_sensitive: bool,
    pub(super) respect_gitignore: bool,
    pub(super) languages: Vec<String>,
    pub(super) paths: Vec<PathFilter>,
}
pub(super) struct PathFilter {
    pub(super) value: String,
    pub(super) quoted: bool,
}

pub(super) fn parse_query(input: &str) -> Result<SearchSpec, String> {
    let mut tokens = Vec::<(String, String, bool)>::new();
    let mut index = 0;
    let chars = input.char_indices().collect::<Vec<_>>();
    while index < chars.len() {
        while index < chars.len() && chars[index].1.is_whitespace() {
            index += 1;
        }
        if index == chars.len() {
            break;
        }
        let mut start = chars[index].0;
        if chars[index].1 == '/' {
            let mut end = None;
            let mut in_class = false;
            let mut escaped = false;
            for (char_index, (_, ch)) in chars.iter().enumerate().skip(index + 1) {
                if escaped {
                    escaped = false;
                    continue;
                }
                if *ch == '\\' {
                    escaped = true;
                    continue;
                }
                if *ch == '[' {
                    in_class = true;
                }
                if *ch == ']' {
                    in_class = false;
                }
                if *ch == '/' && !in_class {
                    end = Some(char_index);
                    break;
                }
            }
            let end = end.ok_or("Close the regular expression with /.")?;
            let pattern_start = chars[index].0 + 1;
            let pattern_end = chars[end].0;
            let pattern = input[pattern_start..pattern_end].replace("\\/", "/");
            let mut after = end + 1;
            let flags_start = chars.get(after).map(|item| item.0).unwrap_or(input.len());
            while after < chars.len() && !chars[after].1.is_whitespace() {
                after += 1;
            }
            let flags_end = chars.get(after).map(|item| item.0).unwrap_or(input.len());
            let flags = &input[flags_start..flags_end];
            if flags != "" && flags != "i" {
                return Err("Only the i flag is supported: /pattern/ or /pattern/i.".into());
            }
            if pattern.is_empty() {
                return Err("Enter a non-empty regular expression between the slashes.".into());
            }
            tokens.push(("regex".into(), format!("{flags}:{pattern}"), false));
            index = after;
            continue;
        }
        let qualifier = ["lang:", "language:", "path:", "case:", "gitignore:"]
            .into_iter()
            .find(|prefix| {
                input[start..]
                    .get(..prefix.len())
                    .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
            });
        let kind = qualifier.map_or("text", |prefix| prefix.trim_end_matches(':'));
        if let Some(prefix) = qualifier {
            index += prefix.len();
            start += prefix.len();
        }
        let quoted = chars.get(index).is_some_and(|(_, ch)| *ch == '"');
        if quoted {
            index += 1;
            let mut value = String::new();
            let mut closed = false;
            while index < chars.len() {
                let ch = chars[index].1;
                if ch == '"' {
                    index += 1;
                    closed = true;
                    break;
                }
                if ch == '\\' && index + 1 < chars.len() && matches!(chars[index + 1].1, '"' | '\\')
                {
                    index += 1;
                }
                value.push(chars[index].1);
                index += 1;
            }
            if !closed {
                return Err("Close the quotation mark in your search query.".into());
            }
            if chars.get(index).is_some_and(|(_, ch)| !ch.is_whitespace()) {
                return Err("Separate search terms and filters with a space.".into());
            }
            tokens.push((kind.into(), value, true));
        } else {
            let mut end = index;
            while end < chars.len() && !chars[end].1.is_whitespace() {
                end += 1;
            }
            let byte_end = chars.get(end).map(|item| item.0).unwrap_or(input.len());
            tokens.push((kind.into(), input[start..byte_end].to_owned(), false));
            index = end;
        }
    }
    let mut text_terms = Vec::new();
    let mut languages = Vec::new();
    let mut paths = Vec::new();
    let mut regex = false;
    let mut case_sensitive = false;
    let mut regex_case_sensitive = None;
    let mut respect_gitignore = true;
    for (kind, value, quoted) in tokens {
        if kind != "text" && value.is_empty() {
            return Err(format!("Enter a value after {kind}:"));
        }
        match kind.as_str() {
            "regex" => {
                let (flags, pattern) = value.split_once(':').unwrap();
                text_terms.push(pattern.to_owned());
                regex = true;
                regex_case_sensitive = Some(flags != "i");
            }
            "lang" | "language" => languages.push(value),
            "path" => paths.push(PathFilter { value, quoted }),
            "case" => {
                case_sensitive = match value.as_str() {
                    "yes" => true,
                    "no" => false,
                    _ => return Err("Use case:yes or case:no.".into()),
                }
            }
            "gitignore" => {
                respect_gitignore = match value.as_str() {
                    "yes" => true,
                    "no" => false,
                    _ => return Err("Use gitignore:yes or gitignore:no.".into()),
                }
            }
            _ if !quoted && value == "--no-gitignore" => respect_gitignore = false,
            _ => text_terms.push(value),
        }
    }
    if regex && text_terms.len() != 1 {
        return Err("Use one regular expression with optional lang/path filters; quote text for a literal search.".into());
    }
    if let Some(regex_case_sensitive) = regex_case_sensitive {
        case_sensitive = regex_case_sensitive;
    }
    Ok(SearchSpec {
        text: text_terms.join(" "),
        regex,
        case_sensitive,
        respect_gitignore,
        languages,
        paths,
    })
}

pub(super) enum CompiledPathFilter {
    Literal(String),
    Glob(Override),
}

impl CompiledPathFilter {
    pub(super) fn new(filter: &PathFilter) -> Result<Self, String> {
        if filter.quoted || !filter.value.contains(['*', '?']) {
            return Ok(Self::Literal(filter.value.to_lowercase()));
        }
        // Preserve substring filters and AND between qualifiers. Only glob
        // matching is delegated to ripgrep's matcher; it must not override gitignore.
        let mut builder = OverrideBuilder::new("");
        builder
            .case_insensitive(true)
            .map_err(|error| error.to_string())?;
        // The query language exposes *, ** and ?. Other glob metacharacters
        // remain literal, matching the browser's bookmark filters.
        let escaped = filter.value.chars().fold(String::new(), |mut pattern, ch| {
            if matches!(ch, '[' | ']' | '{' | '}' | '\\') {
                pattern.push('\\');
            }
            pattern.push(ch);
            pattern
        });
        let pattern = if escaped.starts_with('/') {
            escaped
        } else {
            format!("**/{escaped}")
        };
        builder
            .add(&pattern)
            .map_err(|error| format!("Invalid path glob: {error}"))?;
        Ok(Self::Glob(
            builder.build().map_err(|error| error.to_string())?,
        ))
    }

    pub(super) fn matches(&self, path: &str) -> bool {
        match self {
            Self::Literal(needle) => path.to_lowercase().contains(needle),
            Self::Glob(glob) => glob.matched(path, false).is_whitelist(),
        }
    }
}

pub(super) fn params_path_filter(value: &str) -> Option<PathFilter> {
    (!value.is_empty()).then(|| PathFilter {
        value: value.to_owned(),
        quoted: true,
    })
}

pub(super) fn search_language(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = match ext.as_str() {
        "js" | "mjs" | "cjs" | "jsx" => "JavaScript",
        "ts" | "tsx" => "TypeScript",
        "py" => "Python",
        "rs" => "Rust",
        "go" => "Go",
        "c" | "h" => "C",
        "cpp" | "hpp" => "C++",
        "java" => "Java",
        "lua" => "Lua",
        "sh" | "bash" => "Shell",
        "ps1" | "pwsh" => "PowerShell",
        "md" | "markdown" => "Markdown",
        "typ" => "Typst",
        "json" => "JSON",
        "css" => "CSS",
        "html" | "htm" => "HTML",
        "yaml" | "yml" => "YAML",
        "toml" => "TOML",
        "xml" => "XML",
        "svg" => "SVG",
        "rb" => "Ruby",
        "php" => "PHP",
        "sql" => "SQL",
        _ => "Text",
    };
    name.into()
}

pub(super) fn normalize_language(language: &str) -> String {
    let lower = language.to_lowercase().replace([' ', '-'], "");
    match lower.as_str() {
        "js" | "jsx" | "mjs" | "cjs" => "javascript".into(),
        "ts" | "tsx" => "typescript".into(),
        "py" => "python".into(),
        "rs" => "rust".into(),
        "cpp" | "cplusplus" => "c++".into(),
        "sh" | "bash" => "shell".into(),
        "md" => "markdown".into(),
        "yml" => "yaml".into(),
        "plain" | "plaintext" => "text".into(),
        _ => lower,
    }
}
