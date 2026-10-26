# lib.comrak

独立 Markdown → HTML 编译器。Rust / Comrak 解析 Markdown，内嵌 QuickJS 在编译时执行 KaTeX、highlight.js 和 Pele。输出不包含渲染脚本，不需要启动后端或安装 Node.js。

## 构建

在仓库根目录安装现有 Node 依赖，然后执行：

```sh
npm ci
npm run package:comrak
```

产物为 `release/lib.comrak-<platform>-<arch>/lib.comrak.exe`（Windows）或 `lib.comrak`（其他平台）。Cargo 内部二进制名为 `lib-comrak`；打包脚本使用对外名称 `lib.comrak`。此包不依赖 lib.ts 的 HTTP 服务、Typst 或媒体处理模块。

单独构建和测试：

```sh
npm run build:comrak-assets
cargo build --release --locked -p lib-comrak
cargo test --release --locked -p lib-comrak
```

修改前端渲染代码、主题或 npm 依赖后，重新运行资源构建脚本。生成资源不提交 Git。构建需要 Node 和 C 编译器（QuickJS）；运行 exe 不需要这些环境。

## 使用

```sh
lib.comrak compile note.md
lib.comrak compile note.md output.html
lib.comrak compile notes/topic/note.md output.html --root .
lib.comrak compile note.md -o output.html --diagnostic-format short
lib.comrak compile note.md output.html --images reference
lib.comrak compile note.md output.html --standalone
```

也允许省略 `compile`。默认输出为输入文件同名 `.html`，图片留在原地，重算引用路径。`--help` 列出所有选项。成功退出码为 0，编译失败为 1，参数错误为 2。支持 `--option=value` 和 `--` 后的文件名。

短诊断格式为 `path:line:column: error: message`，行列从 1 开始；数学或图表渲染错误、附件错误定位到对应 Markdown 节点。人类格式使用 `error:` 与 `--> path:line:column`。诊断写 stderr，成功不输出日志。编译失败不会覆盖已有 HTML。

## 共享资源

默认首次运行自动释放 CSS、KaTeX WOFF2 字体和许可文本，后续编译检查并修复资源：

- Windows：`LocalAppData\lib.comrak\assets\<内容版本>\`，通过 Windows Known Folder API 获取当前用户的 `FOLDERID_LocalAppData`（通常为 `%LOCALAPPDATA%`），支持系统配置的目录重定向，不依赖环境变量或硬编码 `C:\Users`。
- macOS：`~/Library/Caches/lib.comrak/assets/<内容版本>/`
- Linux：`$XDG_CACHE_HOME/lib.comrak/assets/<内容版本>/`，未设置时使用 `~/.cache/`

HTML 用绝对 `file:` URL 引用共享样式，字体相对于样式引用。旧版本不会自动删除，避免旧 HTML 失效。`--asset-dir DIR` 可指定资源基目录。正文字体使用系统字体，不安装字体。

默认资源目录必须是绝对路径。Windows 无法获取 LocalAppData 或无权限写入时直接报错，不回退到当前工作目录、exe 所在目录、临时目录、Roaming、ProgramData 或 Windows 系统目录。仅在显式指定 `--asset-dir` 时使用自定义位置（允许相对路径）。临时写入文件放在目标文件旁边，完成后原子替换；输出 HTML 位于用户指定的位置，图片默认保留在原地。

这是本机阅读模式：换用户、换电脑、删除缓存后可能失去样式和公式字体；再次用对应版本编译可修复。需在用户实际浏览器中验证本地 CSS / 字体访问。分享或需要完全自包含时使用 `--standalone`，将 CSS、字体和本地 Markdown 图片内嵌，不写共享资源。远程图片在普通模式保留 URL；standalone 模式会报错，须先下载到本地。已有 `data:` 图片原样保留。

## 图片和路径

Markdown 图片路径始终相对于输入 Markdown 所在目录解释，支持 `../../`、URL 编码、查询参数及片段；`--root` 不改变解析基准。默认 root 是输入 Markdown 目录，输入文件与本地附件必须位于 root 内；解析符号链接后再检查边界。共享上级图片时显式扩大 root。

本地 Markdown 链接也会基于输入文件所在目录解析，并输出为绝对 `file:` URL，避免链接随编译输出目录变化。远程链接保持原样。

- `--images reference`（默认）：不复制，本地图片使用指向原文件的绝对 `file:` URL，输出 HTML 可放在临时目录。
- `--images embed`：本地图片转为 data URL；样式仍共享。
- `--standalone`：图片强制 embed，同时内嵌样式和字体。

普通本地链接会检查 root 并重算路径，不复制链接目标，也不自动编译链接到的 `.md` 文件。允许链接目标尚不存在，但会解析已有父目录的符号链接后检查 root；悬空符号链接会报错。移动 HTML 时需保持图片相对位置，或使用 `--standalone` 生成自包含文件。

## 支持与边界

支持表格、任务列表、删除线、自动链接、普通静态脚注、标题锚点、YAML front matter 隐藏、行内 / 块公式，以及 `math`、`mermaid` 代码块。渲染器按需初始化，普通正文和无语言代码块不加载 JavaScript 引擎。高亮复用 lib.ts 的语言注册（含 Typst、BibTeX、PowerShell、Excel）；未知语言保留转义后的源码。重复图表使用独立 SVG ID。标题保留基本的 `id` 供文内链接跳转，重复或与自动后缀重名的标题会继续加后缀，确保 ID 唯一；不生成目录或额外的锚点交互。

Pele 使用非浏览器文字宽度估算，SVG 可缩放但不随窗口重新布局。图表内部图片关闭；需要图片时放在 Markdown 正文中。Pele 不支持的图表或 KaTeX 不支持的公式会报错，不静默丢失内容。

Markdown 中的原始 HTML 标签会保留在输出中，可用于 `<figure>`、`<img>`、`<figcaption>` 等结构；`<script>` 元素及其内容会移除。原始 HTML 的 `src`、`href`、`poster`、`srcset` 等资源属性也相对于输入 Markdown 解析，检查 `--root` 边界后改为绝对 `file:` URL；`<img>`、SVG `<image>`、视频封面及 `srcset` 图片支持内嵌。音视频和外部样式表仅引用，不内嵌；内联 CSS 的 `url()` 暂不改写。无阅读器折叠、脚注弹层、视频播放器或其他应用交互。生成的页面使用现代 CSS（`@scope`、`light-dark()`），需现代浏览器。

验证仅运行 release 编译、静态检查和单元测试。请用户验证 Windows exe、实际浏览器中的共享字体、中文图表排版、打印，以及移动 HTML 后的图片引用。
