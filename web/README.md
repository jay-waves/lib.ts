# Library 使用与接口

启动和配置见 [根 README](../README.md)。前端入口为 `web/main.jsx`，服务由 Rust 后端提供。

## 使用

- Files 浏览文件，Bookmarks 通过独立侧边栏图标浏览书签，顶部复用搜索组件，按文件名和路径筛选，不读取或修改 Files 搜索词。Symbols 导航标题或 PDF 书签，Repos 切换和添加仓库。文件菜单负责添加和删除书签。
- Preview / Raw 切换预览和源码。Markdown、Typst 按源行恢复位置；PDF 按页和页内坐标恢复。Typst 行号映射为稀疏采样，位置可能有偏差。
- Markdown 脚注点击正文编号后在当前段落下方展开，复用引用块的竖线、缩进和颜色，`[1]` 位于首段正文开头并与列表项文字左对齐；再次点击编号收起。点击脚注开头的 `[1]` 收起内容并将焦点返回打开它的引用，仅在引用不可见时滚动。同段重复引用共用一块脚注，不同段落独立展开；表格内的脚注放在表格下方。
- PDF / Typst 支持中键拖动、触摸平移和双指缩放；Ctrl/Meta + 滚轮围绕鼠标缩放，聚焦后可用加号、减号和零调整或重置。
- Search 默认不选范围，全文搜索当前仓库；Scope 可选 Files、Bookmarks（按文件名和路径筛选）或 Symbols（筛选当前文档大纲并可跳转），再次点击选中项取消范围；Languages 和 Paths 可与全文搜索组合。书签的文件集合在搜索开始时确定，翻页期间保持不变；修改集合后重新搜索即可更新。Files 内的书签展示与 Search 输入独立。普通文本不区分大小写；支持 `lang:js`（也兼容 `language:js`）、`path:src/`、`case:yes` 和 `/TODO|FIXME/i`。路径支持 `*`、`**`、`?`；引用路径按字面匹配。正则按行执行，只支持 `i` 标志。

已知路径导航复用目录树。后端只为有页面订阅的仓库监听变化，同仓库页面共享监听，最后一个连接关闭后释放；隐藏目录、`node_modules` 和应用数据被排除。变化通过 SSE 更新文件树，不刷新整页。重连、重新聚焦和 Files 刷新按钮会重新同步。

当前文档和引用资源另行监听。目录树更新不等于所有 Typst 依赖都重新编译；只修改 import/include 时的失效机制仍需完善。

Files 顶部工具栏的 Recent Files（历史图标）切换最近浏览列表，与 Bookmarks 过滤互斥，不改变原来的搜索词或修改时间排序。Bookmarks 恢复普通 Files 目录层级。History 按最后浏览时间显示可展开的 `Past Week`（不足 7 天）、`Past Month`（7–30 天）、`Past 6 Months`（30–183 天）、`Older` 分组；无浏览时间的旧历史不保留，不提供 Unknown Date 分组。每个文件只出现在一个分组内，组内按最近浏览顺序排列，空分组不显示；文件路径不显示悬停提示；点击复用已有阅读位置与浏览器导航。重复浏览置顶，超过 100 条移除最旧路径，按仓库隔离；只有成功打开的前台文档记录浏览，后台重载不更新顺序。不提供删除或清空按钮。Files 默认显示工具栏，只有点击搜索按钮才展开搜索框，滚动不切换；按 Escape 或点击关闭按钮退出搜索并恢复工具栏；Recent / Bookmarks 过滤时保持工具栏，按钮排列一致，暂不适用的操作禁用；搜索按钮退出过滤并展开搜索框。旧阅读数据保持兼容，从功能启用后开始积累浏览顺序。

