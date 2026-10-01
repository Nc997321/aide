import { getTransport } from "../transport";

// ── 远程 Host 的连接管理（WSL 发行版 / SSH 服务器）──
// Rust 侧：src-tauri/src/remote_workspace/。与「远程控制」（手机遥控桌面，remote_* 命令）无关。
//
// 一个窗口 = 一个 Host（见 ./host.ts）：远程 Host 在它自己的窗口里用，路径是 Host 原生路径，
// 不做任何翻译。这里只剩可连接目标的列举与连接状态。

/** 可连接的目标：本机 WSL 发行版 + `~/.ssh/config` 的 Host 别名。 */
export interface RemoteTargets {
  wsl: string[];
  ssh: string[];
}

/** 一台目标机的连接状态（`remote-workspace-status` 事件同形）。 */
export interface RemoteHostStatus {
  /** 稳定主机键：`wsl:Debian` / `ssh:devbox` */
  host: string;
  /** 显示名：`WSL: Debian` / `SSH: devbox` */
  label: string;
  /**
   * `reconnecting`：连接断了、正在自动重连（Host 上的会话还在）；
   * `resync`：重连上了原来的 Host，但断线期间的更新已无法补齐（会话仍在，界面需重新加载）。
   */
  state: "connecting" | "installing" | "connected" | "error" | "disconnected" | "reconnecting" | "resync" | "";
  detail?: string;
  /** 目标机家目录（Host 原生路径），连接成功后才有。 */
  home?: string;
}

export const REMOTE_WORKSPACE_STATUS_EVENT = "remote-workspace-status";

export const remoteWorkspaceApi = {
  targets(): Promise<RemoteTargets> {
    return getTransport().invoke("remote_ws_targets");
  },
  /** 连接（首次会在目标机安装远程套件，可能需要几十秒）。 */
  connect(host: string): Promise<RemoteHostStatus> {
    return getTransport().invoke("remote_ws_connect", { host });
  },
  disconnect(host: string): Promise<void> {
    return getTransport().invoke("remote_ws_disconnect", { host });
  },
  statuses(): Promise<RemoteHostStatus[]> {
    return getTransport().invoke("remote_ws_statuses");
  },
};

// ── 旧版登记的远程工作区 ──
// Host 模型之前，远程工作区以 UNC 形态登记在本机的工作区列表里（`\\wsl.localhost\<distro>\…` /
// `\\aide-ssh.invalid\<alias>\…`）。它们属于那台 Host：侧栏据此认出来，点开即进它的 Host 窗口。

const WSL_RE = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]([A-Za-z0-9._@-]+)(?:[\\/](.*))?$/i;
const SSH_RE = /^[\\/]{2}aide-ssh\.invalid[\\/]([A-Za-z0-9._@-]+)(?:[\\/](.*))?$/i;

export interface RemotePathInfo {
  host: string;
  label: string;
  /** 目标机上的 POSIX 路径 */
  posix: string;
}

/** 旧版 UNC 形态的远程工作区路径 → (主机键, 显示名, 目标机路径)；其它路径 → null。 */
export function parseRemotePath(path: string): RemotePathInfo | null {
  const toPosix = (tail: string | undefined) =>
    "/" + (tail ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  let m = WSL_RE.exec(path);
  if (m) return { host: `wsl:${m[2]}`, label: `WSL: ${m[2]}`, posix: toPosix(m[3]) };
  m = SSH_RE.exec(path);
  if (m) return { host: `ssh:${m[1]}`, label: `SSH: ${m[1]}`, posix: toPosix(m[2]) };
  return null;
}
