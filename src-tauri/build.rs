fn main() {
    #[cfg(windows)]
    {
        // Windows 清单统一由本脚本经 /MANIFESTINPUT 嵌入（bin 和测试 exe 都吃
        // cargo:rustc-link-arg）。背景：tauri-build 默认把清单编进 bin 的 .res，
        // cargo test 的 lib-test harness 拿不到——一旦测试 exe 链接进 comctl32 v6
        // 专属符号（tauri-runtime-wry 对话框 / muda 菜单引用的 TaskDialogIndirect
        // 等），进程加载即 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND（tauri#11179）。
        // 这里关掉 tauri 的资源版清单避免 bin 里 RT_MANIFEST 撞车（CVT1100），
        // 清单内容与 tauri 默认完全一致（仅 comctl32 v6 依赖）。
        let attrs = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attrs).expect("tauri_build::try_build failed");
        let manifest = std::path::PathBuf::from("windows-app-manifest.xml");
        let manifest = manifest.canonicalize().unwrap_or(manifest);
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    #[cfg(not(windows))]
    tauri_build::build();
}
