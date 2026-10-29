# lib.comrak

独立 Markdown → HTML 编译器。Rust / Comrak 解析 Markdown，内嵌 QuickJS 在编译时执行 KaTeX、highlight.js 和 Pele。默认输出不包含渲染脚本；交互式 `viz` 可显式保留初始化模块。运行不需要启动后端或安装 Node.js。

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
lib.comrak watch note.md output.html --standalone
```

`watch` 接受与 `compile` 相同的选项，启动后立即编译，并监听 Markdown、引用的 D3/Mermaid 文件以及内嵌图片；保存后自动重新编译，按 Ctrl+C 停止。编辑器连续保存会合并处理，编译失败保留上次成功的 HTML，并在文件修复后继续重试。watch 不启动 HTTP 服务，也不会自动刷新浏览器。渲染结果在进程内缓存，因此修改普通正文时可以复用未改变的公式、高亮和图表。

图表的编译结果按脚本内容复用；请让绘图输出仅由脚本和内置数据决定，避免依赖随机数或时间。修改脚本会使缓存失效。

仓库提供可选 HTTP 预览脚本：`node scripts/preview-comrak.mjs output.html 8765`，仅监听 `127.0.0.1`。HTML 使用 ETag 条件缓存，刷新时内容未变则返回 304；此脚本不自动刷新或执行 DOM 复用，也不会由编译器自动启动。

图表 ID 根据声明及相同声明的出现次序生成，不随普通正文的增删而改变；JS 或 Mermaid 文件内容变化会重新渲染图表。多个完全相同的声明依靠出现次序区分，插入或删除其中一个时，其后的相同声明可能获得不同 ID。

也允许省略 `compile`。默认输出为输入文件同名 `.html`，图片留在原地，重算引用路径。`--help` 列出所有选项。成功退出码为 0，编译失败为 1，参数错误为 2。支持 `--option=value` 和 `--` 后的文件名。

生成的 HTML 与主应用共用块级定位：`output.html#L42` 跳到起始行不超过第 42 行的最近块顶部，空行归入前一块；首块之前及文末之后分别定位首块、末块。每块只标记一个从 1 开始的 `data-line`，标题原有的 `#标题` 锚点保留。HTML 附带小型定位脚本，字体和图片加载后会校正定位；关闭 JavaScript 时仍可使用精确标题锚点。

短诊断格式为 `path:line:column: error: message`，行列从 1 开始；数学或图表渲染错误、附件错误定位到对应 Markdown 节点。人类格式使用 `error:` 与 `--> path:line:column`。诊断写 stderr，成功时仅输出警告（如有）。编译失败不会覆盖已有 HTML。

## 共享资源

默认首次运行自动释放 CSS、KaTeX WOFF2 字体和许可文本，后续编译检查并修复资源：

- Windows：`LocalAppData\lib.comrak\assets\<内容版本>\`，通过 Windows Known Folder API 获取当前用户的 `FOLDERID_LocalAppData`（通常为 `%LOCALAPPDATA%`），支持系统配置的目录重定向，不依赖环境变量或硬编码 `C:\Users`。
- macOS：`~/Library/Caches/lib.comrak/assets/<内容版本>/`
- Linux：`$XDG_CACHE_HOME/lib.comrak/assets/<内容版本>/`，未设置时使用 `~/.cache/`

HTML 用绝对 `file:` URL 引用共享样式，字体相对于样式引用。旧版本不会自动删除，避免旧 HTML 失效。`--asset-dir DIR` 可指定资源基目录。西文优先使用系统 Georgia；中文使用随包的思源宋体，不需要系统安装。

默认资源目录必须是绝对路径。Windows 无法获取 LocalAppData 或无权限写入时直接报错，不回退到当前工作目录、exe 所在目录、临时目录、Roaming、ProgramData 或 Windows 系统目录。仅在显式指定 `--asset-dir` 时使用自定义位置（允许相对路径）。临时写入文件放在目标文件旁边，完成后原子替换；输出 HTML 位于用户指定的位置，图片默认保留在原地。

这是本机阅读模式：换用户、换电脑、删除缓存后可能失去样式和字体；再次用对应版本编译可修复。需在用户实际浏览器中验证本地 CSS / 字体访问。分享或需要完全自包含时使用 `--standalone`，将 CSS、字体和本地 Markdown 图片内嵌，不写共享资源；思源宋体常规及粗体会使 HTML 增大约 30 MiB。远程图片在普通模式保留 URL；standalone 模式会报错，须先下载到本地。已有 `data:` 图片原样保留。

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

## D3 可视化（viz）

在独立段落中使用完整标签。路径相对于 Markdown 文件，必须在 `--root` 内；`caption` 为纯文本图注，复用正文 `figcaption` 样式：

```html
<viz src="charts/sales.js" width="75%" caption="销售分布"></viz>

