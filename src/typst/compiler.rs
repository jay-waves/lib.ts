use super::*;

impl NativeTypstCompiler {
    #[cfg(test)]
    #[allow(dead_code)] // Standalone lifecycle benchmark diagnostics.
    pub fn cache_usage(&self) -> (usize, usize, usize, usize) {
        let state = self.state.lock().unwrap();
        let (pages, bytes) = self.pages.lock().unwrap().usage();
        (
            state.entries.len(),
            state
                .entries
                .iter()
                .map(|(_, entry)| entry.source.len())
                .sum(),
            pages,
            bytes,
        )
    }
    #[cfg(test)]
    pub fn new(root: PathBuf) -> Self {
        Self::with_page_cache(root, page_cache())
    }

    pub fn with_page_cache(root: PathBuf, pages: PageCache) -> Self {
        Self {
            root,
            compile_gate: Mutex::new(()),
            fonts: Mutex::new(None),
            pages,
            state: Mutex::new(Documents {
                entries: LruCache::unbounded(),
                compiled: HashMap::new(),
                active_paths: HashSet::new(),
                last_activity: Instant::now(),
                generation: 0,
            }),
        }
    }

    pub fn has_active_documents(&self) -> bool {
        self.state
            .lock()
            .map(|state| !state.active_paths.is_empty())
            .unwrap_or(true)
    }

