import { getTransport } from "../transport";

// ── Host 模型：一个窗口 = 一个 Host（本机 / WSL / SSH）──
// Rust 侧：src-tauri/src/host_window.rs。窗口连着哪台 Host 在打开窗口时就定了；功能代码不需要
// 知道——命令与事件由桌面前门按窗口路由。这里只给「需要知道」的少数 GUI：标题栏标签、目录
// 选择器的起点、路径语义（跟 Host 的系统走，不跟 GUI 所在系统走）、跨界动作。

/** 当前窗口连着的 Host。 */
export interface CurrentHost {
  /** `local` / `wsl:Debian` / `ssh:devbox` */
  key: string;
  /** `本机` / `WSL: Debian` / `SSH: devbox` */
  label: string;
  /** Host 的操作系统（`windows` / `linux` / `macos`） */
  os: string;
  /** Host 上的家目录（Host 原生路径） */
  home: string;
}

/** 一台 Host 的最近项目（Host 启动页的数据源）。路径是该 Host 的原生路径。 */
export interface HostRecentProject {
  path: string;
  /** 最近一次打开（毫秒时间戳） */
  openedAt: number;
}

export interface HostRecents {
  /** `local` / `wsl:Debian` / `ssh:devbox` */
  host: string;
  label: string;
  /** 新到旧 */
  projects: HostRecentProject[];
}

let current: Promise<CurrentHost> | null = null;

export const hostApi = {
  /** 本窗口连着的 Host（每个窗口固定，缓存；失败不缓存，下次重试）。 */
  current(): Promise<CurrentHost> {
    current ??= getTransport()
      .invoke<CurrentHost>("current_host")
      .catch((e) => {
        current = null;
        throw e;
      });
    return current;
  },
  /** 打开（或聚焦）连着某台 Host 的窗口；`folder` = 窗口起来后直接打开的目录（Host 原生路径）。 */
  openWindow(host: string, folder?: string): Promise<string> {
    return getTransport().invoke("open_host_window", folder ? { host, folder } : { host });
  },
  /** 「在此窗口中打开」：把**本窗口**换成连另一台 Host（`local` = 换回本机），不另开窗口。
   *  Rust 侧改绑 + 重载页面，成功后本页面会被重载（Promise 可能来不及 resolve）。 */
  switchWindow(host: string, folder?: string): Promise<void> {
    return getTransport().invoke("switch_window_host", folder ? { host, folder } : { host });
  },
  /** 记一次「本窗口的 Host 打开了这个项目」（Host 由调用窗口定，不由前端传）。 */
  recordRecent(path: string): Promise<void> {
    return getTransport().invoke("host_recents_record", { path });
  },
  /** 各 Host 的最近项目，最近打开的 Host 在前。桌面自己记的，不连接任何 Host。 */
  recents(): Promise<HostRecents[]> {
    return getTransport().invoke("host_recents_list");
  },
  /** 从某台 Host 的最近项目里去掉一项（不动磁盘上的项目）。 */
  forgetRecent(host: string, path: string): Promise<void> {
    return getTransport().invoke("host_recents_forget", { host, path });
  },
  /** 「从本机复制供应商」：本机的供应商连同密钥写进当前窗口的 Host，返回复制条数。 */
  importLocalProviders(): Promise<number> {
    return getTransport().invoke("import_local_providers");
  },
};

/** 已开着的 Host 窗口被要求打开某目录（`open_host_window` 带 folder 且窗口已存在）。 */
export const HOST_OPEN_FOLDER_EVENT = "host-open-folder";
