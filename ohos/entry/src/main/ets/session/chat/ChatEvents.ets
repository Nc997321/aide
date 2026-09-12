/**
 * 流式事件总路由：chat-event 载荷按 type 分发到单会话 store。
 *
 * 过筛自 packages/aide-sdk/src/composables/useChatSession/events.ts
 * （handleChatEvent），按 ohos 端消费面裁剪：
 *  - 收录：文本/思考增量（思考经 store.appendThinkingDelta/sealThinking 走
 *    「默认收起 → 点击展开 → 段收尾自动收起 → 跨工具合并续写」生命周期，见 ThinkingCard）、
 *    工具调用生命周期（Edit/Write 落消息 blocks 常驻折叠行，tool_result
 *    按 id 回填定稿；其余工具瞬态行 liveActivities，不入消息 blocks——
 *    运行期可见、结束即焚）、后台 shell 任务（bg_task_*，
 *    跨轮次存活，停靠区展示）、子代理时间线、权限请求队列（AskUserQuestion
 *    的问题清单随请求解析成草稿）、跳队
 *    （jump_queued/promoted）、轮次收尾（message_stop）、模型切换回执
 *    （model_switch_result）、notification、error、session_dead、
 *    session_title
 *  - 显式忽略（随对应 UI 扩容接入）：models_available / model_switch_confirm
 *    （decision RPC 不在远程白名单，成本确认远程不可用） / effort_changed /
 *    context_usage / context_compaction / tasks_update /
 *    rate_limit / health / permission_modes_available /
 *    slash_commands_available / image_input_*
 *  - 不收录（上游有、ohos 端无对应通路）：非交互别名链（自动化 run_xxx
 *    路由键，ohos 不消费自动化事件）、诊断仪表盘（stalled 软超时）；
 *    tempId 过户已随新会话 spawn 收录（见 finalizeSpawn）
 * 上游路由前有 disposedSids 拦截；ohos 等价物 = session_id 不等于当前
 * store.sid 即丢弃（btw 支线/其他会话/迟到事件不进本 store）。
 */