    pub fn set_active_paths(&self, paths: impl IntoIterator<Item = PathBuf>) {
        if let Ok(mut state) = self.state.lock() {
            state.active_paths = paths
                .into_iter()
                .filter(|path| {
                    path.starts_with(&self.root)
                        && path
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("typ"))
                })
                .collect();
        }
    }

    /// Release idle document layouts and rendered SVGs while preserving any
    /// document currently pinned by a browser lease.
    pub fn evict_idle(&self, idle_for: StdDuration) -> bool {
        let Ok(_compile) = self.compile_gate.try_lock() else {
            return false;
        };
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let all_idle = state.last_activity.elapsed() >= idle_for;
        trim_documents(&mut state, &self.pages, "");
        let inactive = state
            .entries
            .iter()
            .filter(|(_, entry)| {
                Arc::strong_count(&entry.document) == 1
                    && match entry.superseded_at {
                        Some(at) => at.elapsed() >= REVISION_GRACE,
                        None => {
                            !state.active_paths.contains(&entry.path)
                                && entry.last_used.elapsed() >= idle_for
                        }
                    }
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in inactive {
            remove_document(&mut state, &self.pages, &id);
        }
        if state.entries.is_empty()
            && let Ok(mut fonts) = self.fonts.lock()
        {
            fonts.take();
        }
        if let Ok(mut pages) = self.pages.lock() {
            pages.prune();
        }
        all_idle
    }

    pub fn clear(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.generation = state.generation.wrapping_add(1);
            let ids = state
                .entries
                .iter()
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in ids {
                remove_document(&mut state, &self.pages, &id);
            }
            state.active_paths.clear();
        }
        if let Ok(mut fonts) = self.fonts.lock() {
            fonts.take();
        }
    }

    fn font_store(&self) -> Result<Arc<FontStore>, String> {
        let mut fonts = self
            .fonts
            .lock()
            .map_err(|_| "Typst font store lock poisoned".to_owned())?;
        if let Some(store) = fonts.as_ref() {
            return Ok(store.clone());
        }
        let store = typst_font_store();
        *fonts = Some(store.clone());
        Ok(store)
    }

    #[cfg(test)]
    pub fn compile(&self, request: CompileRequest) -> Result<CompileResponse, CompileError> {
        self.compile_cancellable(request, &Cancellation::default())
    }

    pub fn compile_cancellable(
        &self,
        request: CompileRequest,
        cancellation: &Cancellation,
    ) -> Result<CompileResponse, CompileError> {
        if cancellation.is_cancelled() {
            return Err(CompileError::Cancelled);
        }
        let _compile = self
            .compile_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = checked_typst_path(&self.root, &request.path)?;
        let theme = request
            .theme
            .as_deref()
            .filter(|value| *value == "dark")
            .unwrap_or("light");
        if let Ok(mut state) = self.state.lock() {
            state.last_activity = Instant::now();
        }
        let key = CompileKey {
            path: path.clone(),
            theme: theme.into(),
            source_hash: typst::utils::hash128(&request.source),
        };
        let candidate = {
            let state = self
                .state
                .lock()
                .map_err(|_| "Typst cache lock poisoned".to_owned())?;
            state.compiled.get(&key).and_then(|id| {
                state.entries.peek(id).map(|entry| {
                    (
                        id.clone(),
                        entry.source.clone(),
                        entry.dependencies.clone(),
                        entry.dates.clone(),
                    )
                })
            })
        };
        if let Some((id, source, dependencies, dates)) = candidate {
            let now = Time::system();
            if source.as_ref() == request.source
                && dependencies.iter().all(Dependency::unchanged)
                && dates
                    .iter()
                    .all(|(offset, date)| now.today(*offset) == *date)
            {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "Typst cache lock poisoned".to_owned())?;
                for (other_id, entry) in state.entries.iter_mut() {
                    if other_id != &id
                        && entry.path == path
                        && entry.theme == theme
                        && entry.superseded_at.is_none()
                    {
                        entry.superseded_at = Some(Instant::now());
                    }
                }
                if let Some(entry) = state.entries.get_mut(&id) {
                    entry.last_used = Instant::now();
                    entry.created = Instant::now();
                    entry.superseded_at = None;
                    return Ok(entry.response.clone());
                }
            }
        }
        let generation = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Typst cache lock poisoned".to_owned())?;
            trim_documents(&mut state, &self.pages, "");
            // A fixed admission limit bounds lease-pinned layouts too. Existing
            // documents can still update by superseding their previous version.
            if state.entries.len() >= 32
                && !state
                    .entries
                    .iter()
                    .any(|(_, entry)| entry.path == path && entry.theme == theme)
            {
                return Err(CompileError::Busy);
            }
            loop {
                let source_bytes = state
                    .entries
                    .iter()
                    .map(|(_, entry)| entry.source.len())
                    .sum::<usize>();
                if source_bytes.saturating_add(request.source.len()) <= SOURCE_BYTES_LIMIT {
                    break;
                }
                let victim = state
                    .entries
                    .iter()
                    .rev()
                    .find(|(_, entry)| {
                        Arc::strong_count(&entry.document) == 1
                            && !(state.active_paths.contains(&entry.path)
                                && entry.superseded_at.is_none())
                            && !entry
                                .superseded_at
                                .is_some_and(|at| at.elapsed() < REVISION_GRACE)
                    })
                    .map(|(id, _)| id.clone());
                let Some(id) = victim else {
                    return Err(CompileError::Busy);
                };
                remove_document(&mut state, &self.pages, &id);
            }
            state.generation
        };
        let source: Arc<str> = Arc::from(request.source.as_str());
        let world = TypstWorld::new(&self.root, &path, request.source, theme, self.font_store()?)?;
        let Warned { output, warnings } = typst::compile::<PagedDocument>(&world);
        // Age unused comemo results during active use. The service also clears
        // the process-global cache after every root compiler has been idle.
        comemo::evict(30);
        let mut diagnostics = map_diagnostics(&world, warnings, "warning");
        let document = match output {
            Ok(document) => document,
            Err(errors) => {
                diagnostics.extend(map_diagnostics(&world, errors, "error"));
                return Err(CompileError::Diagnostics(diagnostics));
            }
        };
        let pages = document
            .pages()
            .iter()
            .map(|page| PageInfo {
                width: page.frame.width().to_pt(),
                height: page.frame.height().to_pt(),
            })
            .collect::<Vec<_>>();
        let (outline, anchors) = extract_navigation(&world, &document, &pages);
        let id = next_id();
        let response = CompileResponse {
            id: id.clone(),
            pages: pages.clone(),
            diagnostics,
            outline,
            anchors,
        };
        let dependencies = world.dependencies()?;
        let dates = world.dates()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Typst cache lock poisoned".to_owned())?;
        if cancellation.is_cancelled() || state.generation != generation {
            return Err(CompileError::Cancelled);
        }
        state.compiled.insert(key.clone(), id.clone());
        for (_, entry) in state.entries.iter_mut() {
            if entry.path == path && entry.theme == theme && entry.superseded_at.is_none() {
                entry.superseded_at = Some(Instant::now());
            }
        }
        state.entries.put(
            id.clone(),
            Entry {
                path,
                document: Arc::new(document),
                theme: theme.to_owned(),
                created: Instant::now(),
                last_used: Instant::now(),
                key,
                source,
                response: response.clone(),
                dependencies,
                dates,
                superseded_at: None,
            },
        );
        trim_documents(&mut state, &self.pages, &id);
        Ok(response)
    }

    pub fn page(&self, id: &str, page: usize) -> Result<RenderedPage, String> {
        self.page_cancellable(id, page, &Cancellation::default())
    }

    pub fn page_cancellable(
        &self,
        id: &str,
        page: usize,
        cancellation: &Cancellation,
    ) -> Result<RenderedPage, String> {
        let (document, page_index) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Typst cache lock poisoned".to_owned())?;
            state.last_activity = Instant::now();
            let entry = state
                .entries
                .get_mut(id)
                .ok_or_else(|| "Typst document expired".to_owned())?;
            if page == 0 || page > entry.document.pages().len() {
                return Err("Invalid Typst page".into());
            }
            let document = entry.document.clone();
            entry.last_used = Instant::now();
            if let Some(rendered) = self
                .pages
                .lock()
                .map_err(|_| "Typst page cache lock poisoned")?
                .get(&(id.to_owned(), page))
            {
                return Ok(rendered);
            }
            (document, page - 1)
        };
        let page_layout = &document.pages()[page_index];
        let options = typst_svg::SvgOptions::default();
        let svg = bytes::Bytes::from(typst_svg::svg(page_layout, &options));
        let links = extract_page_links(page_layout, page, document.introspector());
        let state = self
            .state
            .lock()
            .map_err(|_| "Typst cache lock poisoned".to_owned())?;
        let rendered = RenderedPage { svg, links };
        if !cancellation.is_cancelled() && state.entries.contains(id) {
            let bytes = rendered.svg.len()
                + rendered
                    .links
                    .iter()
                    .map(|link| {
                        std::mem::size_of::<PageLink>() + link.href.as_ref().map_or(0, String::len)
                    })
                    .sum::<usize>();
            self.pages
                .lock()
                .map_err(|_| "Typst page cache lock poisoned")?
                .insert((id.to_owned(), page), rendered.clone(), bytes);
        }
        Ok(rendered)
    }

    #[allow(dead_code)] // Also used by the standalone backend benchmark harness.
    pub fn page_svg(&self, id: &str, page: usize) -> Result<bytes::Bytes, String> {
        self.page(id, page).map(|rendered| rendered.svg)
    }
}
