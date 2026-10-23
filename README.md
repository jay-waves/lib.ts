# Saved notes library

本地 Markdown、Typst、PDF、HTML 和源码浏览器。通过侧栏管理多个目录，保存书签和阅读位置，文件保存后自动更新预览。

## 启动

从源码运行需要 Rust/Cargo、Node.js 和 npm：

```sh
npm ci
npm run build
npm run serve -- /path/to/notes
```

Windows 路径可用 `E:/notes`。打开 <http://127.0.0.1:49191/>；实际地址以启动日志为准。不传目录时恢复已注册仓库，首次使用可在 Repos 中添加目录。

使用说明见 [web/README.md](web/README.md)。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `PREVIEW_PORT`（兼容 `NODE_PREVIEW_PORT`） | 端口，默认 `49191` |
| `PREVIEW_BIND_ADDRESS` | 监听地址，默认 `127.0.0.1` |
| `PREVIEW_PUBLIC_URL` | 对外访问地址；局域网或反向代理访问时设置 |
| `LIBRARY_DATA_DIRECTORY` | 数据目录，默认 `data/` |
| `TYPST_FONTS` | 自定义 Typst 字体目录或文件路径列表，使用系统路径分隔符 |
| `RUST_LOG` | 日志级别，默认 `info` |

仓库注册、书签和文件访问历史保存在数据目录，笔记留在原目录；阅读位置仅保存在当前浏览器。升级时保留数据目录，迁移后确保仓库路径仍有效。同一数据目录只运行一个服务进程。

字体和许可证随应用分发，无需字体 CDN。Typst 包可能需要首次联网下载；本地包需自行安装。源码定义导航使用的 tree-sitter 语法库默认也会在服务端按需下载并缓存在本机；首次使用某种语言可能需要联网，未缓存且下载失败时仍可阅读源码，但没有定义导航。

## 局域网与反向代理

本机默认允许 `localhost`、其子域（例如 `lib.localhost`）、回环 IP 和本机主机名；请求的 Origin 仍需与 Host 的主机名、端口及配置的协议一致。

将监听地址设为 `0.0.0.0`，并设置 `PREVIEW_PUBLIC_URL`。在数据目录的 `access.json` 中加入访问使用的主机名或 IP，修改后重启：

```json
{ "allowedHosts": ["192.168.0.163", "notes.lan"] }
```

条目不含协议、端口或路径。HTTPS 反向代理需设置 HTTPS 公共地址，并保留原始 Host。应用没有用户登录认证，仓库内容只应向可信网络开放。

## 从外部程序打开文件

文件必须位于已注册仓库中：

```sh
curl -X POST http://127.0.0.1:49191/api/library/open \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:49191' \
  -d '{"file":"E:/notes/docs/guide.md","line":20,"view":"raw"}'
```

`line` 和 `view` 可省略。服务优先复用已有页面，否则在服务所在机器打开浏览器。使用其他访问地址时，相应调整请求 URL 和 Origin。

## 支持的格式

### 文档与文本预览

| 格式 | 扩展名示例 | 预览能力 |
| --- | --- | --- |
| Markdown | `.md`、`.markdown` | 排版预览、公式、Mermaid 图表，可切换源码 |
| Typst | `.typ` | 编译排版、目录导航，可切换源码；支持自定义字体 |
| PDF | `.pdf` | 分页阅读、目录导航、缩放 |
| HTML | `.html`、`.htm` | 隔离页面预览，可切换源码；支持脚本和仓库内相对资源，外部网络等能力受限 |
| Mermaid | `.mmd` | 图表预览、缩放和平移，可切换源码 |
| 源码与配置 | `.rs`、`.ts`、`.tsx`、`.js`、`.py`、`.go`、`.json`、`.yaml` 等 | 文本阅读；已支持的语言提供语法高亮，部分语言提供定义导航 |
| 其他纯文本 | `.txt`、`.log`、无扩展名文件等 | UTF-8 文本阅读，不限于固定扩展名 |

