# es-git 0.7.0 替换验证

2026-10-15，Windows x64，Node v24.21.0。结论：暂不替换现有 Git CLI 后端。

## 行为验证

- 未暂存 diff 的 `Diff.print()` 丢失正文行的 `+`、`-` 和空格前缀。例如 CLI 返回 `-staged\n+unstaged\n`，es-git 返回 `staged\nunstaged\n`。现有 `parseGitDiff` 无法区分增删行。源码 `src/diff.rs` 只拼接 `line.content()`，没有处理 `line.origin()`；不是应用参数问题。
- 没有 `diffTreeToIndex`，无法直接实现当前 `--cached` 的暂存区比较。`index.writeTree()` 会写对象库，不适合只读浏览；也不应为了绕过绑定缺口增加临时仓库或自建 diff。
- `statuses()` 不接受 `StatusOptions`。默认返回忽略项，测试中的暂存重命名返回独立增删项，没有 `indexRenamed`；需要额外过滤和重命名检测。默认递归列出了测试中的未跟踪文件，这项没有发生退化。
- 未暂存差异包含正确的文件内容，但格式不正确；测试中的 index 字节没有变化。未完成冲突、子模块等完整迁移验证，因为上述问题已足以否定直接替换。

源码核对：

- https://github.com/toss/es-git/blob/main/src/diff.rs
- https://github.com/toss/es-git/blob/main/src/status.rs

## 性能样本

| 场景 | 现有 CLI 中位数 | es-git 中位数 |
| --- | ---: | ---: |
| 小型混合状态仓库 | 25.48 ms | 0.35 ms |
| 额外包含 3000 个已跟踪短文件 | 42.82 ms | 3.01 ms |

每组 10 次，第一轮单独记录，其余 9 次取中位数。文件系统缓存未清空；CLI 复用现有根目录前缀缓存，双方都未使用服务端 4 秒结果缓存。第二场景仍保留混合状态，测试前的提交改变了待比较状态，所以不能把两行当成仅文件数量不同的严格对照。结果不代表真实仓库的普遍加速比。

原生模块首次动态导入约 5.76 ms。连续 10 次同步原生状态扫描使 `setImmediate` 延后约 31.83 ms；异步 CLI 单次扫描期间约 2.67 ms 即可执行回调。这两项用于说明是否阻塞主线程，不是相同工作量的性能比较。未测 RSS、长时间运行和 Worker 开销。

## 复现

```bash
npm install --no-save --package-lock=false es-git@0.7.0
node tests/benchmark/es-git.mjs
```

脚本只在系统临时目录创建测试仓库，完成后清理；不提交或修改工作区仓库。Git CLI 用于构造 fixture 和行为对照。es-git 是可选验证依赖，不加入项目依赖清单。原始结果见 `es-git-validation.json`。

## 接入判断

性能有潜力，但要保持现有 HTTP 响应和只读行为，目前必须补充或修复绑定，并继续维护 patch 解析。同步操作若需要 Worker，还会增加生命周期和取消处理。它不满足本次“简洁高效替换，争取明显减少代码”的目标。

待上游修复 patch 输出、提供 tree-to-index diff 和可配置状态接口后，可重跑验证，再考虑替换。生产实现、HTTP 接口及共享缓存本次保持原样。
