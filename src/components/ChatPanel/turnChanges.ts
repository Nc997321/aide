/**
 * 回合结算卡的数据契约（App 提供 → ChatPanel 注入 → 卡片消费）。
 *
 * 为什么走 provide 而不是逐层透传 props：PaneLayout → PaneSplit（递归）→ PaneGroup
 * → ChatPanel 要为这一个叶子加四个文件的转发；且这份数据**必须**是 App 里
 * useConversationChanges 的唯一实例（归集器的 drain 取走即清空，两个实例会把
 * 同一轮的文件劈成两半，两边都显示不全）。provide 的既有先例见
 * `src/components/panelayout/keys.ts`（WORKSPACE_PATH_KEY）。
 */
import type { InjectionKey, Ref } from "vue";
import type { ChangeRound } from "@/types";

export interface TurnChangesFeed {
  /** 这份数据属于哪个会话（= 聚焦组活动 tab）。卡片与面板的会话不等时整卡不渲染。 */
  sid: string;
  /** 就是右栏变更面板读的那一份 rounds，不是副本。 */
  rounds: ChangeRound[];
  /** 单文件撤回（与面板同一个实例的方法：撤回是唯一的破坏性操作，
   *  必须钉在会话所属工作区上，见 useConversationChanges.revertFile）。 */
  revertSingleFile: (round: ChangeRound, filePath: string) => Promise<void>;
}

export const TURN_CHANGES_KEY: InjectionKey<Ref<TurnChangesFeed>> = Symbol("aide:turnChanges");
