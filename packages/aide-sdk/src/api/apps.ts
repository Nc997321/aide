import { getTransport } from "../transport";
import type { AppInfo, AppProcess } from "../types/apps";

/** Host 发的事件：应用增删改、同意或启停之后。收到就重新 `list`。 */
export const APPS_CHANGED_EVENT = "apps-changed";
/** Host 发给某个应用面板的事件（后端推的、进程的动静）。只转给 `appId` + `workspace` 对得上的面板。 */
export const APP_EVENT = "app-event";
export interface AppEventPayload {
  appId: string;
  /** 这条事件属于哪个工作区的面板；`null` = 应用不在任何工作区里。 */
  workspace: string | null;
  channel: string;
  payload: unknown;
}
/** 应用起的进程有增减。收到就重新 `processList`。 */
export const APP_PROCESSES_CHANGED_EVENT = "app-processes-changed";

/**
 * 侧栏应用：装在**当前窗口连着的 Host** 上（`~/.aide/apps`，受信任工作区的 `.aide/apps` 是开发态）。
 * 面板只在桌面，这些命令不进 Link 暴露目录。
 */
export const appsApi = {
  list(): Promise<AppInfo[]> {
    return getTransport().invoke("app_list");
  },
  /** 应用界面经桥发来的调用。权限由 Host 按清单裁决，这里只是管道。
   *  `workspace` = 面板所在的工作区根（外层带上的，不是应用自己说的）；Host 只认登记过的工作区，
   *  **不会**替你回落到它当下的活动工作区。 */
  call(appId: string, method: string, params: unknown, workspace: string | null): Promise<unknown> {
    return getTransport().invoke("app_call", { appId, method, params, workspace });
  },
  /** 所有应用、所有工作区正在跑（和刚结束）的进程。 */
  processList(): Promise<AppProcess[]> {
    return getTransport().invoke("app_process_list");
  },
  /** 用户在 Aide 自己的清单里结束一个进程（不经应用）。 */
  processKill(runId: string): Promise<void> {
    return getTransport().invoke("app_process_kill", { runId });
  },
  consent(appId: string, grant: string): Promise<void> {
    return getTransport().invoke("app_consent", { appId, grant });
  },
  setEnabled(appId: string, enabled: boolean): Promise<void> {
    return getTransport().invoke("app_set_enabled", { appId, enabled });
  },
  /** 用户把应用挪到另一个位置（右栏 / 主区）。记在 Host 上，盖过清单里写的。 */
  setPlacement(appId: string, placement: AppInfo["placement"]): Promise<void> {
    return getTransport().invoke("app_set_placement", { appId, placement });
  },
  /** 应用目录里的一个文件（字节）。未经同意只取得到清单里写的图标。 */
  asset(appId: string, path: string): Promise<ArrayBuffer> {
    return getTransport().invoke("app_asset", { appId, path });
  },
  /** 把工作区里的开发态应用装成用户级。 */
  install(appId: string): Promise<void> {
    return getTransport().invoke("app_install", { appId });
  },
  /** 删掉眼前这一个应用：安装版连同与它一样的开发态副本；或者只删开发态那一份。数据留着。 */
  uninstall(appId: string): Promise<void> {
    return getTransport().invoke("app_uninstall", { appId });
  },
  /** 本窗口里某个应用的资源根地址（以 `/` 结尾）。桌面壳能力：应用界面从回环地址加载。 */
  frameBase(appId: string): Promise<string> {
    return getTransport().invoke("app_frame_base", { appId });
  },
};
