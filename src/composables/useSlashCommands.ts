import { ref, watch, computed, onScopeDispose, getCurrentScope, type ComputedRef, type Ref } from "vue";
import { api } from "@aide/sdk/api";
import { listen } from "@aide/sdk";
import type { SkillMeta } from "../types";
import { useQuickActions } from "./useQuickActions";

/** "/" 下拉的一行——纯 UI 派生数据，不进入核心 ChatEvent 协议，就近定义在这里。 */
export interface SlashCommandOption {
  name: string;
  /** SDK 清单只给命令名，没有描述时为空串。 */
  description: string;
  /** 来源角标："内置" / 技能的 source（user、project、plugin:x）/ 空 = SDK 清单里的其余命令。 */
  source: string;
}

/**
 * "/" 下拉框的命令发现。三路来源**合并**（按名去重，先到先得）：
 *  1. 命令注册表（useQuickActions：/btw /compact /clear）——Aide 自己分发的，恒在；
 *  2. Rust 本地扫描的技能清单——带描述，会话开始前就有，发送时把 SKILL.md 内联
 *     （所以 `localSkills` 也要交给发送路径）；
 *  3. 本会话收到的 SDK 权威清单（system/init 的 slash_commands）里剩下的命令
 *     ——只有名字，原文发给引擎执行。会话开始前为 null，不借别的会话学到的清单。
 *
 * 不做「切换」：切到 SDK 清单会丢掉技能描述，而且第 3 路要等会话开始才有。
 */
export function useSlashCommands(
  workspacePath: () => string | undefined,
  sdkCommands: () => string[] | null,
): { options: ComputedRef<SlashCommandOption[]>; localSkills: Ref<SkillMeta[]> } {
  const localSkills = ref<SkillMeta[]>([]);
  const { actions } = useQuickActions();

  const revision = ref(0);
  const removedPluginSkills = ref(new Set<string>());
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const subscription = listen("plugins-changed", () => { revision.value++; });
  void subscription.then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  }).catch(() => { /* 无事件传输时仍可按工作区扫描 */ });
  if (getCurrentScope()) onScopeDispose(() => {
    disposed = true;
    unlisten?.();
  });

  // 先订阅再扫描，避免初次扫描期间错过插件变更。
  watch(
    [workspacePath, revision],
    async ([ws], _previous, onCleanup) => {
      let stale = false;
      onCleanup(() => { stale = true; });
      await subscription.catch(() => {});
      if (stale || disposed) return;
      try {
        const skills = await api.scanPluginSkills(ws ?? "");
        if (stale || disposed) return;
        const names = new Set(skills.map((s) => s.name));
        const removed = new Set(removedPluginSkills.value);
        for (const skill of localSkills.value) {
          if (skill.source.startsWith("plugin:") && !names.has(skill.name)) removed.add(skill.name);
        }
        for (const name of names) removed.delete(name);
        removedPluginSkills.value = removed;
        localSkills.value = skills;
      } catch {
        if (!stale && !disposed) localSkills.value = [];
      }
    },
    { immediate: true },
  );

  const options = computed<SlashCommandOption[]>(() => {
    const all: SlashCommandOption[] = [
      ...actions.map((a) => ({ name: a.command, description: a.label, source: "内置" })),
      ...localSkills.value.map((s) => ({ name: s.name, description: s.description, source: s.source })),
      // 已卸载技能不能被存活会话的旧 SDK 清单重新补回来。
      ...(sdkCommands() ?? []).filter((name) => !removedPluginSkills.value.has(name)).map((name) => ({ name, description: "", source: "" })),
    ];
    const seen = new Set<string>();
    return all.filter((o) => !seen.has(o.name) && !!seen.add(o.name));
  });

  return { options, localSkills };
}

/** 按输入过滤：包含即命中，前缀命中的排前面（打 `/c` 先看到 compact / clear）。 */
export function filterSlashCommands(options: SlashCommandOption[], query: string): SlashCommandOption[] {
  const q = query.toLowerCase();
  const hits = options.filter((o) => o.name.toLowerCase().includes(q));
  return [
    ...hits.filter((o) => o.name.toLowerCase().startsWith(q)),
    ...hits.filter((o) => !o.name.toLowerCase().startsWith(q)),
  ];
}
