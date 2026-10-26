/**
 * 原生打开目录/克隆表单预览；只替换传输层，不执行真实克隆。
 * pnpm exec vite --port 5199
 * /docs/prototypes/_harness/open-folder-live.html?theme=glass
 * ?theme=warm-dark 切暗色；?fail 演示克隆错误；?host=wsl 演示 Host 路径。
 */
import { createApp, h, ref } from "vue";
import "../../../src/styles/global.css";
import { applyTheme, themes } from "../../../src/themes";
import { vTooltip } from "../../../src/directives/tooltip";
import { setTransport } from "@aide/sdk";
import OpenFolderDialog from "../../../src/components/OpenFolderDialog.vue";

const params = new URLSearchParams(location.search);
applyTheme(themes[params.get("theme") ?? "glass"] ?? themes.glass);
const host = params.get("host") === "wsl"
  ? { key: "wsl:Debian", label: "WSL: Debian", os: "linux", home: "/home/demo" }
  : { key: "local", label: "本机", os: "windows", home: "C:\\Projects" };
const separator = host.os === "windows" ? "\\" : "/";
const entry = (name: string, path: string) => ({ name, path, is_dir: true, children: null });

setTransport({
  async invoke<T>(command: string, input?: Record<string, unknown>): Promise<T> {
    let result: unknown;
    if (command === "current_host") result = host;
    else if (command === "remote_ws_targets") result = { wsl: ["Debian"], ssh: ["devbox"] };
    else if (command === "list_fs_roots") result = [entry("Projects", host.home)];
    else if (command === "list_directory") result = input?.path === host.home
      ? [entry("examples", `${host.home}${separator}examples`), entry("work", `${host.home}${separator}work`)] : [];
    else if (command === "git_clone") {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (params.has("fail")) throw new Error("认证失败：请在当前 Host 配置 Git 凭据后重试（演示）。");
      result = `${input?.parentPath}${separator}${input?.directoryName}`;
    } else if (command === "open_host_window" || command === "switch_window_host") {
      throw new Error("预览不连接其他 Host；切换 ?host=wsl 查看 WSL 窗口。");
    }
    return result as T;
  },
  async listen() { return () => {}; },
});

const visible = ref(true);
const error = ref("");
const selected = ref("");
createApp({
  render: () => h("main", [
    h("h1", "打开目录 · 界面预览"),
    h("p", "使用真实组件和主题；目录与 Git 为演示数据，不执行克隆。"),
    h("button", { onClick: () => { visible.value = true; } }, "打开目录"),
    h("output", selected.value ? `打开路径（演示）：${selected.value}` : "尚未选择目录"),
    h(OpenFolderDialog, {
      visible: visible.value,
      error: error.value,
      "onUpdate:visible": (value: boolean) => { visible.value = value; },
      "onUpdate:error": (value: string) => { error.value = value; },
      onConfirm: (path: string) => { selected.value = path; visible.value = false; },
    }),
  ]),
}).directive("tooltip", vTooltip).mount("#app");
