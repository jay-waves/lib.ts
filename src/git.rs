use git2::{DiffFormat, DiffOptions, Repository, Status, StatusOptions};
use serde::Serialize;
use std::path::{Component, Path};

const DIFF_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitStatus {
    pub repository: bool,
    pub branch: String,
    pub changes: Vec<Change>,
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    pub kind: &'static str,
    pub text: String,
    #[serde(rename = "oldLine")]
    pub old_line: Option<usize>,
    #[serde(rename = "newLine")]
    pub new_line: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
pub struct DiffSection {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub too_large: Option<bool>,
    pub hunks: Vec<Hunk>,
    pub additions: usize,
    pub deletions: usize,
    pub metadata: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResponse {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub conflict: bool,
    pub sections: Vec<DiffSection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clean: Option<bool>,
}

pub fn status(root: &Path) -> Result<GitStatus, String> {
    let repo = match Repository::discover(root) {
        Ok(repo) => repo,
        Err(_) => {
            return Ok(GitStatus {
                repository: false,
                branch: String::new(),
                changes: vec![],
            });
        }
    };
    let workdir = repo.workdir().unwrap_or(root);
    let prefix = root.strip_prefix(workdir).unwrap_or(Path::new(""));
    let head = repo.head().ok();
    let branch = if head.as_ref().is_some_and(|head| head.is_branch()) {
        head.as_ref()
            .and_then(|head| head.shorthand().ok())
            .unwrap_or_default()
            .to_owned()
    } else if let Some(head) = head {
        format!(
            "Detached HEAD · {}",
            head.target()
                .map(|oid| oid.to_string()[..7].to_owned())
                .unwrap_or_default()
        )
        .trim()
        .to_owned()
    } else {
        String::new()
    };
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|error| error.to_string())?;
    let changes = statuses
        .iter()
        .filter_map(|entry| {
            let state = entry.status();
            let renamed = if state.contains(Status::INDEX_RENAMED) {
                entry.head_to_index()
            } else if state.contains(Status::WT_RENAMED) {
                entry.index_to_workdir()
            } else {
                None
            };
            let path = renamed
                .as_ref()
                .and_then(|delta| delta.new_file().path())
                .or_else(|| entry.path().ok().map(Path::new))?;
            if !path.starts_with(prefix) {
                return None;
            }
            let relative = path
                .strip_prefix(prefix)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            let conflicted = state.contains(Status::CONFLICTED);
            let index = if state.contains(Status::INDEX_RENAMED) {
                'R'
            } else if state.contains(Status::INDEX_NEW) {
                'A'
            } else if state.contains(Status::INDEX_DELETED) {
                'D'
            } else if state.contains(Status::INDEX_TYPECHANGE) {
                'T'
            } else if state.contains(Status::INDEX_MODIFIED) {
                'M'
            } else {
                '.'
            };
            let worktree = if state.contains(Status::WT_NEW) {
                '?'
            } else if state.contains(Status::WT_RENAMED) {
                'R'
            } else if state.contains(Status::WT_DELETED) {
                'D'
            } else if state.contains(Status::WT_TYPECHANGE) {
                'T'
            } else if state.contains(Status::WT_MODIFIED) {
                'M'
            } else {
                '.'
            };
            let original = renamed
                .as_ref()
                .and_then(|delta| delta.old_file().path())
                .map(|path| {
                    path.strip_prefix(prefix)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .replace('\\', "/")
                });
            Some(Change {
                path: relative,
                status: if conflicted {
                    "UU".into()
                } else if worktree == '?' {
                    "??".into()
                } else {
                    format!("{index}{worktree}")
                },
                original_path: original,
            })
        })
        .collect();
    Ok(GitStatus {
        repository: true,
        branch,
        changes,
    })
}

pub fn diff(root: &Path, requested: &str, scope: &str) -> Result<DiffResponse, String> {
    if requested.is_empty() || requested.contains('\0') || Path::new(requested).is_absolute() {
        return Err("Invalid file path".into());
    }
    if !matches!(scope, "all" | "staged" | "unstaged" | "conflict") {
        return Err("Invalid diff scope".into());
    }
    let requested_path = Path::new(requested);
    if requested_path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Invalid file path".into());
    }
    let repo = Repository::discover(root).map_err(|_| "Not a Git repository".to_owned())?;
    let workdir = repo
        .workdir()
        .ok_or("Bare Git repositories have no file diff")?;
    let prefix = root.strip_prefix(workdir).unwrap_or(Path::new(""));
    let repo_path_string = prefix.join(requested).to_string_lossy().replace('\\', "/");
    let statuses = status(root)?.changes;
    let change = statuses.iter().find(|item| item.path == requested);
    let Some(change) = change else {
        return Ok(DiffResponse {
            path: requested.into(),
            original_path: None,
            conflict: false,
            sections: vec![],
            clean: Some(true),
        });
    };
    let unmerged = change.status == "UU"
        || change.status.contains('U')
        || change.status == "AA"
        || change.status == "DD";
    if change.status == "??" {
        let sections = if scope == "all" || scope == "unstaged" {
            vec![untracked(root, requested)?]
        } else {
            vec![]
        };
        return Ok(DiffResponse {
            path: requested.into(),
            original_path: None,
            conflict: false,
            clean: Some(sections.is_empty()),
            sections,
        });
    }

    let mut sections = Vec::new();
    let include_staged = !unmerged && change.status.as_bytes().first().is_some_and(|c| *c != b'.');
    let include_worktree = unmerged || change.status.as_bytes().get(1).is_some_and(|c| *c != b'.');
    if include_staged && (scope == "all" || scope == "staged") {
        let head = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        let mut opts = DiffOptions::new();
        opts.pathspec(&repo_path_string)
            .include_untracked(false)
            .context_lines(3);
        if change.status.starts_with('R') {
            if let Some(original) = &change.original_path {
                opts.pathspec(prefix.join(original).to_string_lossy().replace('\\', "/"));
            }
        }
        let index = repo.index().map_err(|error| error.to_string())?;
        let mut diff = repo
            .diff_tree_to_index(head.as_ref(), Some(&index), Some(&mut opts))
            .map_err(|error| error.to_string())?;
        let mut find = git2::DiffFindOptions::new();
        let _ = diff.find_similar(Some(&mut find));
        sections.push(render_diff(diff, "staged", "Staged changes")?);
    }
    if include_worktree
        && (scope == "all" || scope == "unstaged" || (unmerged && scope == "conflict"))
    {
        let mut opts = DiffOptions::new();
        opts.pathspec(&repo_path_string)
            .include_untracked(false)
            .context_lines(3);
        let index = repo.index().map_err(|error| error.to_string())?;
        let diff = repo
            .diff_index_to_workdir(Some(&index), Some(&mut opts))
            .map_err(|error| error.to_string())?;
        sections.push(render_diff(
            diff,
            "unstaged",
            if unmerged {
                "Conflict · compared with ours"
            } else {
                "Unstaged changes"
            },
        )?);
    }
    Ok(DiffResponse {
        path: requested.into(),
        original_path: change.original_path.clone(),
        conflict: unmerged,
        clean: Some(sections.is_empty()),
        sections,
    })
}

