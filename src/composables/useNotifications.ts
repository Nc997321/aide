import { ref, computed, readonly } from "vue";
import { api } from "../api";
import type { AppNotification, NotificationRecord, NotificationSeverity } from "../types";

/**
 * 应用内通知中心（模块级 reactive 单例）。
 *
 * push 是纯前端内存操作（立即反映到 UI）；severity ∈ {error, warning} 时
 * debounce 500ms 触发 save_notifications 落盘；info 仅内存。
 * 读路径：启动时 hydrate() 一次从盘注入 error/warning 为未读。
 *
 * 去重：dedupKey 命中未读项 → 原地更新（count++、timestamp 刷新）；命中已读项视为新条目。
 * 落盘内容：不含 info、不含已 dismiss 项、不含 read 状态（重启回到未读）。
 * 软上限 100 条，落盘时按 timestamp 降序截断（Rust 侧再兜一道）。
 *
 * action 派发：action.url → 浏览器打开（调用方处理）；无 url → triggerAction 查
 * source→handler 注册表派发（源 composable 自己注册）。
 */

const notifications = ref<AppNotification[]>([]);
const unreadCount = computed(() => notifications.value.filter((n) => !n.read).length);

const PERSIST_LIMIT = 100;
const SAVE_DEBOUNCE_MS = 500;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const actionHandlers = new Map<string, (n: AppNotification) => void>();

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `n_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function persistableRecords(): NotificationRecord[] {
  return notifications.value
    .filter((n) => n.severity === "error" || n.severity === "warning")
    .map((n) => ({
      id: n.id,
      severity: n.severity as "error" | "warning",
      source: n.source,
      title: n.title,
      body: n.body,
      timestamp: n.timestamp,
      dedupKey: n.dedupKey,
      count: n.count,
      action: n.action,
    }));
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void api.saveNotifications(persistableRecords()).catch(() => {
      // 落盘失败不阻塞 UI（fire-and-forget）
    });
  }, SAVE_DEBOUNCE_MS);
}

function flushSaveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  void api.saveNotifications(persistableRecords()).catch(() => {});
}

export function useNotifications() {
  return {
    notifications: readonly(notifications),
    unreadCount: readonly(unreadCount),

    push(n: Omit<AppNotification, "id" | "read" | "count"> & Partial<{ count: number; id: string }>): void {
      // 去重：dedupKey 命中未读项 → 合并
      if (n.dedupKey) {
        const idx = notifications.value.findIndex(
          (x) => x.dedupKey === n.dedupKey && !x.read,
        );
        if (idx >= 0) {
          const existing = notifications.value[idx];
          notifications.value.splice(idx, 1, {
            ...existing,
            title: n.title,
            body: n.body ?? existing.body,
            timestamp: n.timestamp,
            count: (existing.count ?? 1) + 1,
            action: n.action ?? existing.action,
            severity: n.severity as NotificationSeverity,
            source: n.source,
          });
          if (n.severity === "error" || n.severity === "warning") scheduleSave();
          return;
        }
      }
      const entry: AppNotification = {
        id: n.id ?? genId(),
        severity: n.severity as NotificationSeverity,
        source: n.source,
        title: n.title,
        body: n.body,
        timestamp: n.timestamp,
        dedupKey: n.dedupKey,
        count: n.count ?? 1,
        action: n.action,
        read: false,
      };
      // 插入并保持 timestamp 降序
      const list = notifications.value;
      let i = 0;
      while (i < list.length && list[i].timestamp >= entry.timestamp) i++;
      list.splice(i, 0, entry);
      // 软上限（内存侧也截，防长期累积）
      if (list.length > PERSIST_LIMIT) list.splice(PERSIST_LIMIT);
      if (n.severity === "error" || n.severity === "warning") scheduleSave();
    },

    dismiss(id: string): void {
      const before = notifications.value.length;
      notifications.value = notifications.value.filter((n) => n.id !== id);
      if (notifications.value.length !== before) flushSaveNow();
    },

    clearAll(): void {
      if (notifications.value.length === 0) return;
      notifications.value = [];
      flushSaveNow();
    },

    markAllRead(): void {
      for (const n of notifications.value) n.read = true;
      // read 不落盘
    },

    async hydrate(): Promise<void> {
      try {
        const records = await api.loadNotifications();
        // 落盘项注入为未读（read:false），按 timestamp 降序
        const loaded: AppNotification[] = records.map((r) => ({
          id: r.id,
          severity: r.severity,
          source: r.source,
          title: r.title,
          body: r.body,
          timestamp: r.timestamp,
          dedupKey: r.dedupKey,
          count: r.count,
          action: r.action,
          read: false,
        }));
        loaded.sort((a, b) => b.timestamp - a.timestamp);
        // 合并：保留内存中已有（info 项不落盘，hydrate 不应覆盖它们）
        const memIds = new Set(notifications.value.map((n) => n.id));
        const merged = [...loaded.filter((n) => !memIds.has(n.id)), ...notifications.value];
        merged.sort((a, b) => b.timestamp - a.timestamp);
        notifications.value = merged;
      } catch {
        // 加载失败不崩，保持空
      }
    },

    registerActionHandler(source: string, fn: (n: AppNotification) => void): void {
      actionHandlers.set(source, fn);
    },

    triggerAction(id: string): void {
      const n = notifications.value.find((x) => x.id === id);
      if (!n) return;
      if (n.action?.url) {
        // url 由 NotificationBell 调 open 处理；triggerAction 只负责无 url 的派发
        return;
      }
      const handler = actionHandlers.get(n.source);
      if (handler) handler(n);
    },

    __resetForTest(): void {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      notifications.value = [];
      actionHandlers.clear();
    },
  };
}