Bookmarks 以单行相对路径（如 `xxx/yyy/xxx.md`）显示文件，前面显示文件类型图标，当前选中项显示选中背景，不提供删除按钮；长路径从前面省略以优先显示文件名，点击打开文件，添加和删除书签使用文件菜单。History 的时间文件夹只是显示分组，不导航到实际目录；默认展开，可单独折叠或使用工具栏折叠全部。

## 数据与链接

Search 的 Current File 范围只搜索当前文件的正文，支持正则及行号跳转。搜索 URL 使用 `scope=current-file&file=...` 保存文件上下文。Languages 默认显示 5 项，其余可展开查看。

应用数据位于 `LIBRARY_DATA_DIRECTORY` 或默认 `data/`：

- `repos.json`：仓库注册和书签，使用稳定仓库 ID。
- `reading/<仓库 ID>.json`：统一的 `files` 数组，每条只保存一次 `path`，同时包含 `lastVisitedAt` 和 `position`（阅读位置、视图、缩放）。每仓库最多 100 条，最新浏览在前；淘汰文件同时删除其阅读位置，不额外豁免 Bookmarks。

浏览器阅读位置缓存和待发送队列最多 100 条，每 2 秒合并同步到服务端，仓库切换及退出时也同步（退出使用 keepalive）。服务端阅读位置与浏览历史共用按仓库隔离的内存缓存，每仓库文件只在首次访问时读取；首次变更起 2 秒内合并落盘，持续浏览不会无限推迟保存。文件以临时文件加重命名原子替换，写入失败保留脏状态并重试，写入期间的新更新留待下一轮。服务器正常退出会等待未保存变化落盘；异常退出可能丢失最后几秒的变化。滚动更新位置不会改变浏览时间或 History 顺序，迟到的保存批次不会让已淘汰文件重新占用满额缓存。

仓库页面为 `/:repoName/tree/`，文档为 `/:repoName/tree/path/to/file.md`；`:repoName` 为 URL 编码后的根目录名，同名根目录不能重复注册，`api` 和 `assets` 是保留名称。行号链接可附加 `?line=12#L12`。旧页面地址不再提供服务。

搜索页面为 `/:repoName/search?q=...`，Git diff 页面为 `/:repoName/git?path=...&scope=staged`。页面地址可直接打开，并支持浏览器前进、后退。

## 主题

前端面向现代浏览器，使用 React 19 的 ref 属性、`use` / `Suspense`、`useSyncExternalStore` 和 CSS `light-dark()`，不维护旧浏览器兼容分支。

应用界面使用 Tailwind CSS 4 和官方 Vite 插件，组件直接组合工具类，不再使用 CSS Modules。`tailwind.css` 集中定义 UI 主题和共享工具类：`text-ui` 为 12px，`text-meta` 为 12px，应用默认文字及 Primer 的正文/菜单字号统一引用这两个变量（文档渲染保留独立字号）；`rounded-ui` 为 6px，`min-h-row` 为 32px；颜色直接使用 Primer 的主题变量。重复的侧栏布局使用 `sidebar-scroll`、`sidebar-search`、`sidebar-empty`、`sidebar-loading`，文档和 Git diff 工具栏复用 `ui-toolbar`。面板外观复用 `ui-panel` / `sidebar-panel`，预览 Tab 复用 `ui-tab`，搜索筛选复用 `search-facet`、`search-facet-title` 和 `search-facet-label`。桌面与移动抽屉共用 `SidebarRail`。新样式优先使用这些公共规则，避免另写近似字号和间距；侧栏排版直接引用 Tailwind 主题，不额外建立同值变量别名。

只加载 Tailwind 的 theme 和 utilities，不启用 Preflight，以保留 Primer 和文档内容的默认样式。Primer 控件自身的外观优先沿用组件；确需覆盖时局部使用 `!` 工具类，不全局启用 important。工具类必须以完整字符串出现在源码中，动态值继续通过内联样式传入。`style.css` 保留页面响应式结构、通用状态、动画和阅读布局接口；`sidebar.css` 集中维护 Primer TreeView / ActionList 的选中、焦点和折叠适配。Markdown、源码和分页预览保留各自渲染 CSS，搜索 CSS 仅处理生成的代码高亮内容。

