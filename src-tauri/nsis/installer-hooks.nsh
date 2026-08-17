; Aide NSIS installer hooks
;
; 在安装末尾静默安装 Microsoft Visual C++ Redistributable（VC++ 运行库）。
;
; 根因：aide.exe 由 VS Build Tools 2022（MSVC 14.3x）编译，依赖 MSVCP140.dll /
; VCRUNTIME140.dll（来自 ort/ONNX Runtime、WebView2/wry 等原生 C++ 依赖）。用户机器
; 若缺/旧/损坏这些运行库，exe 在加载阶段即 access violation 崩溃（比 aide 第一行
; Rust 代码还早，故无日志无提示，表现为「双击无反应」）。
;
; 解法：vc_redist.x64.exe bootstrapper 随包经 bundle.resources 分发，装到
; $INSTDIR\vc-redist\（Windows 上 resource_dir = exe 同目录）。POSTINSTALL
; 钩子（拷文件/注册表/快捷方式之后）ExecWait 静默安装它。微软官方推荐的运行库
; 分发方式，装一次系统级，可被 Windows Update 维护。
;
; 返回码：0=成功 1638=已装相同或更新版本 3010=成功需重启；其余视为失败。
; 失败不中断 aide 安装（aide 仍装上），非 silent 模式弹 MessageBox 提示用户手动装。
; 卸载不卸 vc_redist（系统共享，其他应用可能依赖）——故不写 PREUNINSTALL/POSTUNINSTALL。

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\vc-redist\vc_redist.x64.exe" 0 vcredist_done
    DetailPrint "Installing Visual C++ Redistributable..."
    ExecWait '"$INSTDIR\vc-redist\vc_redist.x64.exe" /install /quiet /norestart' $0
    ; 0=成功 1638=已装相同/更新 3010=成功需重启；其余失败
    StrCmp $0 0 vcredist_ready
    StrCmp $0 1638 vcredist_ready
    StrCmp $0 3010 vcredist_ready
      ; 失败分支
      IfSilent vcredist_fail_silent
      MessageBox MB_OK "Visual C++ Redistributable 安装失败（代码 $0），aide 可能无法启动。请联网后从 https://aka.ms/vs/17/release/vc_redist.x64.exe 手动安装后重试。"
      vcredist_fail_silent:
      DetailPrint "VC++ Redistributable install failed (exit $0)"
      Goto vcredist_done
    vcredist_ready:
      DetailPrint "VC++ Redistributable ready (exit $0)"
  vcredist_done:
!macroend