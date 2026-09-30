/**
 * api 门面子集：从 packages/aide-sdk/src/api.ts 按需过筛。
 *
 * 上游是 `export const api = { ... }` 对象字面量门面；ArkTS 化为 class + 单例
 * （方法体与命令名/参数形状零偏差）。仅收录远程白名单（src-tauri/src/remote/rpc.rs
 * REGISTRY）内且当前页面域实际消费的命令；新页面需要时对照上游同步补入。
 * 本文件已收录：list_sessions / list_sessions_for_workspace / list_workspaces
 * / get_active_workspace（工作区域配套：跟随槽位解析活动工作区真名）
 * / daily_workspace（日常默认工作区身份：key 配会话列表、path 配 spawn 落点；
 * 手机默认范围即日常，旧桌面无此 RPC 由调用方静默降级）
 * / load_messages / send_message / interrupt_session / permission_response
 * / auto_rename_session / create_session / stop_bg_task / list_bg_tasks
 * （后两者为远程对账配套：终止走 stop_bg_task，快照回填走 list_bg_tasks；
 * create_session 为手机端 spawn 定名登记）；
 * get_providers / get_active_provider_id / set_active_provider_id
 * （抽屉供应商域：列表 + 当前激活 + 切换）；
 * get_default_models / set_model / set_session_meta / session_model
 * / set_effort / session_effort / session_provider / session_alive
 * / session_identity_drift
 * （输入区模型/思考程度 chip 域：系统默认选项集 + 存活会话运行时切换 +
 * 会话记忆读写；记忆写入统一走 set_session_meta 三态 patch；会话供应商/
 * 存活判定决定模型下拉口径，见 docs/session-identity-alignment.md；
 * session_identity_drift 为发送前身份漂移判定，规则下沉 Rust 两端共用）；
 * 自动化任务域 11 命令（list_automations / get_automation / create_automation
 * / update_automation / delete_automation / set_automation_enabled
 * / list_automation_runs / automation_run_stats / run_automation_now
 * / get_automation_playbook / redistill_automation）——
 * ⚠️ 此域命令【未进远程 REGISTRY】（rpc.rs 0 收录）：桌面开口子前所有
 * invoke 必败，调用方按「错误态一等公民」处理（lastError / toast，不崩不白屏）。
 * 参数序列化差异：上游 TS 的 undefined 字段经 JSON.stringify 自动丢弃；ArkTS
 * Record 值域不含 null，故 None 参数以「缺键」表达（Rust 侧 Option 字段缺键即
 * None，serde 语义等价）。
 */
import { getTransport } from './transport';
import {
  Session, WorkspaceInfo, ActiveWorkspace, DailyWorkspace, LoadMessagesResult, BgTaskInfo, PermissionRuleDraft,
  ProviderConfigView, ModelOption, IdentityDrift, SendImage, SendDisplayBlock,
  Schedule, AutomationTask, AutomationTaskInput, RunRecord, RunStats
} from './types';

/**
 * 会话元数据字段的三态写入语义（镜像 Rust `MetaField`，serde tag = `op`）。
 *
 * 取代「空串 = 删字段」的魔法值约定：那种写法把**操作类型编码进值域**，读代码的
 * 人必须先知道约定才能读懂，且无法表达「本次不动这个字段」——合并写入时只能靠
 * 传空串绕过，正是多字段并发写互相覆盖（lost update）的温床。
 */
export class MetaField {
  op: string;
  value: string;

  constructor(op: string, value: string) {
    this.op = op;
    this.value = value;
  }

  /** 本次不动这个字段。 */
  static keep(): MetaField {
    return new MetaField('keep', '');
  }

  /** 删掉这个字段，回到「没记过」。 */
  static clear(): MetaField {
    return new MetaField('clear', '');
  }

  /** 写入该值。 */
  static set(value: string): MetaField {
    return new MetaField('set', value);
  }
}

/** 一次会话元数据写入的 patch；省略的字段 = keep（不动盘上值）。 */
export interface SessionMetaPatch {
  provider?: MetaField;
  model?: MetaField;
  effort?: MetaField;
}

