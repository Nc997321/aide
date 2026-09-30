import { getTransport } from "../transport";

// ── 远程工作区（WSL / SSH 目标机上的项目，GUI 留在桌面）──
// Rust 侧：src-tauri/src/remote_workspace/。与「远程控制」（手机遥控桌面，remote_* 命令）无关。
//
// 远程路径在桌面一律是 UNC 形态，文件树 / 编辑器 / git / 搜索照常传路径即可——IPC 拦截层
// 按路径把命令转发到目标机。这里只有**连接管理**与**路径显示**两件事。

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
  state: "connecting" | "installing" | "connected" | "error" | "disconnected" | "";
  detail?: string;
  /** 目标机家目录（桌面形态），连接成功后才有。 */
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

// ── 路径形态（与 Rust remote_workspace/path.rs 同一规则；Rust 为准，这里只做显示/判定）──

const WSL_RE = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]([A-Za-z0-9._@-]+)(?:[\\/](.*))?$/i;
const SSH_RE = /^[\\/]{2}aide-ssh\.invalid[\\/]([A-Za-z0-9._@-]+)(?:[\\/](.*))?$/i;

export interface RemotePathInfo {
  host: string;
  label: string;
  /** 目标机上的 POSIX 路径 */
  posix: string;
}

export function parseRemotePath(path: string): RemotePathInfo | null {
  const toPosix = (tail: string | undefined) =>
    "/" + (tail ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  let m = WSL_RE.exec(path);
  if (m) return { host: `wsl:${m[2]}`, label: `WSL: ${m[2]}`, posix: toPosix(m[3]) };
  m = SSH_RE.exec(path);
  if (m) return { host: `ssh:${m[1]}`, label: `SSH: ${m[1]}`, posix: toPosix(m[2]) };
  return null;
}

export function isRemotePath(path: string): boolean {
  return parseRemotePath(path) !== null;
}

/** 主机键 + 目标机路径 → 桌面形态路径（目录选择器起点等）。 */
export function remoteDesktopPath(host: string, posix: string): string {
  const [kind, name] = host.split(":", 2);
  const prefix = kind === "wsl" ? `\\\\wsl.localhost\\${name}` : `\\\\aide-ssh.invalid\\${name}`;
  const tail = posix.replace(/^\/+|\/+$/g, "");
  return tail ? `${prefix}\\${tail.replace(/\//g, "\\")}` : `${prefix}\\`;
}

/**
 * 模型正文里的目标机绝对路径（`/home/u/p/a.rs`）→ 该会话工作区所在主机的桌面形态。
 * 会话在本机工作区、或 token 不是 POSIX 绝对路径 → 原样返回。
 * 前端点击聊天里的文件链接时用：拿到的路径必须能再交回 IPC。
 */
export function resolveAgainstWorkspace(token: string, workspaceRoot: string | null | undefined): string {
  if (!workspaceRoot || !token.startsWith("/")) return token;
  const ws = parseRemotePath(workspaceRoot);
  if (!ws) return token;
  return remoteDesktopPath(ws.host, token);
}
