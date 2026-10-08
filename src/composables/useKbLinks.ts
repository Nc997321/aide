import { computed, ref } from "vue";
import { api } from "@aide/sdk/api";
import { pathBasename } from "@/utils/fileIcons";
import { useWorkspaces } from "@/composables/useWorkspaces";

/**
 * 知识库「关联项目」：哪些本 Host 上的工作区与某个文档 / 文件夹相关。
 *
 * 关联项目的作用只有一个：用 AI 改这篇文档时，它能**只读地参考**这些项目的记忆
 * （引擎里的 read_memory，不授予那些项目的任何文件访问）。没有关联就只带日常记忆。
 * 映射存 Host（`~/.aide/kb-links.json`），不跟知识库服务端走：工作区是这台机器的东西。
 *
 * 文件夹的关联由其下所有文档继承（取并集，最近的先）；文档自己可以再加，不提供「在文件上取消继承」。
 */

export type LinkTable = Record<string, string[]>;

export interface EffectiveLink {
  key: string;
  /** direct = 打在这个节点自己身上；否则是继承来源的节点 id（祖先文件夹）。 */
  from: "direct" | string;
}

/** 纯函数：某节点生效的关联——自己直接打的在前，然后是祖先（`ancestors` 从最近的父到根），
 *  同一个工作区只出现一次，保留最先出现的来源。 */
export function effectiveLinks(table: LinkTable, nodeId: string, ancestors: readonly string[]): EffectiveLink[] {
  const out: EffectiveLink[] = [];
  const seen = new Set<string>();
  const add = (from: EffectiveLink["from"], keys: string[] | undefined): void => {
    for (const key of keys ?? []) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, from });
    }
  };
  add("direct", table[nodeId]);
  for (const a of ancestors) add(a, table[a]);
  return out;
}

export interface LinkedProject {
  key: string;
  /** 工作区根目录；找不到这个工作区时为空串。 */
  path: string;
  label: string;
  /** 工作区已不在注册表里 / 目录已不存在：界面标成警示，**不静默丢掉**——用户得知道 AI 少了一份上下文。 */
  missing: boolean;
}

const table = ref<LinkTable>({});
let loaded: Promise<void> | null = null;

export function useKbLinks() {
  const { workspaces, refresh } = useWorkspaces();

  async function load(force = false): Promise<void> {
    if (force) loaded = null;
    loaded ??= api
      .kbLinks()
      .then((t) => {
        table.value = t;
      })
      .catch((e: unknown) => {
        // 读不到只是少一份上下文：不阻塞知识库，也不缓存失败（下次再试）
        console.warn("[kb-links] 读取关联项目失败", e);
        loaded = null;
      });
    if (workspaces.value.length === 0) void refresh();
    return loaded ?? Promise.resolve();
  }

  /** 工作区 key → 展示信息。 */
  function resolve(key: string): LinkedProject {
    const w = workspaces.value.find((x) => x.key === key);
    if (!w) return { key, path: "", label: key, missing: true };
    return { key, path: w.name, label: pathBasename(w.name) || w.name, missing: w.missing };
  }

  /** 这个节点直接关联的 key。 */
  function directKeys(nodeId: string): string[] {
    return table.value[nodeId] ?? [];
  }

  /** 打开 / 关掉某个节点对某个工作区的直接关联。 */
  async function toggle(nodeId: string, key: string): Promise<void> {
    const cur = directKeys(nodeId);
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    table.value = await api.setKbLinks(nodeId, next);
  }

  /** 发给 AI 的关联根目录：生效关联里**存在**的工作区路径。缺失的不下发（读不到它的记忆），
   *  但在界面上仍显示警示（见 LinkedProject.missing）。 */
  function rootsOf(links: readonly EffectiveLink[]): string[] {
    return links.map((l) => resolve(l.key)).filter((p) => !p.missing && p.path).map((p) => p.path);
  }

  /** 「关联项目…」菜单的数据：每个已注册工作区一行。自己直接关联的 linked=true；只从祖先继承来的
   *  带上来源文件夹的名字（`titleOf` 把节点 id 换成展示名）。 */
  function menuProjects(nodeId: string, ancestors: readonly string[], titleOf: (id: string) => string) {
    const eff = effectiveLinks(table.value, nodeId, ancestors);
    return workspaces.value.map((w) => {
      const hit = eff.find((l) => l.key === w.key);
      return {
        key: w.key,
        label: pathBasename(w.name) || w.name,
        linked: hit?.from === "direct",
        ...(hit && hit.from !== "direct" ? { inheritedFrom: titleOf(hit.from) } : {}),
      };
    });
  }

  return { table: computed(() => table.value), workspaces, load, resolve, directKeys, toggle, rootsOf, menuProjects };
}

/** 测试用。 */
export function __resetKbLinksForTest(): void {
  table.value = {};
  loaded = null;
}
