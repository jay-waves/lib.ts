# 开发与验证约定

- 保持调试与验证轻量。前后端调试最多使用 Cargo 或 Node.js 自带工具；可以运行项目已有的类型检查和构建脚本。
- 不启动或安装完整 Chrome/Chromium 环境，也不使用 Playwright、Puppeteer 等浏览器自动化环境。
- 集成测试、浏览器端到端测试和真实前后端联调交给用户执行。代理完成代码修改、静态检查及必要的单元测试，并在交付时说明需要用户验证的场景。
- Cargo 编译、运行和测试始终使用 release 模式，例如 `cargo build --release --locked`、`cargo run --release --`、`cargo test --release --locked --bin saved-notes-library`；不使用默认 debug 模式。`cargo fmt` 等不涉及编译 profile 的命令不受此限制。
- 不为验证引入额外的重型依赖或测试环境。
