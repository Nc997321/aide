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
  /** "retry" = run the same operation again;
   *  "retry-with-proxy" = re-run with proxy applied;
   *  "go-proxy-settings" = navigate to proxy config;
   *  "go-marketplace-settings" = navigate to marketplace source config. */
  kind: "retry" | "go-proxy-settings" | "go-marketplace-settings";
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
  }
}
