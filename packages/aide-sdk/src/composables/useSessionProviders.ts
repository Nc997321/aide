import { reactive } from "vue";

/**
 * 会话 id → 所属 provider id 的模块级注册表（与 useSessionNames / useSessionWorkspaces
 * 同构）。
 *
 * 用来让"已启动会话"的模型下拉在用户全局切换供应商时**不被影响**：存活会话锁定
 * 它 spawn 那一刻的 provider，下拉一直展示那个 provider 的模型；只有用户主动
 * stop_session（`clearProvider`）后才回落到全局 active provider，下一次发消息再用
 * 新 provider spawn（见 useChatSession.sendMessage / stopSession / finalizeSession）。
 *
 * 写入方：useChatSession（sendMessage 时若会话不存活则记绑定 = 即将 spawn）。
 * 读取方：ChatPanel（模型下拉以 `providerOf(sessionId) ?? activeProviderId` 为准）。
 */
const providers = reactive<Record<string, string>>({});

export function useSessionProviders() {
  function setProvider(sessionId: string, providerId: string) {
    if (!sessionId || !providerId) return;
    providers[sessionId] = providerId;
  }

  function providerOf(sessionId: string): string | null {
    return providers[sessionId] ?? null;
  }

  /** 释放绑定：stop_session 后下拉回落到全局 active provider，体现"stop 后供应商
   *  才改变"。下一次发消息会重新 setProvider 记下新 spawn 的 provider。 */
  function clearProvider(sessionId: string) {
    delete providers[sessionId];
  }

  /** 临时 key → SDK 真实 id：与 stores/aliasMap/sessionState 同步迁移，避免临时 id
   *  落盘前绑定丢失。 */
  function migrateProvider(oldId: string, newId: string) {
    if (providers[oldId]) {
      providers[newId] = providers[oldId];
      delete providers[oldId];
    }
  }

  return { providers, setProvider, providerOf, clearProvider, migrateProvider };
}