<mermaid src="charts/flow.mmd" width="520px" caption="处理流程"></mermaid>

<mermaid caption="内联流程">
flowchart LR
  A --> B
</mermaid>
```

`width` 和 `caption` 可省略，默认最大宽度为 640px；宽度支持 1–100 的整数百分比或 1–10000 的整数像素值。Mermaid 的 `src` 与标签内源码二选一。标签必须独占一个 Markdown 段落，属性值使用引号，特殊字符使用 HTML/XML 实体。旧 `viz` 代码块继续可用；旧 `mermaid` 代码块继续渲染，并在标准错误输出带位置的弃用警告。

随包附带的英文 [AGENTS.md](AGENTS.md) 包含供编码代理遵循的精简约定。JS 文件使用标准 ES 模块，只可导入内置 `d3`，默认导出同步绘图函数：

```js
import * as d3 from 'd3';

export default function render(container) {
  const svg = d3.select(container).append('svg').attr('viewBox', '0 0 640 200');
  svg.append('circle').attr('class', 'mark').attr('cx', 320).attr('cy', 100).attr('r', 32);
}

export function hydrate(container) {
  d3.select(container).select('circle')
    .on('click', function () { d3.select(this).attr('r', 48); });
}
```

编译时在内嵌 QuickJS + LinkeDOM 中执行模块，把生成的 SVG / HTML 直接写入结果。没有 `hydrate` 导出时，`viz` 只包含绘图结果，不嵌入原始 JS 或 D3。导出 `hydrate(container)` 时会自动启用交互：预渲染结果并内嵌绘图模块的 data URL；浏览器使用共享 D3 直接对预渲染结果调用 `hydrate` 初始化事件，不重复绘图。共享的 `viz.js` 按内容版本存放在上述资源目录，不复制用户 JS 文件，不依赖 CDN。`--standalone` 则将 D3 一并内嵌。事件处理器无法保存在静态 SVG 中，因此交互模式必须保留绘图模块代码。

绘图函数应仅向传入的容器添加内容。使用固定 `viewBox` 和显式尺寸，不依赖编译时的屏幕宽度、布局测量、Canvas、网络、计时器、动画或浏览器全局变量。异步默认函数会报错。需要 zoom、drag、动画等浏览器 API 时，可另导出 `hydrate(container)`，仅在浏览器端调用，导出后自动启用交互。序列化后的 SVG 不保留 D3 绑定的 `__data__`，如事件回调需要数据，应在 `hydrate` 中重新绑定数据。数据直接写在模块内；暂不支持其他文件导入、npm 包或远程模块。每个图表的容器 ID 为 `viz-<节点编号>`，内部 SVG ID 应以容器 ID 为前缀以避免重复。

独立的 D3 样式表提供字体、坐标轴、网格和常用图形基元，以及低调数据色和强调色；复杂图形的几何与局部样式留给各图表脚本定义。[examples/viz/note.md](examples/viz/note.md) 展示箱型图、柱状图、环形图、折线图、瀑布图、散点图、热力图、环形堆叠图、桑基图、小提琴图和等值线图。

只对可信的本地绘图模块使用交互模式：它会作为页面脚本执行。编译错误定位到 Markdown 的 `viz` 块，并保留已有输出。请在实际浏览器验证本地共享 D3 加载、事件与键盘操作、暗色主题及打印；这些浏览器场景不属于代理的静态与单元测试范围。