阅读区域通过 `--content-width` 提供公共内容宽度，工具栏用容器查询适配实际可用宽度。新样式使用原生 CSS 嵌套和逻辑属性，构建目标为 `esnext`。`.file-toolbar`、`.document-page[data-page]` 和源码行号等少数标记是阅读定位接口；视觉样式类可以独立修改。PDF 自行定义加载提示，不依赖 Typst 样式；三种分页预览只共用视口和页面基础外观。

`@primer/react/next` 的 `ThemeProvider colorMode="auto" contextOnly` 负责系统主题状态，文档请求从官方 `useTheme()` 读取 `colorScheme`。Primer 的主题属性放在 `<html>`，页面、菜单和弹层直接继承官方 CSS 变量。`theme.css` 只保留必要的配色定制；Markdown 和代码高亮在各自样式文件中用 `light-dark()` 定义颜色，不再维护应用变量到 Primer 的映射。

HTML head 内联一条画布背景规则，在脚本及样式加载前提供正确底色，无构建插件或主题启动脚本。文件树使用公开属性、应用自己的类名和 `aria-current` 标记，加载指示器采用官方实现。

`web/image-theme.css` 定义暗色图片亮度策略，通过预览容器的 `data-dim-images` 显式启用。图片和 Markdown 共用该文件，悬停恢复原始滤镜；PDF、Typst 不启用。Rust HTML 响应通过 `include_str!` 内联同一份样式，浏览器入口直接导入。

## 前端阅读架构

`main.jsx` 负责仓库、文件路由、侧栏和页面外壳，`use-document.ts` 负责文档请求、取消、内容完整性检查和版本复用；页面只提交带文件路径的阅读请求（行号、视图或目录项），不控制位置恢复时序。`Reader` 是 Markdown、Typst、PDF、图片和源码的组合入口。外层通过 Reader 的 ref 调用 `capture`、`switchView`、`fit` 和 `toTop`，通过 `onActivity` 接收阅读状态及实际滚动位置以更新路径栏和行号。

`document-toolbar.tsx` 独立管理文件操作菜单和复制反馈，`directory-view.tsx` 管理目录操作并用 React 表单 Action 处理打开目录的异步状态，`symbols-panel.tsx` 管理符号筛选及选中项定位。`file-tree-view.tsx` 封装递归渲染，展开状态仍由页面控制以协调导航和历史视图；递归过程中不再逐层传递相同参数，也不增加树专用 Context。这些功能组件直接使用本地状态，不共用通用业务控制器。

Git 分组使用原生 `<details>` / `<summary>`，折叠由浏览器管理，不再额外同步 React 展开状态。侧栏设置统一保存到仓库对应的状态条目，不再同时写入旧的全局宽度缓存。

`useReaderSession` 统一持有视图和缩放，加载并保存阅读位置，协调初始恢复、视图切换、目录跳转和 Typst 内部链接。导航只保留最新请求，内容未加载时等待重试，隐藏时暂停调度；恢复完成前不保存中间位置。`useReaderTracking` 负责滚动、尺寸变化、保存节流及隐藏/退出时同步；`useReaderWatch` 负责文档和附件更新。Reader 不再自行实现这些时序。

渲染器通过局部 `ReaderContext` 读取阅读状态，不跨层转发 controller、prepared HTML 或附件版本。Markdown 保留普通滚动和文本选择；分页文档及图片由 `DocumentPreview` 提供布局和滚动容器，`useDocumentViewport` 处理适配、手势和缩放坐标补偿。所有页面使用 `.document-page[data-page]` 标记，通用视口不依赖具体格式的 class。图片初始大小不超过原始尺寸或视口宽度的 80%；PDF、Typst 保持自动适配。

