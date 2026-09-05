/**
 * 流式事件总路由：chat-event 载荷按 type 分发到单会话 store。
 *
 * 过筛自 packages/aide-sdk/src/composables/useChatSession/events.ts
 * （handleChatEvent），按 ohos 端消费面裁剪：
 *  - 收录：文本/思考增量（思考经 store.appendThinkingDelta/sealThinking 走
 *    「流式展开 → 段收尾自动收起 → 跨工具合并续写」生命周期，见 ThinkingCard）、
 *    工具调用生命周期（V1：瞬态行 liveActivities，
 *    不入消息 blocks——运行期可见、结束即焚）、后台 shell 任务（bg_task_*，
 *    跨轮次存活，停靠区展示）、子代理时间线、权限请求队列、跳队
 *    （jump_queued/promoted）、轮次收尾（message_stop）、notification、
 *    error、session_dead、session_title
 *  - 显式忽略（随对应 UI 扩容接入）：models_available / model_switch_* /
 *    effort_changed / context_usage / context_compaction / tasks_update /
 *    rate_limit / health / permission_modes_available /
 *    slash_commands_available / image_input_*
 *  - 不收录（上游有、ohos 端无对应通路）：session_init 的 tempId 过户与
 *    非交互别名链（ohos 只从列表打开既有会话，aide id 即 sdk id）、
 *    诊断仪表盘（stalled 软超时）
 * 上游路由前有 disposedSids 拦截；ohos 等价物 = session_id 不等于当前
 * store.sid 即丢弃（btw 支线/其他会话/迟到事件不进本 store）。
 */
import { api } from '../../sdk/api';
import { sessionsModel } from '../SessionsModel';
import { ChatStore } from './ChatStore';
import {
  ContentBlock, TextBlock, ThinkingBlock, SubagentEntry, SubagentBlock,
  ChatMessage, PermissionRequest, LiveActivity, BgTask, SUBAGENT_ENTRY_CAP,
  appendSubagentTextEntry, appendBgOutput
} from './ChatBlocks';
import { uuid, str, bool, obj } from './ChatWire';

