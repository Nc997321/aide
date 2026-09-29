/**
 * 键名 → CDP `Input.dispatchKeyEvent` 参数（`browser_act` 的 `action:"press"` 载荷）。
 *
 * # 为什么按键要走 CDP 而不是脚本派发事件
 *
 * 与点击同源（见 `act.ts` 的头注）：脚本 `new KeyboardEvent('keydown')` 不是 `isTrusted`，
 * 而「回车触发提交 / Esc 关抽屉」这类行为在多数框架里挂在**原生**按键上（Element Plus 的
 * `el-input` 就是 blur/Enter 才 commit）。CDP 派发的是真实输入，与手按同级。
 *
 * # 两条自设的规矩（都是为了让这套工具不被用歪）
 *
 * 1. **不做打字机**：单字符只有**带修饰键**时才放行（`Ctrl+A` 这类快捷键）。想设值就用
 *    `fill`——逐字符按键盘又慢又容易在中间态被框架截走，而 `fill` 是原子的。
 * 2. **不认识就报错并列出支持的键**，绝不静默发一个空键（那会变成"点了没反应"的幽灵故障）。
 *
 * 表本身是**纯数据 + 纯函数**：真机行为（按键真的落到了页面上）由 checklist 端到端验。
 */

/** 修饰键 → CDP 位掩码（Alt=1 / Ctrl=2 / Meta=4 / Shift=8，CDP 官方口径）。 */
const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/**
 * 命名键：`key` 是 CDP 的 `key` 字段，`code` 是物理键位，`vk` 是 Windows 虚拟键码，
 * `label` 是**回报给模型的名字**（CDP 对空格只说 " "，回报里得是 "Space"）。
 */
interface NamedKey {
  key: string;
  code: string;
  vk: number;
  label: string;
  /** 产生字符的键才有：CDP 靠它把这一发变成 `keyDown`（而不是 `rawKeyDown`）。 */
  text?: string;
}

const NAMED: Record<string, NamedKey> = {
  enter: { key: "Enter", code: "Enter", vk: 13, label: "Enter", text: "\r" },
  escape: { key: "Escape", code: "Escape", vk: 27, label: "Escape" },
  tab: { key: "Tab", code: "Tab", vk: 9, label: "Tab", text: "\t" },
  // CDP 里空格的 `key` 就是空格字符本身；键名收 "space" 是给模型一个能写出来的词。
  space: { key: " ", code: "Space", vk: 32, label: "Space", text: " " },
  backspace: { key: "Backspace", code: "Backspace", vk: 8, label: "Backspace" },
  delete: { key: "Delete", code: "Delete", vk: 46, label: "Delete" },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38, label: "ArrowUp" },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40, label: "ArrowDown" },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37, label: "ArrowLeft" },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39, label: "ArrowRight" },
  home: { key: "Home", code: "Home", vk: 36, label: "Home" },
  end: { key: "End", code: "End", vk: 35, label: "End" },
  pageup: { key: "PageUp", code: "PageUp", vk: 33, label: "PageUp" },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34, label: "PageDown" },
};

/** 支持的键名（**给模型看的清单**，与校验同源——`keys.test.ts` 钉住"每个都真能解析"）。 */
export const SUPPORTED_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;

/** 一次按键的两发（按下 / 抬起）。只按不抬 = 键卡住，两发都要成。 */
export interface KeyStroke {
  /** 回报给模型的名字（`Space` 而不是一个空格）。 */
  label: string;
  /** 物理键位——合成兜底脚本要拿它填事件。 */
  code: string;
  down: Record<string, unknown>;
  up: Record<string, unknown>;
}

export type KeyResolution = ({ ok: true } & KeyStroke) | { ok: false; error: string };

/** 修饰键数组 → 位掩码；名字不认识就拒绝（不静默丢掉一个按不出来的修饰键）。 */
function modifierBits(modifiers: string[]): { ok: true; bits: number } | { ok: false; error: string } {
  let bits = 0;
  for (const m of modifiers) {
    const bit = MODIFIER_BITS[String(m).toLowerCase()];
    if (bit === undefined) {
      return {
        ok: false,
        error:
          `unsupported modifier ${JSON.stringify(String(m))} — use any of ` +
          `${Object.keys(MODIFIER_BITS).join(", ")}.`,
      };
    }
    bits += bit;
  }
  return { ok: true, bits };
}

/** 单字符键（快捷键用）：字母/数字才有物理键位可言，其余字符拒绝。 */
function charKey(ch: string, bits: number): NamedKey | null {
  if (/^[a-z]$/i.test(ch)) {
    const upper = ch.toUpperCase();
    return { key: ch.toLowerCase(), code: `Key${upper}`, vk: upper.charCodeAt(0), label: ch.toLowerCase() };
  }
  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), label: ch };
  }
  return null;
}

/** 键名 → 基准键（命名表，或**带修饰键**的单字符）。不认识就回面向模型的拒绝文案。 */
function baseKey(raw: string, bits: number): { ok: true; base: NamedKey } | { ok: false; error: string } {
  const trimmed = raw.trim();
  const named = NAMED[trimmed.toLowerCase()] ?? (raw === " " ? NAMED["space"] : undefined);
  if (named) return { ok: true, base: named };

  if (trimmed.length === 1) {
    // 打字不许走这里：`fill` 是原子的，而逐字符按键会在中间态被框架截走（还会慢得离谱）。
    if (bits === 0) {
      return {
        ok: false,
        error:
          `"${raw}" is a printable character with no modifier — press is for keys and shortcuts, ` +
          `not for typing. Use action="fill" to set a value, or add a modifier for a shortcut ` +
          `(e.g. key "a" with modifiers ["ctrl"]).`,
      };
    }
    const ch = charKey(trimmed, bits);
    if (ch) return { ok: true, base: ch };
  }

  return {
    ok: false,
    error:
      `unsupported key ${JSON.stringify(raw)} — supported keys are ${SUPPORTED_KEYS.join(", ")}, ` +
      `plus a single letter/digit with a modifier (e.g. "a" + ["ctrl"]).`,
  };
}

/** 键名 + 修饰键 → 两发 CDP 参数。失败回**面向模型**的原因与下一步。 */
export function resolveKey(key: string, modifiers: string[]): KeyResolution {
  const mods = modifierBits(modifiers);
  if (!mods.ok) return mods;

  const picked = baseKey(String(key ?? ""), mods.bits);
  if (!picked.ok) return picked;
  const base = picked.base;

  const common = {
    key: base.key,
    code: base.code,
    windowsVirtualKeyCode: base.vk,
    nativeVirtualKeyCode: base.vk,
    modifiers: mods.bits,
  };
  // 产生字符的键走 `keyDown` + `text`（Chrome 真按键的形状）；其余 `rawKeyDown`。
  const down: Record<string, unknown> = base.text
    ? { type: "keyDown", text: base.text, unmodifiedText: base.text, ...common }
    : { type: "rawKeyDown", ...common };
  return { ok: true, label: base.label, code: base.code, down, up: { type: "keyUp", ...common } };
}
