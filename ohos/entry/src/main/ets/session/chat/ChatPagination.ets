/**
 * P1 双向分页（字节游标）：hydrate 尾页 + 上滚取更早页。
 *
 * 过筛自 packages/aide-sdk/src/composables/useChatSession/pagination.ts。
 * 游标 = tailOffset（最老已加载页的页首字节）——取回后前进为 nextOffsetBytes，
 * 内容必然前进不重复。上游页台账（pageLedgers，页级回收 recycle 的重放依据）
 * 未过筛：ohos 端不回收页，台账无消费方，仅保 endOffsetBytes 透传于 DTO。
 *
 * ⚠️ 必须保持 d88dd73c 的修复（上游曾实锤的状态粘滞 bug）：
 * hydrate 在 await 前先置 hydrated=true，失败不回滚会让 skip 分支拦截一切
 * 后续加载——单例 store 里一次失败（断线 reject / 响应形状异常）把会话
 * 永久钉死在「此会话暂无消息」空态。两条失败路径都必须回滚 hydrated=false：
 *  - catch：断线 / 桌面忙；
 *  - EMPTY-RESULT 非：响应形状异常（版本错配/网关裁剪）。
 * 合法空数组（真空会话）保持 true 不重试。重试/重开由此可恢复。
 */
import { api } from '../../sdk/api';
import { LoadMessagesResult } from '../../sdk/types';
import { ChatStore } from './ChatStore';
import { ChatMessage } from './ChatBlocks';
import { itemsToChatMessages } from './ChatTranscript';

/** hydrate / 上滚取回的页字节预算（后端 load_messages limit 语义；
 *  大 tool_result 占预算多则页内条数自适应收缩）。 */
const HYDRATE_PAGE_BYTES = 256 * 1024;

/**
 * 首屏加载：只取尾部一页，建立游标。已有数据（重连重载前的 live 段）走
 * 「游标缺失探测」分支：最小页探测拿 tailOffset 恢复上滚取回（消息丢弃
 * 不 unshift；台账不补——live 段全量视为未分页，下次重开 hydrate 自然重建）。
 */
export async function hydrate(store: ChatStore): Promise<void> {
  const sid: string = store.sid;
  if (sid === '') {
    return;
  }
  if (store.hydrated || store.messages.length > 0) {
    store.hydrated = true;
    if (store.messages.length > 0 && !store.cursorReady) {
      try {
        const result: LoadMessagesResult | null = await api.loadMessages(sid, null, 1);
        if (store.sid !== sid) {
          return; // 在途请求期间已切走：丢弃，不串写新会话
        }
        if (result !== null && Array.isArray(result.messages)) {
          store.tailOffset = result.nextOffsetBytes;
          store.cursorReady = true;
        }
      } catch (e) {
        // 探测失败：上滚暂不可用，不影响已就绪的消息展示
      }
    }
    return;
  }
  store.hydrated = true;
  store.hydrateFailed = false;
  try {
    const result: LoadMessagesResult | null = await api.loadMessages(sid, null, HYDRATE_PAGE_BYTES);
    if (store.sid !== sid) {
      return; // 在途请求期间已切走：丢弃，不串写新会话
    }
    if (result === null || !Array.isArray(result.messages)) {
      // 响应形状异常不是「真空会话」：回滚 hydrated 让重试/重开可恢复
      store.hydrated = false;
      store.hydrateFailed = true;
      return;
    }
    // hydrate 期间可能已有实时消息进来：历史插到最前
    const msgs: ChatMessage[] = itemsToChatMessages(result.messages);
    store.replaceAllMessages(msgs.concat(store.messages));
    // 尾部页游标：nextOffsetBytes 0 = 无更早页，上滚「到此为止」
    store.tailOffset = result.nextOffsetBytes;
    store.cursorReady = true;
    store.bumpTail();
  } catch (e) {
    if (store.sid !== sid) {
      return; // 失败回写前会话已切走：不污染新会话的 hydrate 状态
    }
    // 加载失败（断线/桌面忙）：回滚 hydrated，重试/重开可恢复
    store.hydrated = false;
    store.hydrateFailed = true;
  }
}

/** 取更早一页 unshift 头部 + 游标前进；失败静默（入口仍在，用户可重按）。 */
export async function loadOlder(store: ChatStore): Promise<void> {
  if (store.tailOffset === 0 || store.loadingOlder || store.sid === '') {
    return;
  }
  const sid: string = store.sid;
  store.loadingOlder = true;
  try {
    const result: LoadMessagesResult | null = await api.loadMessages(sid, store.tailOffset, HYDRATE_PAGE_BYTES);
    if (store.sid !== sid) {
      return;
    }
    if (result !== null && Array.isArray(result.messages)) {
      const msgs: ChatMessage[] = itemsToChatMessages(result.messages);
      store.replaceAllMessages(msgs.concat(store.messages));
      store.tailOffset = result.nextOffsetBytes;
    }
  } catch (e) {
    // 失败静默：按钮可重按
  } finally {
    store.loadingOlder = false;
  }
}
