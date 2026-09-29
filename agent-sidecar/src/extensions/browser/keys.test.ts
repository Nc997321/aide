// @vitest-environment node
//
// 键名 → CDP `Input.dispatchKeyEvent` 参数：**纯函数**，所以这里断言的是表本身
// （vk / code / text / 修饰位），不涉及浏览器。
import { describe, it, expect } from "vitest";
import { resolveKey, SUPPORTED_KEYS } from "./keys.js";

/** 拿一次成功的解析（失败用例自己断言 error，不该走这里）。 */
function ok(key: string, modifiers: string[] = []) {
  const r = resolveKey(key, modifiers);
  if (!r.ok) throw new Error(`expected ${key} to resolve, got: ${r.error}`);
  return r;
}

describe("resolveKey：命名键", () => {
  it("Enter → 带文本的 keyDown（Chrome 真按键就是这条形状）", () => {
    const r = ok("Enter");
    expect(r.down.type).toBe("keyDown");
    expect(r.down.text).toBe("\r");
    expect(r.down.windowsVirtualKeyCode).toBe(13);
    expect(r.up.type).toBe("keyUp");
  });

  it("方向键/翻页键 → rawKeyDown，没有 text（它们不产生字符）", () => {
    const r = ok("ArrowDown");
    expect(r.down.type).toBe("rawKeyDown");
    expect(r.down.code).toBe("ArrowDown");
    expect(r.down.windowsVirtualKeyCode).toBe(40);
    expect(r.down.text).toBeUndefined();

    expect(ok("PageUp").down.windowsVirtualKeyCode).toBe(33);
    expect(ok("Escape").down.windowsVirtualKeyCode).toBe(27);
  });

  it("Space 的键名是空格字符本身（CDP 的口径），带一个空格的 text", () => {
    const r = ok("Space");
    expect(r.down.key).toBe(" ");
    expect(r.down.code).toBe("Space");
    expect(r.down.text).toBe(" ");
    // 回报给模型的名字仍是 "Space"——拿 CDP 的 `key`（一个空格）去回报，结果里会出现句子里
    // 夹一个空格："Pressed   on <input>"。
    expect(r.label).toBe("Space");
  });

  it("键名大小写不敏感（模型写 enter 也算）", () => {
    expect(ok("enter").down.windowsVirtualKeyCode).toBe(13);
  });
});

describe("resolveKey：修饰键组合", () => {
  it("Ctrl+A → 位掩码 2（Alt=1/Ctrl=2/Meta=4/Shift=8），走 rawKeyDown", () => {
    const r = ok("a", ["ctrl"]);
    expect(r.down.modifiers).toBe(2);
    expect(r.down.key).toBe("a");
    expect(r.down.code).toBe("KeyA");
    expect(r.down.type).toBe("rawKeyDown");
  });

  it("Shift+Tab → 位掩码 8", () => {
    expect(ok("Tab", ["shift"]).down.modifiers).toBe(8);
  });

  it("多个修饰键相加", () => {
    expect(ok("a", ["ctrl", "shift"]).down.modifiers).toBe(10);
  });
});

describe("resolveKey：拒绝的三类", () => {
  it("单字符**没有修饰键** → 拒绝并指回 fill（press 不是打字机）", () => {
    const r = resolveKey("a", []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("fill");
  });

  it("不认识的键 → 拒绝，并把支持的键列出来", () => {
    const r = resolveKey("F5", []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("F5");
    for (const k of ["Enter", "Escape", "Tab", "ArrowDown"]) {
      expect(r.error).toContain(k);
    }
  });

  it("不认识的修饰键 → 拒绝", () => {
    const r = resolveKey("Enter", ["hyper"]);
    expect(r.ok).toBe(false);
  });
});

describe("SUPPORTED_KEYS", () => {
  it("每个键都能解析（表与校验同源，漏一个就是文案骗人）", () => {
    for (const k of SUPPORTED_KEYS) {
      expect(resolveKey(k, []).ok, k).toBe(true);
    }
  });
});
