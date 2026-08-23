// vimExCommands 单测：mock 掉 @replit/codemirror-vim 的 Vim.defineEx（全局注册表
// 不可达），捕获注册的回调后直接驱动——等价于 vim-core 的 exCommandDispatcher
// 按最长前缀命中后调用 exCommands[name](cm, params)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EditorView } from "@codemirror/view";

const registrations = vi.hoisted(() => new Map<string, (cm: unknown, params: Record<string, unknown>) => void>());

vi.mock("@replit/codemirror-vim", () => ({
  Vim: {
    defineEx: (name: string, _prefix: string | undefined, fn: (cm: unknown, params: Record<string, unknown>) => void) => {
      registrations.set(name, fn);
    },
  },
  CodeMirror: class {},
}));

import { registerVimExCommands, unregisterVimExCommands } from "./vimExCommands";

/** 模拟 ex 分发：按注册名取回调直接调用（与 vim-core _processCommand 的
 *  exCommands[commandName](cm, params) 等价） */
function fireVim(view: EditorView, name: string, argString?: string) {
  const fn = registrations.get(name);
  if (!fn) throw new Error(`ex command "${name}" not registered`);
  fn({ cm6: view }, { argString: argString ?? "", input: name + argString, commandName: name });
}

describe("vimExCommands", () => {
  it("register_and_fire_dispatches_to_handler", () => {
    const view = {} as EditorView;
    const handler = vi.fn();
    registerVimExCommands(view, handler);
    fireVim(view, "w");
    expect(handler).toHaveBeenCalledWith("w");
  });

  it("unregister_stops_routing", () => {
    const view = {} as EditorView;
    const handler = vi.fn();
    registerVimExCommands(view, handler);
    unregisterVimExCommands(view);
    fireVim(view, "w");
    expect(handler).not.toHaveBeenCalled();
  });

  it("unknown_view_is_silently_ignored", () => {
    const view = {} as EditorView;
    const handler = vi.fn();
    registerVimExCommands(view, handler);
    // 未注册的 view（编辑器销毁竞态）：不抛、不路由
    const otherView = {} as EditorView;
    fireVim(otherView, "w");
    expect(handler).not.toHaveBeenCalled();
  });

  it("multiple_views_route_to_their_own_handler", () => {
    const viewA = {} as EditorView;
    const viewB = {} as EditorView;
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    registerVimExCommands(viewA, handlerA);
    registerVimExCommands(viewB, handlerB);
    fireVim(viewA, "wq");
    expect(handlerA).toHaveBeenCalledWith("wq");
    expect(handlerB).not.toHaveBeenCalled();
    fireVim(viewB, "w");
    expect(handlerB).toHaveBeenCalledWith("w");
    expect(handlerA).toHaveBeenCalledTimes(1);
  });

  it("define_ex_registered_once_globally", () => {
    const view = {} as EditorView;
    registerVimExCommands(view, vi.fn());
    registerVimExCommands({} as EditorView, vi.fn()); // 二次注册不再重复 defineEx
    expect(registrations.size).toBe(3); // w / wq / q
  });

  it("q_without_bang_dispatches_q", () => {
    const view = {} as EditorView;
    const handler = vi.fn();
    registerVimExCommands(view, handler);
    fireVim(view, "q", "");
    expect(handler).toHaveBeenCalledWith("q");
  });

  it("q_bang_dispatches_q_bang", () => {
    const view = {} as EditorView;
    const handler = vi.fn();
    registerVimExCommands(view, handler);
    fireVim(view, "q", "!");
    expect(handler).toHaveBeenCalledWith("q!");
  });

  it("q_bang_with_spaces_dispatches_q_bang", () => {
    const view = {} as EditorView;
    const handler = vi.fn();
    registerVimExCommands(view, handler);
    fireVim(view, "q", " ! ");
    expect(handler).toHaveBeenCalledWith("q!");
  });
});