/** send_message 的完整负载（镜像前端 SendMessageParams；可空项 null = Rust None）。 */
export interface SendMessageParams {
  sessionId: string;
  prompt: string;
  /** 会话归属工作区根路径；null = Rust 回落当前活动工作区。 */
  workspaceRoot: string | null;
  /** 图片附件（拍照/相册/视频首帧海报；Rust Option<Vec<ImageAttachment>>）；null = 无图。 */
  images: SendImage[] | null;
  /** 用户气泡 display 回灌块（富形态，桌面/PWA 据此渲染；Rust Option<Value> 透传）；null = 纯文本气泡。 */
  display: SendDisplayBlock[] | null;
  /** 会话身份层解析出的 provider 绑定；null = 会话元数据 → 全局 active 兜底。 */
  provider: string | null;
  resumeId: string | null;
  /** 仅 spawn 分支生效（首条消息）；存活会话切模型走 set_model。 */
  initialModel: string | null;
  /** 与 initialModel 同一条 env 通道（CLAUDE_CODE_EFFORT_LEVEL）。 */
  initialEffort: string | null;
  /** 每条消息透传当前权限模式；null = 远程网关回落桌面「远程控制」设置。 */
  permissionMode: string | null;
  /** 排队发送标记：sidecar 在安全边界自行 interrupt 后再发。 */
  jumpQueue: boolean;
}

/** permission_response 的完整负载（镜像上游 PermissionResponseParams；可空项 null = Rust None）。 */
export interface PermissionResponseParams {
  sessionId: string;
  id: string;
  approved: boolean;
  /** AskUserQuestion 类工具的作答（问题文本 → 答案）；null = 非提问场景。 */
  answers: Record<string, string> | null;
  /** 「允许并切换模式」的目标模式（manual/auto 等）；null = 不切。 */
  nextMode: string | null;
  /** 拒绝理由（UI 的 reason → 协议的 message，sidecar 交给 CLI 当 user feedback，
   *  由官方模板包装后反馈给模型）；null = 无。 */
  message: string | null;
  /** 「允许并记住」的会话级规则草稿；ohos 端不推导（同 PWA），恒 null 占位保持 DTO 形状完整。 */
  sessionRules: PermissionRuleDraft[] | null;
}

export class AideApi {
  /** 桌面当前活动工作区的会话（后端按 timestamp 降序返回；工作区未设置时为空）。 */
  listSessions(): Promise<Session[]> {
    return getTransport().invoke<Session[]>('list_sessions');
  }

  listSessionsForWorkspace(wsKey: string): Promise<Session[]> {
    return getTransport().invoke<Session[]>('list_sessions_for_workspace', { 'wsKey': wsKey });
  }

  listWorkspaces(): Promise<WorkspaceInfo[]> {
    return getTransport().invoke<WorkspaceInfo[]>('list_workspaces');
  }

  /** 桌面当前活动工作区（key 与 list_workspaces 同源；path = 解码路径）；null = 未设置。 */
  getActiveWorkspace(): Promise<ActiveWorkspace | null> {
    return getTransport().invoke<ActiveWorkspace | null>('get_active_workspace');
  }

  /**
   * 日常默认工作区身份（<配置目录>/workspace 的注册键 + 路径；纯计算无 IO、
   * 无参数、无副作用，不改变桌面活动工作区）。key → list_sessions_for_
   * workspace；path → spawn 的 workspaceRoot。旧桌面无此 RPC：调用方
   * 失败按「无日常」静默降级（每运行至多探测一次），行为与升级前一致。
   */
  dailyWorkspace(): Promise<DailyWorkspace> {
    return getTransport().invoke<DailyWorkspace>('daily_workspace');
  }

