# Library 使用与接口

启动和配置见 [根 README](../README.md)。服务入口为 `server-node.mjs`，前端入口为 `library/main.jsx`。

## 使用

- Files 浏览文件，Bookmarks 通过独立侧边栏图标浏览书签，顶部复用搜索组件，按文件名和路径筛选，不读取或修改 Files 搜索词。Symbols 导航标题或 PDF 书签，Repos 切换和添加仓库。文件菜单负责添加和删除书签。
- Preview / Raw 切换预览和源码。Markdown、Typst 按源行恢复位置；PDF 按页和页内坐标恢复。Typst 行号映射为稀疏采样，位置可能有偏差。
- PDF / Typst 支持中键拖动、触摸平移和双指缩放；Ctrl/Meta + 滚轮围绕鼠标缩放，聚焦后可用加号、减号和零调整或重置。
- Search 默认不选范围，全文搜索当前仓库；Scope 可选 Files、Bookmarks（按文件名和路径筛选）或 Symbols（筛选当前文档大纲并可跳转），再次点击选中项取消范围；Languages 和 Paths 可与全文搜索组合。书签的文件集合在搜索开始时确定，翻页期间保持不变；修改集合后重新搜索即可更新。Files 内的书签展示与 Search 输入独立。普通文本不区分大小写；支持 `lang:js`（也兼容 `language:js`）、`path:src/`、`case:yes` 和 `/TODO|FIXME/i`。路径支持 `*`、`**`、`?`；引用路径按字面匹配。正则按行执行，只支持 `i` 标志。

已知路径导航复用目录树。后端只为有页面订阅的仓库监听变化，同仓库页面共享监听，最后一个连接关闭后释放；隐藏目录、`node_modules` 和应用数据被排除。变化通过 SSE 更新文件树，不刷新整页。重连、重新聚焦和 Files 刷新按钮会重新同步。

当前文档和引用资源另行监听。目录树更新不等于所有 Typst 依赖都重新编译；只修改 import/include 时的失效机制仍需完善。

Files 顶部工具栏的 Recent Files（历史图标）切换最近浏览列表，与 Bookmarks 过滤互斥，不改变原来的搜索词或修改时间排序。Bookmarks 恢复普通 Files 目录层级。History 按最后浏览时间显示可展开的 `Past Week`（不足 7 天）、`Past Month`（7–30 天）、`Past 6 Months`（30–183 天）、`Older` 分组；无浏览时间的旧历史不保留，不提供 Unknown Date 分组。每个文件只出现在一个分组内，组内按最近浏览顺序排列，空分组不显示；文件路径使用下方 Primer Tooltip 展示；点击复用已有阅读位置与浏览器导航。重复浏览置顶，超过 100 条移除最旧路径，按仓库隔离；只有成功打开的前台文档记录浏览，后台重载不更新顺序。不提供删除或清空按钮。Files 默认显示工具栏，只有点击搜索按钮才展开搜索框，滚动不切换；按 Escape 或点击关闭按钮退出搜索并恢复工具栏；Recent / Bookmarks 过滤时保持工具栏，按钮排列一致，暂不适用的操作禁用；搜索按钮退出过滤并展开搜索框。旧阅读数据保持兼容，从功能启用后开始积累浏览顺序。

Bookmarks 保留书签文件及其真实父目录，不合并目录，默认全部展开，每次进入 Bookmarks 重新展开；可手动折叠，不改变普通 Files 的展开状态。History 的时间文件夹只是显示分组，不导航到实际目录；默认展开，可单独折叠或使用工具栏折叠全部。

## 数据与链接

Search 的 Current File 范围只搜索当前文件的正文，支持正则及行号跳转。搜索 URL 使用 `scope=current-file&file=...` 保存文件上下文。Languages 默认显示 5 项，其余可展开查看。

应用数据位于 `LIBRARY_DATA_DIRECTORY` 或默认 `data/`：

- `repos.json`：仓库注册和书签，使用稳定仓库 ID。
- `reading/<仓库 ID>.json`：统一的 `files` 数组，每条只保存一次 `path`，同时包含 `lastVisitedAt` 和 `position`（阅读位置、视图、缩放）。每仓库最多 100 条，最新浏览在前；淘汰文件同时删除其阅读位置，不额外豁免 Bookmarks。

浏览器阅读位置缓存和待发送队列最多 100 条，每 2 秒合并同步到服务端，仓库切换及退出时也同步（退出使用 keepalive）。服务端阅读位置与浏览历史共用按仓库隔离的内存缓存，每仓库文件只在首次访问时读取；首次变更起 2 秒内合并落盘，持续浏览不会无限推迟保存。文件以临时文件加重命名原子替换，写入失败保留脏状态并重试，写入期间的新更新留待下一轮。服务器正常退出会等待未保存变化落盘；异常退出可能丢失最后几秒的变化。滚动更新位置不会改变浏览时间或 History 顺序，迟到的保存批次不会让已淘汰文件重新占用满额缓存。

仓库页面为 `/:repoName/tree/`，文档为 `/:repoName/tree/path/to/file.md`；`:repoName` 为 URL 编码后的根目录名，同名根目录不能重复注册，`api` 和 `assets` 是保留名称。行号链接可附加 `?line=12#L12`。旧页面地址不再提供服务。

搜索页面为 `/:repoName/search?q=...`，Git diff 页面为 `/:repoName/git?path=...&scope=staged`。页面地址可直接打开，并支持浏览器前进、后退。

## 常用 API

仓库 API 前缀为 `/:repoName/api`。路径相对仓库根目录，查询参数需 URL 编码。`/api` 为全局接口，`/assets` 为应用静态资源。

| 方法与路径（相对于前缀） | 用途 |
| --- | --- |
| `GET /tree` | 文件树 |
| `GET /document?path=...` | 文档元数据及预览内容 |
| `GET /asset?path=...` | 原文件或附件 |
| `GET /library/tree-events` | 文件树变更 SSE |
| `GET /library/events?path=...` | 当前文档及资源变更 SSE |
| `GET /typst/page?id=...&page=...` | SVG；`format=json` 返回 SVG 和链接区域 |
| `GET /pdf/page?path=...&page=...` | PDF 页面 WebP |
| `GET /search?q=...` | `scope=files/bookmarks` 单选全文搜索；支持筛选和 `offset`，后续页携带 `searchId` |
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
