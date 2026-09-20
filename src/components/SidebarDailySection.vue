<script setup lang="ts">
import { timeAgo } from "../utils/time";
import { useSessionNames } from "../composables/useSessionNames";
import { useSessionState } from "../composables/useSessionState";
import type { Session } from "../types";
import SidebarSectionHead from "./SidebarSectionHead.vue";

/**
 * 侧栏「日常」根分区：与「项目」「自动化」平级的第三个根分区（用户 2026-09-21 定）。
 *
 * 与工作区那一支的差别只有一条：**没有工作区行那一层** —— 会话直接挂在分区下面
 * （同「自动化」的任务节点）。会话行的视觉与工作区里的一致：分区头复用
 * SidebarSectionHead，行样式沿用 SidebarLeft 的 .session-row 约定。
 *
 * 独立成组件而不是塞进 SidebarLeft（那里已 700+ 行）：这里有一个可测的边界，
 * 也不碰现有工作区循环（零回归面）。
 */
defineProps<{
  sessions: Session[];
  activeSessionId: string;
  collapsed: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  /** 分区头 ⋯：携带 MouseEvent 供父级定位上下文菜单（与工作区/自动化同一范式） */
  menu: [e: MouseEvent];
  select: [sid: string];
  /** 会话行右键：载荷具名对象化，避免相邻同型参数错位 */
  contextmenu: [payload: { event: MouseEvent; sid: string }];
}>();

const { dotTone } = useSessionState();
const sessionNames = useSessionNames();
</script>

<template>
  <SidebarSectionHead
    label="日常"
    :count="sessions.length || undefined"
    :expanded="!collapsed"
    @toggle="emit('toggle')"
    @menu="(e: MouseEvent) => emit('menu', e)"
  >
    <template #icon>
      <!-- 对话气泡（与「项目」的层叠图标、自动化的闹钟区分开） -->
      <svg viewBox="0 0 24 24" fill="none">
        <path
          d="M21 12C21 16.42 16.97 20 12 20C10.8 20 9.66 19.79 8.62 19.41L4 21L5.35 17.03C4.5 15.62 4 13.87 4 12C4 7.58 7.58 4 12 4C16.97 4 21 7.58 21 12Z"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
        />
      </svg>
    </template>
  </SidebarSectionHead>

  <div v-if="!collapsed" class="sec-subtree">
    <div v-if="sessions.length === 0" class="session-empty muted">
      还没有日常对话
    </div>
    <div v-else class="session-anim-group">
      <div
        v-for="s in sessions"
        :key="s.id"
        class="session-row"
        :class="[{ on: activeSessionId === s.id }, `tone-${dotTone(s.id)}`]"
        @click="emit('select', s.id)"
        @contextmenu.prevent="emit('contextmenu', { event: $event, sid: s.id })"
      >
        <div class="session-row-r1">
          <span class="session-name">{{ sessionNames.names[s.id] || s.name }}</span>
          <span class="session-slot" @click.stop>
            <span class="session-time">{{ timeAgo(s.timestamp) }}</span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
