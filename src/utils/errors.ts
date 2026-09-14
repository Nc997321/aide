/**
 * Structured git error: code parsed from Rust, plus user-facing message and
 * suggested actions the UI can render as buttons/links.
 */
export interface GitError {
  code: string;
  message: string;
  actions: ErrorAction[];
}

export interface ErrorAction {
  label: string;
  kind: "retry" | "go-proxy-settings" | "go-marketplace-settings" | "force-push" | "pull-first" | "stash-and-switch" | "discard-and-switch" | "stash-and-pull" | "force-delete-branch";
}

const ERROR_MAP: Record<string, { message: string; actions: ErrorAction["kind"][] }> = {
  NETWORK_FAILURE: {
    message:
      "无法连接服务器。如果您在中国大陆，请开启 VPN 或代理后重试。\n常见代理端口：7890 (Clash)、10809 (V2Ray)",
    actions: ["retry", "go-proxy-settings"],
  },
  TIMEOUT: {
    message: "连接超时，请检查网络或开启代理后重试。",
    actions: ["retry", "go-proxy-settings"],
  },
  REPO_NOT_FOUND: {
    message: "仓库不存在或已被移除。",
    actions: ["retry", "go-marketplace-settings"],
  },
  NPM_UNSUPPORTED: {
    message: "npm 源插件暂不支持安装。",
    actions: ["retry"],
  },
  SOURCE_TYPE_UNSUPPORTED: {
    message: "未知的插件源类型。",
    actions: ["retry"],
  },
  // Push-specific errors
  REJECTED: {
    message: "推送被拒绝，本地分支落后于远程。请先拉取远程更新，或强制推送覆盖。",
    actions: ["pull-first", "force-push"],
  },
  NO_UPSTREAM: {
    message: "当前分支没有设置上游远程分支。",
    actions: ["retry"],
  },
  PUSH_FAILED: {
    message: "推送失败。",
    actions: ["retry", "force-push"],
  },
  // Checkout-specific errors
  CHECKOUT_CONFLICT: {
    message: "当前分支有未提交的改动，切换分支会覆盖这些文件。",
    actions: ["stash-and-switch", "discard-and-switch"],
  },
  CHECKOUT_FAILED: {
    message: "分支切换失败。",
    actions: ["retry"],
  },
  // Branch creation errors
  BRANCH_EXISTS: {
    message: "分支名已存在，请换一个名字。",
    actions: ["retry"],
  },
  INVALID_NAME: {
    message: "分支名不合法。不能包含空格、~ ^ : ? * [ \\ @ { 或以 . 开头。",
    actions: ["retry"],
  },
  BRANCH_FAILED: {
    message: "创建分支失败。",
    actions: ["retry"],
  },
  // Pull-specific errors
  MERGE_CONFLICT: {
    message: "拉取后出现合并冲突，请在终端解决冲突后执行 `git commit`。",
    actions: [],
  },
  LOCAL_CHANGES: {
    message: "本地有未提交改动，请先提交或 stash 后再拉取。",
    actions: ["stash-and-pull"],
  },
  PULL_FAILED: {
    message: "拉取失败。",
    actions: ["retry"],
  },
  // Branch deletion errors
  BRANCH_NOT_MERGED: {
    message: "分支有未合并的改动，强制删除将丢失这些改动。",
    actions: ["force-delete-branch"],
  },
  DELETE_FAILED: {
    message: "删除分支失败。",
    actions: ["retry"],
  },
};

const DEFAULT_ERROR: GitError = {
  code: "UNKNOWN_ERROR",
  message: "发生未知错误，请重试。",
  actions: [{ kind: "retry", label: "重试" }],
};

/** Parse Rust error string (format "CODE: details") into a structured GitError. */
export function parseGitError(raw: string): GitError {
  // Try to extract "CODE: rest" prefix
  const match = raw.match(/^([A-Z_]+):\s*(.*)/);
  if (!match) return { ...DEFAULT_ERROR, message: raw };

  const code = match[1];
  const details = match[2] || "";
  const def = ERROR_MAP[code];
  if (!def) return { code, message: details, actions: [{ kind: "retry", label: "重试" }] };

  return {
    code,
    message: details.includes("git clone") || details.includes("Could not")
      ? def.message  // network/clone errors: show friendly message only
      : `${def.message}\n\n${details}`,  // other errors: include raw details
    actions: def.actions.map((kind) => ({ kind, label: actionLabel(kind) })),
  };
}

function actionLabel(kind: ErrorAction["kind"]): string {
  switch (kind) {
    case "retry": return "重试";
    case "go-proxy-settings": return "配置代理";
    case "go-marketplace-settings": return "切换市场源";
    case "force-push": return "强制推送";
    case "pull-first": return "先拉取";
    case "stash-and-switch": return "Stash 并切换";
    case "discard-and-switch": return "丢弃并切换";
    case "stash-and-pull": return "Stash 并拉取";
    case "force-delete-branch": return "强制删除";
  }
}

/**
 * 任意抛出值 → 可直接展示的文本。
 * invoke 的 reject 值不保证是 Error（Rust 侧可能是字符串），UI 提示统一走这里，
 * 免得每个调用点各写一遍 `typeof e === "string" ? ... : (e as Error).message`。
 */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  return String(e);
}
