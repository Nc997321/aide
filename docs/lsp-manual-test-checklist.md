# 内置 LSP 真实 server 手测清单

v1 不进 CI（慢 + 依赖外部安装）。每个 server 跑一遍下列流程，结果记 PR 描述。

## 通用流程（每语言）
1. 开某语言文件（如 `foo.rs`）→ 编辑器应起该语言 server（DevTools 看 lsp_ensure_server 调用）
2. 写一个类型错 → 波浪线诊断出现（@codemirror/lint）
3. Ctrl+Click 一个符号 → 跳到定义（LSP 优先；无 server 落 codegraph/grep）
4. 键入触发补全 → 弹 `.cm-tooltip-autocomplete`，选项来自 server
5. 悬停某符号 → 弹 hover tooltip（markdown 渲染）
6. 关工作区 / 关 LSP toggle → server 进程退出（Task Manager 验）、波浪线消失
7. 排除目录：设 `target` 为排除 → 打开 `target/` 下文件不发 didOpen（无诊断/补全）

## server 矩阵
- [ ] rust-analyzer（Rust，捆绑）：本仓库自身 `src-tauri/` 打开 → 诊断 + 跳转 + 补全 + hover
- [ ] typescript-language-server（TS/JS，捆绑）：本仓库 `src/` 打开 `.ts`/`.vue`
- [ ] pyright-langserver（Python，PATH 发现；npm 包名 `pyright`，二进制 `pyright-langserver`）：任一 Python 项目
- [ ] gopls（Go，PATH 发现）：任一 Go 项目 + 验 directoryFilters 排除注入

## Windows 专项
- [ ] release build 打开 `.rs`：不弹控制台窗（CREATE_NO_WINDOW）
- [ ] release build：资源路径传 server 不崩（dunce 剥 `\\?\`）

## 不测的（诚实声明）
- 真实 rust-analyzer 全协议兼容矩阵——v1 只覆盖 4 method + 诊断
- macOS/Linux bundled server 拉起——仅手测清单覆盖（v1 主力 Windows）
