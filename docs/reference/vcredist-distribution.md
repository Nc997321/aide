# VC++ Redistributable 随包分发（NSIS POSTINSTALL 静默装）

> 从 CLAUDE.md 拆出（2026-09-10）。核心规则一句话：**vc_redist 随包分发 + NSIS POSTINSTALL 静默装，机制与维护见本文。**

## 为什么必须分发

aide.exe 由 MSVC 14.3x（VS Build Tools 2022）编译，依赖 `MSVCP140.dll` / `VCRUNTIME140.dll`
（来自 `ort`/ONNX Runtime 的 `copy-dylibs` + WebView2/wry）。用户机器若缺/旧/损坏这些运行库，
exe 在 C++ 运行库加载阶段即 access violation（`0xc0000005`）崩溃——比 aide 第一行 Rust 代码还早，
故无日志无提示，表现为「双击无反应」（release 是 `windows_subsystem = "windows"` 无控制台）。
排查入口：事件查看器 faulting module（见 memory：double-click-no-response-vcredist）。

## 分发机制

- `vc_redist.x64.exe`：微软官方 offline redist（~24MB），`https://aka.ms/vs/17/release/vc_redist.x64.exe`
  （该 URL 永远指向最新 14.4x），经 `bundle.resources` 打包到 `$INSTDIR/vc-redist/`
  （Windows 上 `resource_dir()` = exe 同目录，注意 `\\?\` 坑点对子进程的影响，本场景只有 Rust 读，无碍）。
- `bundle.windows.nsis.installerHooks` 指向 `src-tauri/nsis/installer-hooks.nsh` 的
  `NSIS_HOOK_POSTINSTALL` 宏：`ExecWait` 跑 `vc_redist.x64.exe /install /quiet /norestart`。
- 返回码白名单：`0`=成功 / `1638`=已装相同或更新 / `3010`=需重启；失败不中断 aide 安装、
  非 silent 模式弹 MessageBox 提示手动装。

## 设计决策

- 不写 `PREUNINSTALL` / `POSTUNINSTALL`——vc_redist 是系统共享运行库，aide 卸载不卸它（其他应用可能依赖）。
- `install_mode` 保持默认 `CurrentUser`（per-user、无 UAC、匹配 vc_redist per-user 静默装）。
- installer 体积 +24MB 是已知代价（换离线机也能装、装一次系统级、可被 Windows Update 维护）。

## 维护

VC++ 运行库安全更新不自动跟进：定期重新下载 `vc_redist.x64.exe` 覆盖
`src-tauri/resources/vc-redist/` 即更新；更新后在 commit message 记新版本号（文件属性可见）。