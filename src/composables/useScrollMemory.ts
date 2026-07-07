/**
 * 文件窗口滚动位置的会话级记忆（状态层）。
 *
 * 纯内存 Map，不落盘：同一次运行内关掉再打开同一文件，恢复上次滚动位置；
 * 应用重启（webview 重建）随模块一起清空，天然满足「重启即忘」。
 *
 * key 由调用方拼，约定 `${filePath}#${视图类型}`——同一文件的编辑器 /
 * Markdown 预览 / 只读 pre 的滚动度量互不通用，必须分开记。
 * 事件层接入点：CodeMirror 走 extensions/cmScrollMemory，
 * 普通滚动容器走 v-scroll-memory 指令（directives/scrollMemory.ts）。
 */

const positions = new Map<string, number>();

export function useScrollMemory() {
  function remember(key: string, scrollTop: number) {
    positions.set(key, scrollTop);
  }

  function recall(key: string): number | undefined {
    return positions.get(key);
  }

  /** 仅测试用 */
  function __resetForTest() {
    positions.clear();
  }

  return { remember, recall, __resetForTest };
}
