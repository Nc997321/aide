import { useFileViewer, isWindowDirty, type FileWindowState } from "../../composables/useFileViewer";
import { useModal } from "../../composables/useModal";

/**
 * 关一个文件窗口：干净直接关；当前文件或跳转栈里的文件有未保存修改时让用户选
 * （保存并关闭 / 放弃修改 / 取消）。返回 false = 用户取消或保存失败，窗口还开着。
 * 关闭按钮、:q、标题栏右键「关闭其他」共用这一份，未保存修改不会被批量关闭悄悄丢掉。
 */
export async function requestCloseWindow(win: FileWindowState): Promise<boolean> {
  const { save, closeWindow, navStackHasDirty } = useFileViewer();
  const dirty = isWindowDirty(win);
  const stackDirty = navStackHasDirty(win);
  if (dirty || stackDirty) {
    const msg = dirty
      ? stackDirty
        ? `「${win.fileName}」和跳转前打开的文件都有未保存的修改。「保存并关闭」只保存当前文件。`
        : `「${win.fileName}」有未保存的修改。`
      : "跳转前打开的文件有未保存的修改，关闭将丢弃。";
    const res = await useModal().choice("关闭文件", msg, {
      confirmLabel: "保存并关闭",
      altLabel: "放弃修改",
    });
    if (res === "cancel") return false;
    if (res === "confirm") {
      await save(win.id);
      // 保存失败（error 已显示）就停，别静默丢内容
      if (isWindowDirty(win)) return false;
    }
  }
  closeWindow(win.id);
  return true;
}

/** 关闭除 keepId 外的所有窗口；有未保存修改的逐个确认（先聚焦它，让用户看清是哪个），取消即停。 */
export async function closeOtherWindows(keepId: string): Promise<void> {
  const { windows, focusWindow } = useFileViewer();
  const others = windows.value.filter((w) => w.id !== keepId);
  for (const w of others) {
    if (isWindowDirty(w) || useFileViewer().navStackHasDirty(w)) focusWindow(w.id);
    if (!(await requestCloseWindow(w))) return;
  }
  focusWindow(keepId);
}