/** 流式事件总路由（对照 handleChatEvent）。 */
export function routeChatEvent(store: ChatStore, payload: Record<string, Object>): void {
  const sidRaw: string = str(payload, 'session_id');
  if (sidRaw === '' || sidRaw !== store.sid) {
    return; // 只路由当前打开的会话
  }
  const type: string = str(payload, 'type');
  if (type === '') {
    return;
  }
  switch (type) {
    case 'session_init':
      // 既有会话续聊：aide id 即 sdk id，无需过户/别名链；
      // running 标记由发送侧的 isBusy 承担
      break;
    case 'text_delta': {
      const msg: ChatMessage = store.getOrCreateAssistant();
      store.stampModel(msg, payload);
      const delta: string = str(payload, 'delta');
      const last: ContentBlock | undefined = msg.blocks[msg.blocks.length - 1];
      if (last instanceof TextBlock) {
        last.text += delta;
      } else {
        store.sealThinking(msg); // 思考让位正文：段收尾自动收起（幂等）
        msg.blocks.push(new TextBlock(uuid(), delta));
      }
      store.bumpTailThrottled(); // 流式跟尾（节流；message_stop 兜底终贴）
      break;
    }
    case 'thinking':
    case 'thinking_delta': {
      // partial=on 走 thinking_delta 逐字（delta 字段），partial=off / 历史
      // 回放走 thinking 整块（text 字段）——text ?? delta 兼容两路
      const chunk: string = str(payload, 'text') !== '' ? str(payload, 'text') : str(payload, 'delta');
      const msg: ChatMessage = store.getOrCreateAssistant();
      store.appendThinkingDelta(msg, chunk);
      store.bumpTailThrottled();
      break;
    }
    case 'tool_use_start': {
      // V1 瞬态：工具不落消息流，只入 liveActivities；getOrCreateAssistant
      // 仍保留——sidecar 可能把 model 盖在首个块事件（可能是工具）上
      const msg: ChatMessage = store.getOrCreateAssistant();
      store.stampModel(msg, payload);
      // 工具插在两段思考之间：给上一张思考卡留段落断口，续写不顶行
      const last: ContentBlock | undefined = msg.blocks[msg.blocks.length - 1];
      if (last instanceof ThinkingBlock && !last.text.endsWith('\n')) {
        last.text += '\n\n';
      }
      store.sealThinking(msg); // 思考段收尾：工具执行期收起（续写时重新展开）
      const toolId: string = str(payload, 'id');
      if (toolId !== '') {
        store.addLiveActivity(new LiveActivity(toolId, str(payload, 'name'), obj(payload, 'input')));
      }
      break;
    }
    case 'tool_result': {
      store.removeLiveActivity(str(payload, 'id'));
      break;
    }
    case 'bg_task_started': {
      store.upsertBgTask(str(payload, 'id'), str(payload, 'command'), str(payload, 'description'), str(payload, 'toolUseId'));
      break;
    }
    case 'bg_task_output': {
      const bg: BgTask | undefined = store.lookupBgTask(str(payload, 'id'));
      if (bg !== undefined) {
        appendBgOutput(bg, str(payload, 'delta'));
      }
      break;
    }
    case 'bg_task_ended': {
      store.endBgTask(str(payload, 'id'), str(payload, 'status'), str(payload, 'summary'));
      break;
    }
    case 'permission_request': {
      const req: PermissionRequest = new PermissionRequest();
      req.id = str(payload, 'id');
      req.name = str(payload, 'name');
      req.input = obj(payload, 'input');
      // 发起方子代理（嵌套对象 {id, agentName}；缺省 = 主线程请求）
      const fsObj: Object | undefined = payload['fromSubagent'];
      if (fsObj !== undefined && typeof fsObj === 'object') {
        req.fromSubagentName = str(fsObj as Record<string, Object>, 'agentName');
      }
      store.pendingPermissions = store.pendingPermissions.concat([req]);
      break;
    }
    case 'permission_cancelled': {
      const id: string = str(payload, 'id');
      store.pendingPermissions = store.pendingPermissions.filter((p: PermissionRequest) => p.id !== id);
      break;
    }
    case 'subagent_start': {
      const msg: ChatMessage = store.getOrCreateAssistant();
      store.stampModel(msg, payload);
      store.sealThinking(msg); // 思考让位子代理：段收尾自动收起（幂等）
      const saId: string = str(payload, 'id');
      const block: SubagentBlock = new SubagentBlock(
        saId, str(payload, 'agentName'), str(payload, 'description'), str(payload, 'prompt'));
      msg.blocks.push(block);
      store.registerSubagent(saId, block);
      break;
    }
    case 'subagent_text_delta':
    case 'subagent_thinking_delta': {
      const block: SubagentBlock | undefined = store.lookupSubagent(str(payload, 'id'));
      if (block !== undefined) {
        appendSubagentTextEntry(
          block, type === 'subagent_text_delta' ? 'text' : 'thinking', str(payload, 'delta'));
      }
      break;
    }
    case 'subagent_progress': {
      const block: SubagentBlock | undefined = store.lookupSubagent(str(payload, 'id'));
      if (block !== undefined) {
        const entry: SubagentEntry = new SubagentEntry(uuid(), 'tool');
        entry.toolUseId = str(payload, 'toolUseId');
        entry.toolName = str(payload, 'toolName');
        entry.input = obj(payload, 'input');
        block.entries.push(entry);
        const model: string = str(payload, 'model');
        if (model !== '') {
          block.model = model;
        }
      }
      break;
    }
    case 'subagent_tool_result': {
      // 子代理内部工具产出按 toolUseId 回填；找不到对应步骤（乱序）静默丢弃
      const block: SubagentBlock | undefined = store.lookupSubagent(str(payload, 'id'));
      if (block === undefined) {
        break;
      }
      const toolUseId: string = str(payload, 'toolUseId');
      for (let i = block.entries.length - 1; i >= 0; i--) {
        const en: SubagentEntry = block.entries[i];
        if (en.type === 'tool' && en.toolUseId === toolUseId) {
          const content: string = str(payload, 'content');
          if (content.length > SUBAGENT_ENTRY_CAP) {
            en.truncatedBytes = (content.length - SUBAGENT_ENTRY_CAP) * 2;
            en.result = content.substring(content.length - SUBAGENT_ENTRY_CAP);
          } else {
            en.result = content;
          }
          en.isError = bool(payload, 'is_error');
          break;
        }
      }
      break;
    }
    case 'subagent_end': {
      const saId: string = str(payload, 'id');
      const block: SubagentBlock | undefined = store.lookupSubagent(saId);
      if (block !== undefined) {
        const result: string = str(payload, 'result');
        if (result.length > SUBAGENT_ENTRY_CAP) {
          block.resultTruncatedBytes = (result.length - SUBAGENT_ENTRY_CAP) * 2;
          block.result = result.substring(result.length - SUBAGENT_ENTRY_CAP);
        } else {
          block.result = result;
        }
        block.isError = bool(payload, 'is_error');
        block.isPending = false;
        store.unregisterSubagent(saId);
      }
      break;
    }
    case 'message_stop': {
      store.finishStreaming(); // 内含末位思考卡收尾收起
      store.isBusy = false;
      store.liveActivities = [];
      store.bumpTail(); // 收尾终贴：补回跟尾节流窗里丢掉的最后一截
      break;
    }
    case 'jump_queued':
      // 忙碌排队时已暂存 pendingJumps；sidecar 此处回传仅作确认，不重复入队
      break;
    case 'jump_promoted': {
      // 安全边界到达：暂存消息 flush 成用户气泡（追加在当前 assistant 之后）。
      // 新轮次由 sidecar 直接发起，不经过发送链路，这里把忙碌态补回来
      store.finishStreaming();
      for (let i = 0; i < store.pendingJumps.length; i++) {
        store.appendMessage(ChatMessage.userText(uuid(), store.pendingJumps[i].text));
      }
      store.pendingJumps = [];
      store.isBusy = true;
      store.bumpTail();
      break;
    }
    case 'notification': {
      pushAssistantNotice(store, str(payload, 'message'));
      break;
    }
    case 'error': {
      // fatal:false = 可恢复（进程仍存活）；缺省/true 按致命处理。同为复位 + 提示
      store.resetRuntimeState();
      store.bgTasks = [];
      pushAssistantNotice(store, `Error: ${str(payload, 'message')}`);
      break;
    }
    case 'session_dead': {
      // 进程真的没了（reader EOF / 心跳看门狗超时合成）：后台任务随之覆灭
      store.resetRuntimeState();
      store.bgTasks = [];
      const reason: string = str(payload, 'reason');
      const detail: string = str(payload, 'detail');
      const label: string = reason === 'heartbeat_timeout' ? '会话无响应，已终止进程' : '会话进程已退出';
      pushAssistantNotice(store, detail !== '' ? `${label}\n${detail}` : label);
      break;
    }
    case 'session_title': {
      const title: string = str(payload, 'title');
      if (title !== '') {
        adoptSessionTitle(store, title);
      }
      break;
    }
    default:
      // 未收录事件显式忽略（清单见文件头）
      break;
  }
}

// ── 内部 ──

/** 落一条纯文本 assistant 提示（notification / error / session_dead 共用形状）。 */
function pushAssistantNotice(store: ChatStore, text: string): void {
  const msg: ChatMessage = new ChatMessage();
  msg.id = uuid();
  msg.role = 'assistant';
  msg.timestamp = Date.now();
  msg.blocks = [new TextBlock(uuid(), text)];
  store.appendMessage(msg);
  store.bumpTail();
}

/**
 * 会话自动命名（对照 events.ts session_title 分支）：Rust 原子判定
 * （nameSource==manual 拒写）返回 true 才更新——页标题 + 列表注册表，
 * 一处更新全局生效。失败静默——保留默认名。
 */
async function adoptSessionTitle(store: ChatStore, title: string): Promise<void> {
  const sid: string = store.sid;
  try {
    const adopted: boolean = await api.autoRenameSession(sid, title);
    if (adopted && store.sid === sid) {
      store.sessionName = title;
      sessionsModel.adoptName(sid, title);
    }
  } catch (e) {
    // 自动命名失败静默——保留默认名
  }
}