  /** 历史分页读取：offsetBytes null = 从尾部取；limit = 页字节预算。 */
  loadMessages(sessionId: string, offsetBytes: number | null, limit: number | null): Promise<LoadMessagesResult> {
    const params: Record<string, Object> = { 'sessionId': sessionId };
    if (offsetBytes !== null) {
      params['offsetBytes'] = offsetBytes;
    }
    if (limit !== null) {
      params['limit'] = limit;
    }
    return getTransport().invoke<LoadMessagesResult>('load_messages', params);
  }

  /**
   * 发送一条用户消息（fire-and-forget 语义由调用方决定：新会话 Rust 现拉起进程
   * 较慢，调用点通常不 await 到底、catch 兜底——对照上游 sendMessage 注释）。
   */
  sendMessage(params: SendMessageParams): Promise<void> {
    const args: Record<string, Object> = {
      'sessionId': params.sessionId,
      'prompt': params.prompt,
      'jumpQueue': params.jumpQueue
    };
    if (params.workspaceRoot !== null) {
      args['workspaceRoot'] = params.workspaceRoot;
    }
    if (params.images !== null) {
      args['images'] = params.images;
    }
    if (params.display !== null) {
      args['display'] = params.display;
    }
    if (params.provider !== null) {
      args['provider'] = params.provider;
    }
    if (params.resumeId !== null) {
      args['resumeId'] = params.resumeId;
    }
    if (params.initialModel !== null) {
      args['initialModel'] = params.initialModel;
    }
    if (params.initialEffort !== null) {
      args['initialEffort'] = params.initialEffort;
    }
    if (params.permissionMode !== null) {
      args['permissionMode'] = params.permissionMode;
    }
    return getTransport().invoke<void>('send_message', args);
  }

  interruptSession(sessionId: string): Promise<void> {
    return getTransport().invoke<void>('interrupt_session', { 'sessionId': sessionId });
  }

  /**
   * 权限弹窗应答（参数形状与上游零偏差）。answers = AskUserQuestion 选项
   * 作答；nextMode = 「允许并切换模式」（编辑工具的 auto / 计划批准
   * 的 auto）；message = 拒绝理由；sessionRules = 规则草稿（ohos 不推导，
   * 恒缺键 = Rust None，与上游空 opts 语义一致）。
   */
  permissionResponse(params: PermissionResponseParams): Promise<void> {
    const args: Record<string, Object> = {
      'sessionId': params.sessionId,
      'id': params.id,
      'approved': params.approved
    };
    if (params.answers !== null) {
      args['answers'] = params.answers;
    }
    if (params.nextMode !== null) {
      args['nextMode'] = params.nextMode;
    }
    if (params.message !== null) {
      args['message'] = params.message;
    }
    if (params.sessionRules !== null) {
      args['sessionRules'] = params.sessionRules;
    }
    return getTransport().invoke<void>('permission_response', args);
  }

  /** 自动命名落盘：返回 true = 采用（未被用户手改覆盖）；调用方据此前置更新列表。 */
  autoRenameSession(id: string, name: string): Promise<boolean> {
    return getTransport().invoke<boolean>('auto_rename_session', { 'id': id, 'name': name });
  }

  /**
   * 落会话元数据：手机端 spawn 定名后自行登记（对照 PWA App.vue 的
   * onSessionCreated → api.createSession）——桌面侧把远程 spawn 的 session_init
   * 视作非交互来源不登记，元数据缺失时会话名将退回 id（jsonl 扫描兜底可见）。
   */
  createSession(id: string, name: string): Promise<Session> {
    return getTransport().invoke<Session>('create_session', { 'id': id, 'name': name });
  }

  /** 终止后台任务；终态经 bg_task_ended(status:"stopped") 回来，无单独回执。 */
  stopBgTask(sessionId: string, taskId: string): Promise<void> {
    return getTransport().invoke<void>('stop_bg_task', { 'sessionId': sessionId, 'taskId': taskId });
  }

  /**
   * 会话后台任务快照：打开会话/重连后对账 bgTasks 用（bg_task_* 事件流
   * 只做实时转发无重放，离线期间错过的任务靠这里回填）。
   */
  listBgTasks(sessionId: string): Promise<BgTaskInfo[]> {
    return getTransport().invoke<BgTaskInfo[]>('list_bg_tasks', { 'sessionId': sessionId });
  }