源码和搜索结果先显示完整文本及匹配标记，再通过共享的动态 import 加载代码高亮引擎。`Suspense` 只包围高亮内容，行号、阅读位置和结果卡片保持挂载；浏览目录或 Markdown 不下载前端高亮引擎。工作区搜索的路径集合和目录建议按目录树及筛选条件缓存，阅读状态更新不会重复遍历和排序整个仓库。

## 常用 API

URL、查询语法、Git 变更分组和浏览器字节缓存分别放在 `web/paths.ts`、`web/search-query.ts`、`web/git-changes.ts` 和 `web/byte-cache.ts`。阅读策略常量由 `reading-state.mjs` 就地管理，PDF 渲染策略和 Typst 请求合并分别放在 `pdf/render.ts` 和 `typst/request-flight.ts`。模块直接导入所需文件，不设统一导出层。普通文本正文使用 `source` 字段。服务端资源预算和队列上限见 [CODE_REVIEW.md](../CODE_REVIEW.md)。

前端正在逐步迁移到 TypeScript 7（Go 原生编译器）。运行 `npm run typecheck` 检查已迁移模块；新增 TS/TSX 模块应纳入 `tsconfig.json` 检查范围。`web/api/contracts.ts` 维护 API 和 SSE 的 Zod schema，`web/api/library.ts` 集中封装文件树与书签接口；最近浏览客户端也使用同一 JSON 校验层。文档请求与文档变化订阅集中在 `web/api/documents.ts`，按 `type` 校验各格式响应；Reader 使用同一 SSE 校验层。已接入的网络响应和 SSE 载荷在运行时校验，阅读状态与外部打开命令仍待迁移。

仓库 API 前缀为 `/:repoName/api`。路径相对仓库根目录，查询参数需 URL 编码。`/api` 为全局接口，`/assets` 为应用静态资源。Rust 分别声明全局与仓库路由，仓库文档、树、搜索及租约接口仅在 `/:repoName/api` 提供；不再把仓库接口隐式挂到全局默认仓库。文档元数据、源码加载和预览编译由 `src/documents.rs` 管理。

| 方法与路径（相对于前缀） | 用途 |
| --- | --- |
| `GET /tree` | 文件树 |
| `GET /document?path=...` | 文档元数据及预览内容 |
| `GET /asset?path=...` | 原文件或附件 |
| `GET /library/tree-events` | 文件树变更 SSE |
| `GET /library/events?path=...` | 当前文档及资源变更 SSE |
| `GET /typst/page?id=...&page=...` | SVG；`format=json` 返回 SVG 和链接区域 |
| `GET /pdf/page?path=...&page=...` | PDF 页面 SVG |
| `GET /search?q=...` | 默认搜索整个仓库正文；可选 `scope=files/bookmarks/current-file` 限定范围，支持筛选和 `offset`，后续页携带 `searchId` |
| `POST /library/session-leases` | 按浏览器页面保活当前文档；30 秒续约，90 秒失联后解除 |
| `GET /recent-files` | `{ "recent": ["note.md"], "visitedAt": { "note.md": "ISO 时间" } }` 最近浏览路径和时间 |
| `POST /recent-files` | `{ "path": "note.md" }` 浏览置顶，最多 100 条 |
| `DELETE /recent-files` | JSON 请求，清空最近路径，保留阅读位置 |
| `GET /bookmarks` | 书签列表 |
| `PUT /bookmarks` | `{ "path": "note.md", "bookmarked": true }` 添加，false 删除 |

搜索分页使用稳定快照；快照到期或预算淘汰后需要重新搜索，不应混合新旧页。搜索排除隐藏项、符号链接、依赖目录和二进制文件，不使用 Git ignore 规则。

全局接口：`GET /api/repos` 列出仓库；`POST /api/repos` 使用 `{ "root": "E:/notes", "name": "Notes" }` 注册目录。注册优先使用绝对路径。

