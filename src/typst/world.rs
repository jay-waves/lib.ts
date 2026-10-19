use super::*;

struct ProjectFiles {
    root: FsRoot,
    packages: SystemPackages,
    main: FileId,
    main_source: Bytes,
    dependencies: Mutex<Vec<Dependency>>,
}

#[derive(Clone)]
pub(super) struct Dependency {
    path: PathBuf,
    root: PathBuf,
    fingerprint: Option<u128>,
}

impl Dependency {
    pub(super) fn unchanged(&self) -> bool {
        let current = self
            .path
            .canonicalize()
            .ok()
            .filter(|path| path.starts_with(&self.root))
            .and_then(|path| std::fs::read(path).ok())
            .map(|bytes| typst::utils::hash128(&bytes));
        current == self.fingerprint
    }
}

impl FileLoader for ProjectFiles {
    fn load(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.main {
            return Ok(self.main_source.clone());
        }
        let (root, path) = match id.root() {
            VirtualRoot::Project => (self.root.path().to_owned(), self.root.resolve(id.vpath())?),
            VirtualRoot::Package(spec) => {
                let package = self.packages.obtain(&spec)?;
                (package.path().to_owned(), package.resolve(id.vpath())?)
            }
        };
        // `canonicalize` may add the Windows `\\?\` prefix. Canonicalize the
        // root too before comparing paths, otherwise valid files in installed
        // packages are rejected as outside their root on Windows.
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        let result = path
            .canonicalize()
            .map_err(|error| FileError::from_io(error, &path))
            .and_then(|canonical| {
                if !canonical.starts_with(&canonical_root) {
                    return Err(FileError::AccessDenied);
                }
                std::fs::read(&canonical)
                    .map(Bytes::new)
                    .map_err(|error| FileError::from_io(error, &canonical))
            });
        self.dependencies
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(Dependency {
                path,
                root: canonical_root,
                fingerprint: result
                    .as_ref()
                    .ok()
                    .map(|bytes| typst::utils::hash128(bytes.as_slice())),
            });
        result
    }
}

pub(super) struct TypstWorld {
    library: LazyHash<Library>,
    fonts: Arc<FontStore>,
    files: FileStore<ProjectFiles>,
    now: Time,
    dates: Mutex<Vec<(Option<Duration>, Option<Datetime>)>>,
}

impl TypstWorld {
    pub(super) fn new(
        root: &Path,
        main_file: &Path,
        source: String,
        theme: &str,
        fonts: Arc<FontStore>,
    ) -> Result<Self, String> {
        let relative = main_file
            .strip_prefix(root)
            .map_err(|_| "Typst source is outside the repository root")?;
        let relative = relative
            .to_str()
            .ok_or("Typst path is not valid UTF-8")?
            .replace('\\', "/");
        let virtual_path = VirtualPath::new(relative).map_err(|error| error.to_string())?;
        let main = FileId::new(RootedPath::new(VirtualRoot::Project, virtual_path));
        let main_source = Bytes::from_string(source);
        let inputs = Dict::from_iter([(Str::from("theme"), theme.into_value())]);
        let library = Library::builder().with_inputs(inputs).build();
        let packages = SystemPackages::new(SystemDownloader::new("lib-ts"));
        Ok(Self {
            library: LazyHash::new(library),
            fonts,
            files: FileStore::new(ProjectFiles {
                root: FsRoot::new(root.to_path_buf()),
                packages,
                main,
                main_source,
                dependencies: Mutex::new(Vec::new()),
            }),
            now: Time::system(),
            dates: Mutex::new(Vec::new()),
        })
    }

    pub(super) fn dependencies(&self) -> Result<Vec<Dependency>, String> {
        self.files
            .loader()
            .dependencies
            .lock()
            .map(|dependencies| dependencies.clone())
            .map_err(|_| "Typst dependency lock poisoned".into())
    }

    pub(super) fn dates(&self) -> Result<Vec<(Option<Duration>, Option<Datetime>)>, String> {
        self.dates
            .lock()
            .map(|dates| dates.clone())
            .map_err(|_| "Typst date lock poisoned".into())
    }
}

impl World for TypstWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }
    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }
    fn main(&self) -> FileId {
        self.files.loader().main
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        self.files.source(id)
    }
    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.file(id)
    }
    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }
    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        let date = self.now.today(offset);
        self.dates
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push((offset, date));
        date
    }
}