  // ── 供应商（抽屉徽标 + 切换弹层）──

  /** 供应商列表（桌面脱敏视图：密钥只回配置与否的布尔，明文不落协议）。 */
  getProviders(): Promise<ProviderConfigView[]> {
    return getTransport().invoke<ProviderConfigView[]>('get_providers');
  }

  /** 桌面当前激活供应商 id（设置 activeProvider；空串语义由桌面侧决定）。 */
  getActiveProviderId(): Promise<string> {
    return getTransport().invoke<string>('get_active_provider_id');
  }

  /**
   * 切换激活供应商：写桌面设置 activeProvider（handler 参数键 providerId，
   * camelCase 镜像）。新发起的会话随新供应商解析（resolve_send_provider
   * 的全局 active 兜底）；已在跑的会话不受影响。
   */
  setActiveProviderId(providerId: string): Promise<void> {
    return getTransport().invoke<void>('set_active_provider_id', { 'providerId': providerId });
  }

  // ── 模型 / 思考程度（输入区 chip 域）──

  /**
   * 切换存活会话的模型；返回 false = 无活进程（选择随下一条消息 initialModel
   * 生效，调用方走 deferred 提示路径）。成本确认流程远程不可用：decision RPC
   * 不在白名单，confirm 超时由 sidecar 自动 deny（经 model_switch_result 事件回执）。
   */
  setModel(sessionId: string, model: string): Promise<boolean> {
    return getTransport().invoke<boolean>('set_model', { 'sessionId': sessionId, 'model': model });
  }

  /**
   * 会话元数据的**唯一**写入入口：provider / model / effort 一次写齐（一次读、一次写）。
   *
   * 取代 set_session_model / set_session_effort 两个单字段命令——它们各自对同一个
   * `<id>.json` 做一遍 read-modify-write，并发写两个字段时后写的覆盖先写的。
   * 省略的字段按 keep 处理（不动盘上值）。
   *
   * 注意与运行时命令区分：setModel / setEffort 切的是**当前进程**，本命令写的是
   * **下次进会话恢复什么**。
   */
  setSessionMeta(id: string, patch: SessionMetaPatch): Promise<void> {
    return getTransport().invoke<void>('set_session_meta', {
      'id': id,
      'provider': patch.provider ?? MetaField.keep(),
      'model': patch.model ?? MetaField.keep(),
      'effort': patch.effort ?? MetaField.keep()
    });
  }

  sessionModel(id: string): Promise<string | null> {
    return getTransport().invoke<string | null>('session_model', { 'id': id });
  }

  /**
   * 会话绑定的供应商 id（spawn 改绑经 set_session_meta 写入的元数据）；
   * null = 没记过（含供应商被删的场景，由调用方回退全局激活）。
   */
  sessionProvider(id: string): Promise<string | null> {
    return getTransport().invoke<string | null>('session_provider', { 'id': id });
  }

  /**
   * 切换存活会话的 effort；返回 false = 无活进程（选择随下一条消息 env 通道
   * CLAUDE_CODE_EFFORT_LEVEL 生效，与 initialModel 同一语义）。
   */
  setEffort(sessionId: string, effort: string): Promise<boolean> {
    return getTransport().invoke<boolean>('set_effort', { 'sessionId': sessionId, 'effort': effort });
  }

  sessionEffort(id: string): Promise<string | null> {
    return getTransport().invoke<string | null>('session_effort', { 'id': id });
  }

  /**
   * 会话进程是否存活（Rust 侧唯一权威存活表：session_init 登记 / session_dead
   * 与 stop_chat_session 移除 / runtime_dead 全清）。手机端据它决定模型下拉
   * 口径（docs/session-identity-alignment.md）；桌面不在线时调用失败，按
   * false 处理。
   */
  sessionAlive(id: string): Promise<boolean> {
    return getTransport().invoke<boolean>('session_alive', { 'id': id });
  }

