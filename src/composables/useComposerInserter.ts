import { ref } from "vue";

export interface ComposerTextRequest {
  text: string;
  nonce: number;
}

/**
 * 「往选中会话的输入框里填一段文字」的注入通道（模块级单例），侧栏应用的 `aide.composer.fill` 走它。
 *
 * 与 {@link ./useMentionInserter.ts} 同一范式：请求方只放一个待办，不知道也不该知道哪个输入框是
 * 「选中的会话」——由聚焦组激活 tab 的那个 ChatInputBox 认领并清空，其余实例无视。
 *
 * **只填、不发**：发不发永远是用户按的。应用替用户发消息 = 应用能指挥 agent，那是另一个量级的权限。
 */
const pending = ref<ComposerTextRequest | null>(null);
let nextNonce = 0;

export function useComposerInserter() {
  function insertText(text: string) {
    pending.value = { text, nonce: ++nextNonce };
  }

  /** ChatInputBox 侧（仅聚焦实例）：取走待填文字（一次性），无则返回 null。 */
  function consumeText(): ComposerTextRequest | null {
    const p = pending.value;
    pending.value = null;
    return p;
  }

  return { pending, insertText, consumeText };
}
