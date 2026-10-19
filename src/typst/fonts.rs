use super::*;

static FONTS: OnceLock<Mutex<Weak<FontStore>>> = OnceLock::new();

pub(super) fn typst_font_store() -> Arc<FontStore> {
    let fonts = FONTS.get_or_init(|| Mutex::new(Weak::new()));
    let mut fonts = fonts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(store) = fonts.upgrade() {
        return store;
    }
    let store = Arc::new(build_typst_font_store());
    *fonts = Arc::downgrade(&store);
    store
}

// Keep native TTF/OTF inputs in fonts/manifest.json. Browser WOFF2 assets are
// separate: the native parser cannot decode webfont containers directly.
fn build_typst_font_store() -> FontStore {
    let explicit = std::env::var_os("TYPST_FONTS")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>());
    let base = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .filter(|directory| directory.join("fonts/manifest.json").is_file())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let requested = explicit.unwrap_or_else(|| {
        serde_json::from_str::<Vec<String>>(include_str!("../../fonts/manifest.json"))
            .expect("bundled Typst font manifest is valid")
            .into_iter()
            .map(|name| base.join("fonts").join(name))
            .collect()
    });

    let mut directories = HashMap::<PathBuf, bool>::new();
    let mut files = HashSet::new();
    for path in requested {
        if path.is_dir() {
            if let Ok(path) = path.canonicalize() {
                directories.insert(path, true);
            }
        } else if path.is_file()
            && let (Ok(file), Some(parent)) = (path.canonicalize(), path.parent())
            && let Ok(parent) = parent.canonicalize()
        {
            files.insert(file);
            directories.entry(parent).or_insert(false);
        }
    }

    let mut store = FontStore::new();
    for (directory, include_all) in directories {
        for (font, info) in typst_kit::fonts::scan(&directory) {
            if !include_all && !files.contains(&font.path) {
                continue;
            }
            let alias = font
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| {
                    if name.starts_with("SourceHanSerif") {
                        Some("Source Han Serif SC")
                    } else if name.starts_with("SourceHanSans") {
                        Some("Source Han Sans SC")
                    } else {
                        None
                    }
                })
                .map(|family| {
                    let mut alias = info.clone();
                    alias.family = family.into();
                    alias
                });
            let alias_font = alias.as_ref().map(|_| FontPath {
                path: font.path.clone(),
                index: font.index,
            });
            store.push((font, info));
            if let (Some(font), Some(info)) = (alias_font, alias) {
                // Mirror the old worker's Source Han CN -> SC family alias
                // without rewriting or retaining another copy of the font.
                store.push((font, info));
            }
        }
    }
    store
}