  /**
   * 发送前身份漂移判定：本次将生效的 provider / model 与会话上次坐实的基线逐维
   * 比对，**先供应商、再模型**——两者都相同才判无漂移。
   *
   * 判定规则在 Rust 侧只有一份（桌面端与手机端共用），本接口只透传：弹不弹确认、
   * 文案怎么写归 UI。基线缺失（会话从未发过 / 字段为空）→ 对应维度 false。
   * providerId / model 传空串 = 本次未指定，该维度无从比对，同样 false。
   */
  sessionIdentityDrift(id: string, providerId: string, model: string): Promise<IdentityDrift> {
    return getTransport().invoke<IdentityDrift>('session_identity_drift', {
      'id': id,
      'providerId': providerId,
      'model': model
    });
  }

  /** 系统默认供应商的模型选项（Anthropic 4 个别名，Rust 从 catalog 预设读）。
   *  此前底层读 agent-sidecar/default-models.json 兜底文件——已删，catalog 单一真源。 */
  getDefaultModels(): Promise<ModelOption[]> {
    return getTransport().invoke<ModelOption[]>('get_default_models');
  }

  // ── 自动化任务（⚠️ 未进远程 REGISTRY：桌面开口子前 invoke 必败，见文件头）──

  listAutomations(): Promise<AutomationTask[]> {
    return getTransport().invoke<AutomationTask[]>('list_automations');
  }

  getAutomation(id: string): Promise<AutomationTask> {
    return getTransport().invoke<AutomationTask>('get_automation', { 'id': id });
  }

  createAutomation(input: AutomationTaskInput): Promise<AutomationTask> {
    return getTransport().invoke<AutomationTask>('create_automation', { 'input': input });
  }

  updateAutomation(id: string, input: AutomationTaskInput): Promise<AutomationTask> {
    return getTransport().invoke<AutomationTask>('update_automation', { 'id': id, 'input': input });
  }

  /** 删除任务：运行历史与手册一并删除（服务端语义，UI 确认文案同）。 */
  deleteAutomation(id: string): Promise<void> {
    return getTransport().invoke<void>('delete_automation', { 'id': id });
  }

  /** 启停开关；返回更新后的任务。 */
  setAutomationEnabled(id: string, enabled: boolean): Promise<AutomationTask> {
    return getTransport().invoke<AutomationTask>('set_automation_enabled', { 'id': id, 'enabled': enabled });
  }

  /**
   * 立即运行：不推进调度格点；busy 时 Err 文本 `「{name}」正在运行中`（调用方
   * 直显 toast）。返回本次运行记录（status 起始为 running）。
   */
  runAutomationNow(id: string): Promise<RunRecord> {
    return getTransport().invoke<RunRecord>('run_automation_now', { 'id': id });
  }

  /** 运行记录（新→旧）；limit null = 服务端默认。 */
  listAutomationRuns(id: string, limit: number | null): Promise<RunRecord[]> {
    const params: Record<string, Object> = { 'id': id };
    if (limit !== null) {
      params['limit'] = limit;
    }
    return getTransport().invoke<RunRecord[]>('list_automation_runs', params);
  }

  /** 近 30 天统计（成功率/总成本/平均耗时/缓存命中）。 */
  automationRunStats(id: string): Promise<RunStats> {
    return getTransport().invoke<RunStats>('automation_run_stats', { 'id': id });
  }

  /** 执行手册内容；null = 尚未生成（playbookState none / 蒸馏未跑成）。 */
  getAutomationPlaybook(id: string): Promise<string | null> {
    return getTransport().invoke<string | null>('get_automation_playbook', { 'id': id });
  }

  /** 重新提炼手册：playbookState → stale（下次运行重走 explore + 蒸馏）。 */
  redistillAutomation(id: string): Promise<AutomationTask> {
    return getTransport().invoke<AutomationTask>('redistill_automation', { 'id': id });
  }
}

/** 全局门面单例（与上游 `api` 导出同名同用法）。 */
export const api: AideApi = new AideApi();
