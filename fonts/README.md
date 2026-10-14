Bundled offline Typst fonts

Default Typst text assets: https://github.com/typst/typst-assets/tree/v0.13.1/files/fonts
Licenses: NOTICE-Typst-assets.txt (Libertinus Serif, New Computer Modern, DejaVu Sans Mono).

Iosevka and Source Han Sans/Serif were copied unmodified from typst-template/fonts.
Their licenses are included as LICENSE-*.txt. Georgia uses the Core Fonts EULA
in LICENSE-Georgia.html; it is not an OFL font. The four georgia*.ttf files were
extracted without modification from the original Microsoft Core Fonts installer:
https://downloads.sourceforge.net/project/corefonts/the%20fonts/final/georgi32.exe

manifest.json is the explicit loading list. Listed files are supplied to the native compiler, which also includes default fonts.
SC aliases are generated as cached name-table adaptations for native file loading;
the original distributed files remain unchanged. No WASM font metadata build is needed. Keep licenses with redistributed fonts.