fn untracked(root: &Path, requested: &str) -> Result<DiffSection, String> {
    let path = root.join(requested);
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() as usize > DIFF_LIMIT {
        return Ok(DiffSection::empty("untracked", "Untracked").too_large());
    }
    let bytes = if metadata.file_type().is_symlink() {
        std::fs::read_link(path)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .as_bytes()
            .to_vec()
    } else {
        std::fs::read(path).map_err(|error| error.to_string())?
    };
    if bytes.contains(&0) {
        return Ok(DiffSection::empty("untracked", "Untracked").binary());
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.split('\n').collect::<Vec<_>>();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let additions = lines.len();
    Ok(DiffSection {
        id: "untracked".into(),
        label: "Untracked".into(),
        binary: None,
        too_large: None,
        hunks: if lines.is_empty() {
            vec![]
        } else {
            vec![Hunk {
                header: format!("@@ -0,0 +1,{} @@", lines.len()),
                lines: lines
                    .into_iter()
                    .enumerate()
                    .map(|(index, text)| DiffLine {
                        kind: "add",
                        text: text.into(),
                        old_line: None,
                        new_line: Some(index + 1),
                    })
                    .collect(),
            }]
        },
        additions,
        deletions: 0,
        metadata: vec![],
    })
}

impl DiffSection {
    fn empty(id: &str, label: &str) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            binary: None,
            too_large: None,
            hunks: vec![],
            additions: 0,
            deletions: 0,
            metadata: vec![],
        }
    }
    fn binary(mut self) -> Self {
        self.binary = Some(true);
        self
    }
    fn too_large(mut self) -> Self {
        self.too_large = Some(true);
        self
    }
}

fn render_diff(diff: git2::Diff<'_>, id: &str, label: &str) -> Result<DiffSection, String> {
    let binary = diff
        .deltas()
        .any(|delta| delta.flags().contains(git2::DiffFlags::BINARY));
    let mut patch = Vec::new();
    let mut too_large = false;
    let result = diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        let prefix_len = usize::from(matches!(origin, '+' | '-' | ' '));
        if patch
            .len()
            .saturating_add(line.content().len())
            .saturating_add(prefix_len)
            > DIFF_LIMIT
        {
            too_large = true;
            return false;
        }
        if prefix_len == 1 {
            patch.push(origin as u8);
        }
        patch.extend_from_slice(line.content());
        true
    });
    if result.is_err() && !too_large {
        return Err(result.unwrap_err().to_string());
    }
    if too_large {
        return Ok(DiffSection::empty(id, label).too_large());
    }
    if binary {
        return Ok(DiffSection::empty(id, label).binary());
    }
    Ok(parse_patch(id, label, &String::from_utf8_lossy(&patch)))
}

