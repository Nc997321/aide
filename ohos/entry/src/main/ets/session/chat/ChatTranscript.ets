/**
 * transcript 映射（纯函数层）：Rust 侧重建的历史 block → 前端渲染用内容块。
 *
 * 过筛自 packages/aide-sdk/src/composables/useChatSession/transcriptMapping.ts。
 * 分页首载与上滚取回必须走同一映射——否则取回的消息形状与首次加载不一致
 * （渲染/回填分叉）。上游 evict 降级块（truncated 占位）未过筛，历史块恒为
 * 完整态；后续接入 evict 时本文件与上游同步补 truncated 分支。
 * V1 语义裁剪：assistant 的 tool_call 块不入时间线（工具仅运行期经
 * liveActivities 瞬态可见）；被工具打断的相邻思考段合并为一张卡；
 * user 的 tool_call / @引用附件保留为文件卡片。
 */
import { HistoryBlock, ChatMessageItem } from '../../sdk/types';
import {
  ContentBlock, TextBlock, ThinkingBlock, ToolCallBlock, ChatMessage
} from './ChatBlocks';
import { uuid, emptyRecord } from './ChatWire';

/** @mention 引用段：transcript 落盘的用户文本 = 原文 + 引用文件展开内容。 */
interface MentionSection {
  path: string;
  content: string;
}

interface MentionSplit {
  displayText: string;
  sections: MentionSection[];
}

/**
 * 拆出用户文本里的 @mention 引用段（上游 fileMentions.splitMentionSections）。
 * 不拆的话整个文件原文会灌进用户气泡；拆回「原文 + N 个 Read 附件卡片」。
 * 上游用 replace(regex, cb) 拼接，ArkTS 改 exec 循环拼接等价实现。
 */
function splitMentionSections(text: string): MentionSplit {
  const sections: MentionSection[] = [];
  const re: RegExp = new RegExp('\\n*--- 引用文件：(.+) ---\\n([\\s\\S]*?)\\n--- 文件结束：\\1 ---', 'g');
  let display: string = '';
  let last: number = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const s: MentionSection = { path: m[1], content: m[2] };
    sections.push(s);
    display += text.substring(last, m.index);
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (sections.length === 0) {
    return { displayText: text, sections: sections };
  }
  display += text.substring(last);
  return { displayText: display.trim(), sections: sections };
}

/**
 * load_messages 返回的历史 block → 前端渲染块。tool_call 历史消息永远是
 * 「已完成」状态（isPending=false）——它来自一份早就落盘的 transcript，
 * 不会再有新的 tool_result 追上来。
 */
function historyBlockToContentBlocks(block: HistoryBlock, isUser: boolean): ContentBlock[] {
  if (block.type === 'tool_call') {
    if (!isUser) {
      return [];
    }
    const result: string = block.result !== undefined && block.result !== null ? block.result : '';
    return [new ToolCallBlock(
      block.id !== undefined ? block.id : uuid(),
      block.name !== undefined ? block.name : '',
      block.input !== undefined ? block.input : emptyRecord(),
      result,
      block.isError === true,
      false
    )];
  }
  if (block.type === 'thinking') {
    // 历史思考块：text 空（provider display=omitted）时不进 blocks，避免空思考区
    const t: string = block.text !== undefined ? block.text : '';
    if (t === '') {
      return [];
    }
    // 历史思考默认收起（对照 V1 原型：时间线干净，可点开回看）
    return [ThinkingBlock.history(uuid(), t)];
  }
  const text: string = block.text !== undefined ? block.text : '';
  if (!isUser) {
    return [new TextBlock(uuid(), text)];
  }
  // user 文本块拆引用段：原文 text 块 + N 个 Read 附件卡片（与直发路径同形）
  const split: MentionSplit = splitMentionSections(text);
  if (split.sections.length === 0) {
    return [new TextBlock(uuid(), split.displayText)];
  }
  const out: ContentBlock[] = [];
  if (split.displayText !== '') {
    out.push(new TextBlock(uuid(), split.displayText));
  }
  for (let i = 0; i < split.sections.length; i++) {
    const readInput: Record<string, Object> = { 'file_path': split.sections[i].path };
    out.push(new ToolCallBlock(uuid(), 'Read', readInput, split.sections[i].content, false, false));
  }
  return out;
}

/** 历史行 → ChatMessage（消息 id 每次重新生成；role 'claude' → 'assistant'）。 */
export function itemsToChatMessages(items: ChatMessageItem[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < items.length; i++) {
    const item: ChatMessageItem = items[i];
    // JSON 边界防御：坏行（形状异常）跳过，不让单条脏数据中断整页历史
    if (!Array.isArray(item.blocks)) {
      continue;
    }
    const m: ChatMessage = new ChatMessage();
    m.id = uuid();
    m.role = item.role === 'claude' ? 'assistant' : item.role;
    m.timestamp = item.timestamp;
  const blocks: ContentBlock[] = [];
  for (let j = 0; j < item.blocks.length; j++) {
    const converted: ContentBlock[] = historyBlockToContentBlocks(item.blocks[j], item.role === 'user');
    for (let k = 0; k < converted.length; k++) {
      const cb: ContentBlock = converted[k];
      // V1：工具块滤除后，被工具打断的相邻思考段合并回同一张卡——推理线
      // 本就连续（对照官方 app 每轮一个 Thinking 块）；隔 text/subagent 不合并
      const prev: ContentBlock | undefined = blocks[blocks.length - 1];
      if (cb instanceof ThinkingBlock && prev instanceof ThinkingBlock) {
        prev.text = prev.text === '' ? cb.text : `${prev.text}\n${cb.text}`;
        continue;
      }
      blocks.push(cb);
    }
  }
  m.blocks = blocks;
    out.push(m);
  }
  return out;
}
