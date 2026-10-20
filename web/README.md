# 使用说明

启动、配置和打包见 [根 README](../README.md)。

## 浏览与阅读

- **Files**：浏览目录；顶部提供最近浏览、折叠、定位当前文件、排序和搜索入口。点击搜索图标直接打开 Search 页面。
- **Bookmarks**：按路径查找书签。通过文件菜单按当前阅读位置添加或删除书签；文本使用行号，PDF 和图片使用页内位置。旧文件书签视为首行。
- **Symbols**：跳转当前文档标题、PDF 书签或代码定义行。代码支持 Rust、JavaScript/TypeScript（含 JSX/TSX）、Python、Go、Java、C/C++、Lua、Shell（Bash/sh/zsh），仅列出当前文件定义。
- **Repos**：切换仓库，或通过 Add repository 添加目录。
- **Git**：查看暂存、未暂存及其他变更，点击文件查看 diff。

Preview / Raw 切换预览与源码，并尽量恢复对应阅读位置。Typst 源行定位可能存在偏差。Markdown 脚注可点击展开，再次点击收起。

PDF、Typst 和图片支持中键拖动、触摸平移、双指缩放，以及 Ctrl/Meta + 滚轮缩放。阅读区域聚焦后可用 `+`、`-`、`0` 调整或重置视图。

支持浏览器多标签页、前进与后退，以及直接分享文件、搜索和 Git 页面地址。最近浏览和阅读位置按仓库保存，最多保留 100 个文件。

目录菜单的 Show hidden files、Show gallery、Include subdirectories、Autoplay videos 和 Adjusted height 按仓库统一保存；排序、缩略图缩放和滚动位置按目录独立记忆，保存在当前浏览器中。新目录默认按名称升序，列表始终将文件夹排在文件前面。

Show hidden files 默认关闭，开启后内容列表和侧栏同步显示隐藏项。仍遵守忽略规则，并排除 `.git`、`node_modules` 和应用私有数据目录。

## 搜索

Search 默认搜索当前仓库正文。Files 范围按文件路径搜索，通过后端快照每批加载 20 个文件，展开目录后滚动到底部继续加载，也可点击加载更多；最多保留 20,000 个结果或 2 MiB 快照，达到上限时提示缩小范围。使用可折叠文件树展示已加载结果，无搜索条件时目录默认折叠，有搜索条件时自动展开匹配目录；点击目录展开或折叠，点击文件打开。Scope 可限定 Files、Bookmarks、Symbols 或 Current File；Languages、Paths 可进一步筛选。

正文和文件搜索都先应用语言、路径过滤，再收集结果；侧栏计数表示当前过滤结果。普通 `path:src/` 按子串匹配，含 `*`、`**`、`?` 的路径使用 ripgrep 的 glob 匹配器；带空格或需要字面匹配的路径可写为 `path:"My Docs/"`。多个过滤条件取交集。

搜索遵守 `.gitignore`、`.ignore` 和 `.rgignore`；`gitignore:no` 仅关闭 Git 忽略规则，隐藏文件和固定排除目录仍会跳过。翻页保持初次搜索时的结果；快照失效后点击“Search again”重新搜索。当前仅支持单仓库搜索。

示例：

```text
TODO
TODO lang:js path:src/
TODO case:yes
/TODO|FIXME/i
TODO gitignore:no
```

默认忽略 Git 忽略的文件，`gitignore:no` 可包含这些文件。隐藏项、依赖目录、应用数据和二进制文件仍被排除。路径支持 `*`、`**`、`?`，正则按行匹配。搜索结果快照过期后需重新搜索。

## 主题与预览

界面跟随系统浅色／深色主题。Typst 文档可通过以下输入适配主题：

```typst
#let theme = sys.inputs.at("theme", default: "light")
```

HTML 支持脚本和仓库内相对资源，但隔离预览会限制外部网络、弹窗等能力；依赖这些能力的页面可能无法正常运行。

文件保存后自动更新预览。Typst 的 import/include 依赖文件单独变化时，自动更新仍有局限。HTML 预览内部的滚动位置暂不保存。

Mermaid 图表使用 Pele 按图表类型懒加载渲染。Markdown 的 `mermaid` 代码块与独立 `.mmd` 文件共用 `diagrams/` 渲染模块；Markdown 适配器位于 `markdown/diagrams.mjs`，主题配置集中在 `diagrams/diagram.css`。`.mmd` 支持 Preview / Raw 切换；图表支持缩放和平移，颜色跟随应用主题。保持源码指定的布局方向，不自动改为纵向。Pele 使用自己的布局，不支持任意 HTML 标签及 JavaScript 回调。

## 前端目录约定

核心组件和公共样式放在 `web/` 根目录：入口、文件树、目录页、文档加载、阅读器、工具栏、路由、会话和通用工具。相对独立的功能才归入子目录，专属样式与功能代码放在一起。

| 目录 | 职责 |
| --- | --- |
| `api/` | HTTP/SSE 接口及运行时数据契约 |
| `gallery/` | 画廊布局、图片配对、批量元信息与缩放 |
| `markdown/`、`raw/` | Markdown 渲染增强；源码阅读和语法高亮 |
| `pdf/`、`typst/`、`diagrams/` | 各格式的渲染和专属样式 |
| `media/`、`video/` | 图片与媒体资源、元信息；视频播放器 |
| `search/`、`symbols/` | 搜索；大纲和符号导航 |
| `bookmarks/`、`history/`、`git/` | 书签、历史和 Git 功能 |
| `fonts/` | 字体资源 |

主题变量统一使用 kebab-case。根目录的 `primer.css` 集中导入 Primer 调色板、覆盖其默认值，并处理组件适配；只有此文件使用 Primer 的 camelCase 变量。业务 CSS 和 JSX 使用 `--color-text`、`--color-bg`、`--color-border-default`、`--font-body` 等应用变量。`theme.css` 定义应用自己的字体和阴影，`tailwind.css` 将应用变量映射到工具类，`style.css` 和 `ui.css` 提供公共布局与 UI 规则。各功能的专属样式放在功能目录，例如 `diagrams/diagram.css` 和 `git/theme.css`。

移动文件时同步更新单元测试导入，以及 Rust 的 `include_str!`、构建缓存等引用。`media/image-theme.css` 同时供应用和隔离 HTML 预览使用，不依赖应用主题变量。
