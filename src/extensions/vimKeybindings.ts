// vim 键位映射（VSCodeVim 风格）：normal / insert / visual 三模式各自的映射表，
// 把 vim 键（或 IDE 习惯键）绑成 vim 键序列或内置 ex 命令。
//
// 两条执行路：
// 1. 按键 → 按键序列（如 "jj" → "<Esc>"）：走 vim-core 的 Vim.map（keyToKey），
//    塞进 defaultKeymap 后由 vim 自己的按键路由处理——多键序列有 partial-wait
//    （第一键后等待、不命中再回放），无需自己缓冲。
// 2. 按键 → ex 命令（to 以 ":" 开头，如 "<C-s>" → ":w"）：vim-core 的公开 map
//    API 不支持按键→ex，由 vimKeyExInterceptor 在 vim 之前拦截（Prec.highest
//    domEventHandlers，返回 true 短路事件链即吞键），命中时把 ex 命令转给宿主
//    （复用 vim-ex emit 通道）。拦截只支持单键（含修饰键组合）——多键序列没有
//    vim 的 partial-wait 支持，界面录制时按此约束提示。

import { EditorView } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { Vim, getCM } from "@replit/codemirror-vim";
import type { VimExCommand } from "./vimExCommands";
import type { VimBinding, VimBindings } from "../types";

export const EMPTY_VIM_BINDINGS: VimBindings = { normal: [], insert: [], visual: [] };

/** to 是否为 ex 命令目标 */
export function isExTarget(to: string): boolean {
  return to.startsWith(":");
}

const EX_COMMANDS: readonly VimExCommand[] = ["w", "wq", "q", "q!"];

/** 把 ":" 目标解析成内置 ex 命令；不认识返回 null（拦截器放行） */
export function exToCommand(to: string): VimExCommand | null {
  const cmd = to.slice(1);
  return EX_COMMANDS.includes(cmd as VimExCommand) ? (cmd as VimExCommand) : null;
}

// ── 按键→按键：Vim.map / Vim.unmap（全局副作用，多编辑器共享同表）──

const MODES: Array<{ key: keyof VimBindings; ctx: string }> = [
  { key: "normal", ctx: "normal" },
  { key: "insert", ctx: "insert" },
  { key: "visual", ctx: "visual" },
];

/** 已应用过的按键映射（clear 时逐个 unmap，只清自己的） */
let applied: Array<{ keys: string; ctx: string }> = [];

/** 应用按键映射（先清旧）。ex 目标不注册进 vim（走拦截器）。 */
export function applyVimKeyMaps(bindings: VimBindings): void {
  clearVimKeyMaps();
  for (const mode of MODES) {
    for (const b of bindings[mode.key]) {
      if (!b.keys || isExTarget(b.to)) continue;
      Vim.map(b.keys, b.to, mode.ctx);
      applied.push({ keys: b.keys, ctx: mode.ctx });
    }
  }
}

/** 撤销全部已应用映射（vim 模式关闭 / 编辑器卸载时调用） */
export function clearVimKeyMaps(): void {
  for (const { keys, ctx } of applied) {
    // 同键重复映射会在 defaultKeymap 留下多条用户条目，循环删干净
    while (Vim.unmap(keys, ctx) === true) {
      /* noop */
    }
  }
  applied = [];
}

// ── 单键 ex 目标拦截（Prec.highest：先于 vim 的 keydown handler 吞键）──

const SPECIAL_KEYS: Record<string, string> = {
  Escape: "Esc",
  Enter: "CR",
  Backspace: "BS",
  Delete: "Del",
  Insert: "Ins",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "Space",
};

/** KeyboardEvent → vim 键串（<C-s> / <Esc> / <Space> / x）。Shift 不显式（大写字母即
 *  shift，录制与匹配用同一函数，一致即可）。识别不了返回 ""。特殊键必须尖括号包裹
 *  （vim 键串规范：裸 "Esc" 会被解析成四个字符），单字符无修饰键裸写。 */
export function eventToVimKey(e: KeyboardEvent): string {
  const special = SPECIAL_KEYS[e.key];
  const base = special ?? (e.key.length === 1 ? e.key.toLowerCase() : "");
  if (!base) return "";
  const mods = `${e.ctrlKey ? "C-" : ""}${e.altKey ? "A-" : ""}${e.metaKey ? "M-" : ""}`;
  return mods || special !== undefined ? `<${mods}${base}>` : base;
}

/** 收集 ex 目标映射：keys → [(ctx, cmd)]。insert 映射覆盖 replace（同 VSCodeVim）。 */
function collectExMap(bindings: VimBindings): Map<string, Array<{ ctx: string; cmd: VimExCommand }>> {
  const exMap = new Map<string, Array<{ ctx: string; cmd: VimExCommand }>>();
  for (const mode of MODES) {
    for (const b of bindings[mode.key]) {
      const cmd = exToCommand(b.to);
      if (!cmd || !b.keys) continue;
      const ctxs = mode.ctx === "insert" ? ["insert", "replace"] : [mode.ctx];
      const entry = exMap.get(b.keys) ?? [];
      for (const ctx of ctxs) entry.push({ ctx, cmd });
      exMap.set(b.keys, entry);
    }
  }
  return exMap;
}

/**
 * ex 目标拦截扩展：注册在 vim() 同 compartment，Prec.highest 保证先于 vim 的
 * keydown handler 执行；命中映射且当前 vim 模式匹配时 preventDefault + 回调
 * （return true 短路 CM 事件链，vim 不再处理该键）。未命中放行（false）。
 */
export function vimKeyExInterceptor(
  bindings: VimBindings,
  onEx: (cmd: VimExCommand) => void,
): Extension {
  const exMap = collectExMap(bindings);
  return Prec.highest(
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (exMap.size === 0) return false;
        const cm = getCM(view);
        const vim = cm?.state.vim;
        if (!vim) return false; // vim 未激活：放行
        const key = eventToVimKey(event);
        if (!key) return false;
        const hits = exMap.get(key);
        if (!hits) return false;
        const mode = String(vim.mode);
        const hit = hits.find((h) => mode.startsWith(h.ctx));
        if (!hit) return false;
        event.preventDefault();
        onEx(hit.cmd);
        return true;
      },
    }),
  );
}