文本源码最大 16 MiB。非 UTF-8 或二进制文件不作为普通文本预览。Typst 包首次使用可能需要联网；HTML 页面和 Typst 依赖更新的限制见[使用说明](web/README.md#主题与预览)。

### 图像格式

| 格式 | 扩展名 | 支持情况与要求 |
| --- | --- | --- |
| JPEG、PNG、GIF、WebP、BMP、ICO | `.jpg`、`.jpeg`、`.jfif`、`.png`、`.gif`、`.webp`、`.bmp`、`.ico` | 可预览；大图自动生成缩略图，实际显示能力取决于浏览器 |
| APNG | `.apng` | 动画显示取决于浏览器；画廊缩略图可能为静态 |
| AVIF | `.avif` | 画廊尺寸和缩略图需要支持 AVIF/AV1 的 FFmpeg、FFprobe；完整原图由浏览器显示 |
| HEIC / HEIF | `.heic`、`.heif` | 需要支持 HEVC 的 FFmpeg、FFprobe；建议 FFmpeg 8.1 或更新版本，原文件保持不变 |
| SVG | `.svg` | 由浏览器显示；画廊可能使用默认卡片比例 |
| TIFF、JPEG XL | `.tif`、`.tiff`、`.jxl` | 可列入画廊，预览取决于浏览器；目前不提供后端转换和尺寸探测 |

`ffmpeg` 和 `ffprobe` 需加入服务所在机器的 PATH。缺少工具或相应解码支持时，相关尺寸或预览可能不可用。动态图的大图缩略图可能为静态；HEIC/HEIF 暂不还原 HDR 增益图。

### 视频格式

| 格式 | 支持情况 |
| --- | --- |
| MP4、M4V、MOV、WebM、OGV / OGG | 浏览器支持对应编码时可播放；画廊支持 MP4、M4V、WebM、OGV，MOV 可配对 Live Photo |
| MPEG-TS（`.ts`）、MKV、AVI 等 | 可通过系统默认应用打开，不提供浏览器播放或自动转码；`.ts` 视频按内容与 TypeScript 源码区分 |

视频封面需要 FFmpeg。预览失败时可选择 **Open in system application**；该操作在运行 lib.ts 的机器上执行，需要桌面环境和对应的文件关联。不支持 `.m3u8` 播放列表。

## 图片与视频画廊

在目录菜单中开启 **Show gallery** 浏览图片和视频；可切换布局、缩放卡片、按拍摄时间排序，或开启 **Include subdirectories** 浏览子目录。图片尽量完整显示，不默认裁切。

视频悬停时静音循环播放，也可开启 **Autoplay videos**。同时播放的数量会根据分辨率限制，部分视频可能排队。实际播放能力取决于浏览器支持的编码和硬件加速。

同目录、同名主干（忽略大小写）的 JPEG、HEIC 或 HEIF 与 MOV 会合并为 Live Photo 卡片，使用照片封面并播放配对视频。

照片、视频浏览页支持 `↑` / `<` 切换上一个媒体，`↓` / `>` 切换下一个媒体。视频播放器聚焦时，方向键用于控制播放：

| 按键 | 操作 |
| --- | --- |
| 空格 / P（兼容 K） | 播放、暂停 |
| ← / → | 后退、前进 5 秒 |
| ↓ / ↑ | 后退、前进 1 分钟 |
| Shift + ← / → | 后退、前进 1 秒 |
| Shift + ↓ / ↑ | 后退、前进 5 秒 |
| 9 / 0 | 音量减、加 2% |
| M / F | 静音、全屏 |
| [ / ] | 速度除以、乘以 1.1（范围 0.25×～4×） |
| Backspace | 恢复 1× |

缩略图和转换后的预览自动缓存并定期清理。需要释放空间时，可删除数据目录中的 `thumbnails/`，后续访问会重新生成。

阅读位置、视图、缩放和 Markdown 折叠状态仅保存在当前浏览器；清除站点数据会丢失这些状态。媒体浏览不保存阅读位置。

## 构建与打包

```sh
npm run typecheck
npm run build
cargo build --release --locked
```

修改前端后重新构建，修改后端后重新编译并重启服务。

`npm run package` 在 `release/` 生成当前平台的部署目录和 `.tar.xz` 压缩包；打包环境需要支持 xz 的 `tar`（GNU tar 还需安装 `xz`）。GitHub 发布包也使用 `.tar.xz`，以减少字体下载体积。解压或复制整个目录后运行 `lib-ts`（Windows 为 `lib-ts.exe`），部署环境无需 Node.js。现有用户数据及 Typst 包缓存不随包复制。

现有回归检查：

```sh
node --test tests/*.test.mjs
cargo test --release --locked
```