fn parse_patch(id: &str, label: &str, patch: &str) -> DiffSection {
    let mut section = DiffSection::empty(id, label);
    let mut old_line = 0usize;
    let mut new_line = 0usize;
    for line in patch.lines() {
        if line.starts_with("@@ ") {
            let mut parts = line.split_whitespace();
            let _ = parts.next();
            let old = parts.next().unwrap_or_default();
            let new = parts.next().unwrap_or_default();
            old_line = parse_range_start(old);
            new_line = parse_range_start(new);
            section.hunks.push(Hunk {
                header: line.into(),
                lines: vec![],
            });
            continue;
        }
        if let Some(hunk) = section.hunks.last_mut() {
            let (kind, text, old_number, new_number) = match line.as_bytes().first().copied() {
                Some(b'+') => {
                    section.additions += 1;
                    ("add", &line[1..], None, Some(new_line))
                }
                Some(b'-') => {
                    section.deletions += 1;
                    ("delete", &line[1..], Some(old_line), None)
                }
                Some(b' ') => ("context", &line[1..], Some(old_line), Some(new_line)),
                Some(b'\\') => ("note", &line[1..], None, None),
                _ => {
                    section.metadata.push(line.into());
                    continue;
                }
            };
            if kind == "context" || kind == "delete" {
                old_line += 1;
            }
            if kind == "context" || kind == "add" {
                new_line += 1;
            }
            hunk.lines.push(DiffLine {
                kind,
                text: text.into(),
                old_line: old_number,
                new_line: new_number,
            });
        } else if line.starts_with("old mode ")
            || line.starts_with("new mode ")
            || line.starts_with("new file mode ")
            || line.starts_with("deleted file mode ")
            || line.starts_with("similarity index ")
            || line.starts_with("rename from ")
            || line.starts_with("rename to ")
            || line.starts_with("Submodule ")
            || line.starts_with("* Unmerged ")
        {
            section.metadata.push(line.into());
        }
    }
    section
}

fn parse_range_start(value: &str) -> usize {
    value
        .trim_start_matches(['-', '+'])
        .split(',')
        .next()
        .and_then(|number| number.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn status_preserves_added_deleted_and_renamed_codes_and_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let repo = Repository::init(root).unwrap();
        let signature = git2::Signature::now("Test", "test@example.invalid").unwrap();
        let mut index = repo.index().unwrap();
        for name in ["old.md", "deleted.md"] {
            fs::write(root.join(name), format!("Unique contents for {name}\n")).unwrap();
            index.add_path(Path::new(name)).unwrap();
        }
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        fs::rename(root.join("old.md"), root.join("renamed.md")).unwrap();
        fs::remove_file(root.join("deleted.md")).unwrap();
        fs::write(root.join("added.md"), "Added\n").unwrap();
        index.remove_path(Path::new("old.md")).unwrap();
        index.remove_path(Path::new("deleted.md")).unwrap();
        index.add_path(Path::new("renamed.md")).unwrap();
        index.add_path(Path::new("added.md")).unwrap();
        index.write().unwrap();
        let changes = status(root).unwrap().changes;
        for (path, expected) in [
            ("added.md", "A."),
            ("deleted.md", "D."),
            ("renamed.md", "R."),
        ] {
            let change = changes.iter().find(|change| change.path == path).unwrap();
            assert_eq!(change.status, expected);
            assert_eq!(
                change.original_path.as_deref(),
                if path == "renamed.md" {
                    Some("old.md")
                } else {
                    None
                }
            );
        }
        let renamed = diff(root, "renamed.md", "staged").unwrap();
        assert_eq!(renamed.original_path.as_deref(), Some("old.md"));
        assert!(!renamed.clean.unwrap());
        assert!(
            renamed.sections[0]
                .metadata
                .iter()
                .any(|line| line == "rename from old.md")
        );
    }

    #[test]
    fn status_and_diff_cover_staged_unstaged_and_untracked_changes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let repo = Repository::init(root).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config
            .set_str("user.email", "test@example.invalid")
            .unwrap();
        fs::write(root.join("file.md"), "base\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.md")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = repo.signature().unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();

        fs::write(root.join("file.md"), "staged\n").unwrap();
        index.add_path(Path::new("file.md")).unwrap();
        index.write().unwrap();
        fs::write(root.join("file.md"), "worktree\n").unwrap();
        fs::write(root.join("new.md"), "one\ntwo\n").unwrap();

        let status = status(root).unwrap();
        assert!(status.repository);
        assert!(
            status
                .changes
                .iter()
                .any(|item| item.path == "file.md" && item.status == "MM")
        );
        assert!(
            status
                .changes
                .iter()
                .any(|item| item.path == "new.md" && item.status == "??")
        );
        let both = diff(root, "file.md", "all").unwrap();
        assert_eq!(
            both.sections
                .iter()
                .map(|section| section.id.as_str())
                .collect::<Vec<_>>(),
            ["staged", "unstaged"]
        );
        assert!(both.sections.iter().all(|section| section.additions == 1));
        let untracked = diff(root, "new.md", "all").unwrap();
        assert_eq!(untracked.sections[0].additions, 2);
        assert!(diff(root, "../outside", "all").is_err());
        drop(tree);
        drop(signature);
        drop(index);
        drop(config);
        drop(repo);
    }
}
