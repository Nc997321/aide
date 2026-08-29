import { ref } from "vue";
import { api } from "../api";

// 工作区信任态（Trusted Workspace）— 模块级单例，跨组件共享：
// 侧栏徽标（SidebarLeft）与 CodeGraph 门控（useCodeGraphProgress）共用一份。
//
// 路径作身份：前端始终拿得到路径（侧栏 ws.name、CodeGraph root），Rust 内部
// trust_key_from_path 归一（path_to_key 后点号→横杠）。这里 untrustedPaths 存
// 原始路径，仅用于徽标的响应式渲染与去重；真实信任查询走 api.isWorkspaceTrusted
// （Rust 权威）。查询失败一律按不信任处理（安全侧）。

const untrustedPaths = ref<Set<string>>(new Set());
// 本会话已弹过信任提示的路径（内存去重，不持久；「暂不信任」后本会话不再弹，
// 下次启动再弹——拒绝不是永久决定）。
const promptedThisSession = new Set<string>();

export function useWorkspaceTrust() {
  /** 查询某路径是否信任（走 Rust，不缓存）。失败按不信任返回。 */
  async function isTrusted(path: string): Promise<boolean> {
    if (!path) return false;
    try {
      return await api.isWorkspaceTrusted(path);
    } catch {
      return false;
    }
  }

  /** 批量刷新一组路径的信任态，更新 untrustedPaths（供侧栏渲染工作区碎盾图标/⋯ 菜单信任入口）。 */
  async function refreshFor(paths: string[]): Promise<void> {
    const next = new Set<string>();
    await Promise.all(
      paths.map(async (p) => {
        if (!p) return;
        const trusted = await api.isWorkspaceTrusted(p).catch(() => false);
        if (!trusted) next.add(p);
      }),
    );
    untrustedPaths.value = next;
  }

  /** 信任一个工作区（持久化），从 untrustedPaths 移除。返回是否成功 + 自动写入的
   *  安全命令规则条数（信任成功但规则写入失败时 ok=true、added=0）。 */
  async function trust(path: string): Promise<{ ok: boolean; added: number }> {
    if (!path) return { ok: false, added: 0 };
    try {
      const added = await api.trustWorkspace(path);
      const next = new Set(untrustedPaths.value);
      next.delete(path);
      untrustedPaths.value = next;
      return { ok: true, added };
    } catch {
      return { ok: false, added: 0 };
    }
  }

  /** 取消信任（持久化），加入 untrustedPaths。返回是否成功 + 移除的自动规则条数。 */
  async function untrust(path: string): Promise<{ ok: boolean; removed: number }> {
    if (!path) return { ok: false, removed: 0 };
    try {
      const removed = await api.untrustWorkspace(path);
      const next = new Set(untrustedPaths.value);
      next.add(path);
      untrustedPaths.value = next;
      return { ok: true, removed };
    } catch {
      return { ok: false, removed: 0 };
    }
  }

  /** 本会话是否该为此路径弹信任提示（未弹过 → true）。 */
  function shouldPrompt(path: string): boolean {
    return !!path && !promptedThisSession.has(path);
  }

  /** 标记本会话已为此路径弹过提示（信任或暂不都算）。 */
  function markPrompted(path: string): void {
    if (path) promptedThisSession.add(path);
  }

  return {
    untrustedPaths,
    isTrusted,
    refreshFor,
    trust,
    untrust,
    shouldPrompt,
    markPrompted,
  };
}