外部程序可调用 `POST /api/library/open`：

```json
{ "repo": "notes", "path": "docs/example.typ", "line": 42, "view": "preview" }
```

也可传入 `{ "file": "E:/notes/docs/example.typ" }`。服务优先复用同仓库页面；返回 `{ "reused": false, "url": "..." }` 时，调用方打开该 URL。未指定 view 时，有 line 使用 Raw，否则使用 Preview。文件必须属于已注册仓库。

- 使用浏览器原生多标签页；每页独立导航与会话，隐藏时暂停观察器和 SSE，恢复时同步文件变化。后台页通过轻量心跳保留共享 PDF / Typst 资源，关闭页释放租约，崩溃后租约自动到期。服务端共享文件监听、编译缓存及进行中的请求。

Bookmarks 和 Git 文件列表的长路径均从前面省略（如 `…/docs/note.md`），短路径保持左对齐；Git 重命名项悬停显示原路径和新路径。

侧栏导航的视觉规则集中在 `sidebar.css`：Search、Files/History、Bookmarks、Git、Symbols、Repos 使用相同的 8px 外边距、至少 32px 行高、6px 圆角和选中背景；所有侧栏选中项使用背景与文字强调，不显示左侧竖线。ActionList 使用 full 布局，避免组件默认边距叠加；Symbols 只缩进文字，选中背景不随层级移动。Primer TreeView 的行容器适配集中维护，升级组件库时检查行容器结构。长路径的前面省略共用 `sidebar-path`，文字使用 `bdi` 保持路径顺序。浅色主题的输入焦点边框和焦点环与强调色一致。

左侧导航按钮及其悬停、选中背景统一为 40px × 40px，图标栏宽度包含左右各 4px 内边距及 1px 分隔线，桌面与窄屏抽屉共用此规格。Repos 的仓库列表按添加时间从底部向上固定排列，最早添加的仓库显示在最下方，切换仓库不会因最近使用时间更新而移动列表项；Add repository 紧接在整组仓库上方，随列表一起靠底部堆叠。内容过长时整组可滚动。Repos 使用 16px 图标列和 12px 单行绝对路径，不另外显示仓库名；添加仓库按钮使用相同图标列和行内间距。目录选择对话框使用平铺目录行与轻量分隔线；路径导航与主页面共用 `PathBar`，支持点击各级目录及长路径折叠菜单，不单独提供返回上级按钮。`directoryPathSegments` 使用服务端 hostname 标识本机：Linux 对应 `/`，Windows 对应列举盘符的虚拟根目录（此时不能添加仓库）；UNC 路径显示 `server / share / …`，服务器名仅展示，共享根及后续目录可点击。目录接口返回 `hostname` 和 `rootPath`，请求 `root=true` 进入本机根入口。应用不显示 Tooltip 或原生 title 悬停提示；图标按钮保留 aria-label，并关闭 Primer 默认 Tooltip。对话框支持长名称省略、窄屏底栏换行。UI 验证需覆盖浅色/深色、键盘焦点、窄侧栏/移动抽屉、深层目录/大纲、长仓库名和路径，以及选中项悬停时背景的稳定性。

侧栏搜索框与列表选中项统一为 32px 高、6px 圆角，左右均留 8px；搜索区上下留 8px，使输入框中心与左侧首个导航按钮对齐。Files、Preview/Raw、Git diff 和目录工具栏统一至少 40px 高；输入文字与占位提示均为 12px。搜索筛选标题和子项均为 12px。Git 与 Repos 不显示顶部标题栏，第一项中心距侧栏顶部 24px，与左侧首个导航按钮对齐；Repos 使用 `pt-sidebar-top`（8px），Git 在滚动区默认 4px 顶部间距外补 4px。文档、目录和 Git diff 工具栏统一按钮间距与窄屏左右留白；极窄阅读区域允许工具栏和目录修改时间换行，长文件名提供省略与悬停提示。