import { api } from '../../sdk/api';
import { sessionsModel } from '../SessionsModel';
import { Session } from '../../sdk/types';
import { ChatStore } from './ChatStore';
import {
  ContentBlock, TextBlock, ThinkingBlock, SubagentEntry, SubagentBlock,
  ChatMessage, PermissionRequest, LiveActivity, BgTask, SUBAGENT_ENTRY_CAP,
  appendSubagentTextEntry, appendBgOutput, ToolCallBlock, ImageBlock, VideoBlock
} from './ChatBlocks';
import { parseQuestions } from './PermissionShape';
import { uuid, str, bool, obj, num, emptyRecord, isEditTool } from './ChatWire';
import { ttsModel } from './TtsModel';
import { readerModel } from './ReaderModel';

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
    case 'session_init': {
      if (store.pendingSpawn) {
        // spawn 定名：sidecar 已把路由键 re-key 成 SDK 真实 id（此后事件全带
        // 真实 id，原子切换无别名混流窗口），store 原地过户 + 落元数据
        const realId: string = str(payload, 'sdk_session_id');
        if (realId !== '' && realId !== store.sid) {
          void finalizeSpawn(store, realId);
          break;
        }
      }
      // 既有会话续聊：aide id 即 sdk id，无需过户/别名链；
      // running 标记由发送侧的 isBusy 承担
      break;
    }
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
      // Edit/Write 落消息 blocks 常驻折叠行；其余工具瞬态（不落消息流，只入
      // liveActivities）。getOrCreateAssistant 两路都保留——sidecar 可能把
      // model 盖在首个块事件（可能是工具）上
      const msg: ChatMessage = store.getOrCreateAssistant();
      store.stampModel(msg, payload);
      // 工具插在两段思考之间：给上一张思考卡留段落断口，续写不顶行
      const last: ContentBlock | undefined = msg.blocks[msg.blocks.length - 1];
      if (last instanceof ThinkingBlock && !last.text.endsWith('\n')) {
        last.text += '\n\n';
      }
      store.sealThinking(msg); // 思考段收尾：工具执行期收起（续写仅重挂 active，不重新展开）
      const toolId: string = str(payload, 'id');
      if (toolId !== '') {
        const toolName: string = str(payload, 'name');
        if (isEditTool(toolName)) {
          // 常驻折叠行 spinner 态入列；tool_result 按 id 回填定稿（不走
          // liveActivities，避免同屏双行）
          msg.blocks.push(new ToolCallBlock(toolId, toolName, obj(payload, 'input'), '', false, true));
          store.bumpTail();
        } else {
          store.addLiveActivity(new LiveActivity(toolId, toolName, obj(payload, 'input')));
        }
      }
      break;
    }
    case 'tool_result': {
      // Edit/Write 折叠行按 id 回填定稿（找不到静默丢弃）；其余工具只撤瞬态行
      store.backfillToolResult(str(payload, 'id'), str(payload, 'content'), bool(payload, 'is_error'));
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
      // AskUserQuestion 的问题清单随请求落草稿（形状不对 → 空，弹窗退空态）
      req.initQuestions(parseQuestions(req.input));
      store.pendingPermissions = store.pendingPermissions.concat([req]);
      // 语音播报：只在请求落到队头时播固定模板（排队中的后续请求等应答后由
      // 弹窗接管，不叠播）；开关关/引擎缺在 TtsModel 内静默
      if (store.pendingPermissions.length === 1) {
        readerModel.stop(); // 权限播报顶掉听书（互斥：两引擎通道不同会叠音）
        ttsModel.speakPermission(req);
      }
      break;
    }
    case 'permission_cancelled': {
      const id: string = str(payload, 'id');
      store.pendingPermissions = store.pendingPermissions.filter((p: PermissionRequest) => p.id !== id);
      ttsModel.stopPermission(id); // 桌面侧已取消：正在播的对应播报停
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
      // 语音播报：回复完成自动播末位 assistant 正文（开关关/引擎缺静默；
      // 新播报打断旧播报在 TtsModel.start 内）
      const done: ChatMessage | undefined = store.messages[store.messages.length - 1];
      if (done !== undefined && done.role === 'assistant') {
        readerModel.stop(); // 自动播报顶掉听书（互斥：新声音优先，同 TTS 抢占规则）
        ttsModel.speakReply(done);
      }
      break;
    }
    case 'jump_queued':
      // 忙碌排队时已暂存 pendingJumps；sidecar 此处回传仅作确认，不重复入队
      break;
    case 'user_message': {
      // 用户气泡的**唯一渲染点**（与桌面端同源）：本地、桌面端、PWA 发的消息
      // 全部落到这里。发送方不再本地乐观渲染，所以不会重复、不需要 id 去重；
      // 代价是本地发送也多一个 RTT 才出气泡（手机经 relay 约 100ms）。
      // finishStreaming 收尾上一条 assistant：气泡必须插在它之后，否则流式续写
      // 会误把新回合内容接进上一条消息。
      // display 回灌：手机/PWA 带附件的消息随事件回传块数组，据此渲染图片/
      // 视频/文件引用富气泡（对照桌面 blocksFromDisplay）；无 display 的纯文本
      // 消息退 userText 单文本块。
      ttsModel.stop(); // 用户发新消息（本机/桌面/PWA 同源）= 不再念旧回复
      store.finishStreaming();
      store.appendMessage(parseUserDisplay(payload['display'], str(payload, 'text')));
      store.isBusy = true;
      store.bumpTail();
      break;
    }
    case 'jump_promoted': {
      // 安全边界到达：排队的消息已被 sidecar 接入模型，气泡由紧邻其前的
      // user_message 事件渲染（sidecar 逐条入队、逐条广播）。这里只清提示条 +
      // 补忙碌态——新轮次由 sidecar 直接发起，不经过发送链路。
      store.pendingJumps = [];
      store.isBusy = true;
      store.bumpTail();
      break;
    }
    case 'model_switch_result': {
      // 模型切换终态回执（对照 ModelSwitchResult 事件）：成功坐实 store.model；
      // 失败落提示不回滚——记忆元数据已随 pickModel 写入，选择仍随下一条消息
      // 生效（远程无 decision RPC，桌面侧成本确认超时自动 deny 也走这里）。
      if (bool(payload, 'ok')) {
        store.model = str(payload, 'model');
      } else {
        store.finishStreaming(); // 落提示前收尾在途流式（同 notification 分支）
        pushAssistantNotice(store, `模型切换未生效：${str(payload, 'error')}`);
      }
      break;
    }
    case 'notification': {
      // 通知可能与流式回合交错：先收尾在途消息再落提示——否则它让出末位后
      // streaming 仍挂真（末块光标/active 思考卡冻结在旧消息里）；续写由
      // getOrCreateAssistant 新起一条（带光标），通知气泡也不与正文混排
      store.finishStreaming();
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
      if (title === '') {
        break;
      }
      if (store.pendingSpawn) {
        // init 前到达（tempId 尚无元数据，此刻 auto_rename 会写孤儿标题）：
        // 暂存到 finalize 一次落盘，顶栏名先行点亮——对照 PWA 暂存标题
        store.pendingSpawnTitle = title;
        store.sessionName = title;
        break;
      }
      adoptSessionTitle(store, title);
      break;
    }
    default:
      // 未收录事件显式忽略（清单见文件头）
      break;
  }
}

