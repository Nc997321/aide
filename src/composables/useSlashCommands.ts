import { ref, watch, computed, type Ref, type ComputedRef } from "vue";
import { api } from "../api";
import type { SkillMeta } from "../types";

/** useSlashCommands 对外暴露的下拉选项形状——纯 UI 派生数据，不进入
 *  核心 ChatEvent 协议，所以就近定义在这里，不放进 types/chat.ts。 */
export interface SlashCommandOption {
  name: string;
  description?: string;
}

/**
 * "/" 下拉框的命令发现与数据源切换：
 * - 会话未开始（sdkCommands 为 null）：用 Rust 本地扫描的 .claude/skills 富清单
 *   （含 description）兜底，workspacePath 变化时重新扫描。
 * - 一旦本次会话收到过 SDK 权威清单（sdkCommands 非 null）：单向切换为纯命令名，
 *   不再展示描述，也不会因为 workspacePath 之后再变化而回退到本地清单。
 */
export function useSlashCommands(
  workspacePath: Ref<string | undefined>,
  sdkCommands: ComputedRef<string[] | null>,
) {
  const localSkills = ref<SkillMeta[]>([]);

  watch(
    workspacePath,
    async (ws) => {
      try {
        localSkills.value = await api.scanPluginSkills(ws ?? "");
      } catch {
        localSkills.value = [];
      }
    },
    { immediate: true },
  );

  const dropdownOptions = computed<SlashCommandOption[]>(() =>
    sdkCommands.value === null
      ? localSkills.value.map((s) => ({ name: s.name, description: s.description }))
      : sdkCommands.value.map((name) => ({ name })),
  );

  return { dropdownOptions };
}
