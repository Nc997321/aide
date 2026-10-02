// aide 的 LSP 通道总闸——**单一事实源**。
//
// 三个消费者必须同源，各算各的会算出两种坏状态：
//   - extensions/lspTools.ts   挂不挂 aide-lsp 工具
//   - extensions/lspRetire.ts  退不退 Claude Code 内置的 *-lsp 插件
//   - engine/lspHint.ts        内置通道的导航提示还要不要注入
//
//   「两个都没有」= 退役了内置、自己却没挂上 → 能力缺口，agent 直接没 LSP 可用；
//   「两个都在」  = 自己挂了却没退役内置 → 双份语言服务器 + 互相矛盾的答案（C3 要消灭的）。
//
// 判据本身只有三条，集中在这里；**别在任何调用点重写这三条**。

/** 闸门输入。`env` 是**进程环境**（`process.env`），与 `lspMcpRegistration` 收到的是
 *  同一份——不是 cliEnv：两者的白名单不同，`AIDE_LSP_TOOLS` 只在进程环境里稳定可见。 */
export interface LspGate {
  env: NodeJS.ProcessEnv;
  trusted: boolean;
  /** 该工作区配得上 LSP 的语言（主进程 `lsp_languages_for_path` 算好下发）。空 = 没有。 */
  lspLanguages: string[];
}

/**
 * aide 的 LSP 通道是否可用。三条并列，任一不满足即 false：
 * - `trusted=false`：不信任的工作区不跑语言服务器（主进程侧同一道门）。
 * - `lspLanguages` 为空：该工作区没有配得上 LSP 的语言。挂了只会白付每轮重发的
 *   工具 schema，并诱导模型去调注定返回 no_server 的工具。
 * - `AIDE_LSP_TOOLS=off`：逃生舱（与 AIDE_DOCX_TOOLS 同款）。
 *
 * 语义是「**替代品在场**」，不是「功能已开启」——退役内置通道的那一侧靠的正是这个
 * 区别：不信任的工作区、detector 没认出来的工作区（如 Rust 在子目录的 monorepo），
 * 这里为 false ⇒ 内置通道**原样留着**，那才是正确的保留。
 */
export function lspToolsMounted(gate: LspGate): boolean {
  if (!gate.trusted) return false;
  if (gate.lspLanguages.length === 0) return false;
  if (gate.env.AIDE_LSP_TOOLS === "off") return false;
  return true;
}