// ── 内部 ──

/**
 * user_message.display → 用户富气泡（对照桌面 blocksFromDisplay + PWA
 * buildUserDisplay 的镜像解析）：text → TextBlock、image → ImageBlock、
 * mention → Read 工具卡（与历史重载的 transcript 拆分形态一致，桌面/手机
 * 同卡）、video → ohos 专有 VideoBlock（桌面不识别，安全跳过）。未知类型
 * 跳过不破坏解析；无 display / 全空回退纯文本单块（text 可为空——
 * 附件-only 消息在 text 位渲染空文本气泡）。
 */
function parseUserDisplay(d: Object | undefined, text: string): ChatMessage {
  const blocks: ContentBlock[] = [];
  if (d !== undefined && d instanceof Array) {
    const arr: Object[] = d as Object[];
    for (let i = 0; i < arr.length; i++) {
      const item: Object | undefined = arr[i];
      if (item === undefined || typeof item !== 'object') {
        continue;
      }
      const rec: Record<string, Object> = item as Record<string, Object>;
      const kind: string = str(rec, 'type');
      if (kind === 'text') {
        const t: string = str(rec, 'text');
        if (t !== '') {
          blocks.push(new TextBlock(uuid(), t));
        }
      } else if (kind === 'image') {
        const data: string = str(rec, 'data');
        if (data !== '') {
          const mt: string = str(rec, 'mediaType');
          blocks.push(new ImageBlock(uuid(), `data:${mt !== '' ? mt : 'image/jpeg'};base64,${data}`));
        }
      } else if (kind === 'mention') {
        const input: Record<string, Object> = emptyRecord();
        input['file_path'] = str(rec, 'path');
        blocks.push(new ToolCallBlock(uuid(), 'Read', input, str(rec, 'content'), false, false));
      } else if (kind === 'video') {
        const poster: string = str(rec, 'poster');
        if (poster !== '') {
          blocks.push(new VideoBlock(uuid(), `data:image/jpeg;base64,${poster}`,
            num(rec, 'durationMs'), str(rec, 'name')));
        }
      }
    }
  }
  if (blocks.length === 0) {
    return ChatMessage.userText(uuid(), text);
  }
  return ChatMessage.userBlocks(uuid(), blocks);
}

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

/**
 * spawn 定名收尾（PWA finalizeSession + App.vue onSessionCreated 的手机侧等价
 * 物）：store 原地过户到真实 id（sidecar 已 re-key，无混流窗口）；名字优先级 =
 * 暂存标题（可能早于 init 到达）> 真实 id 前 8 位；create_session 落元数据 +
 * 列表头插一次完成。桌面侧把远程 spawn 的 session_init 视作非交互来源不登记，
 * 元数据必须由发起端落（否则会话名退 id）。落盘失败静默——会话仍在跑，
 * 列表重拉时 jsonl 扫描兜底。
 */
async function finalizeSpawn(store: ChatStore, realId: string): Promise<void> {
  const title: string = store.pendingSpawnTitle;
  const wsKey: string = store.spawnWsKey;
  store.sid = realId;
  store.pendingSpawn = false;
  store.pendingSpawnTitle = '';
  const name: string = title !== '' ? title : realId.substring(0, 8);
  store.sessionName = name;
  try {
    const created: Session = await api.createSession(realId, name);
    sessionsModel.adoptNewSession(created, wsKey);
  } catch (e) {
    // 元数据落盘失败静默——jsonl 扫描兜底（名字退 id）
  }
}
