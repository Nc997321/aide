/**
 * api 门面子集：从 packages/aide-sdk/src/api.ts 按需过筛。
 *
 * 上游是 `export const api = { ... }` 对象字面量门面；ArkTS 化为 class + 单例
 * （方法体与命令名/参数形状零偏差）。仅收录远程白名单（src-tauri/src/remote/rpc.rs
 * REGISTRY）内且当前页面域实际消费的命令；新页面需要时对照上游同步补入。
 * 本文件已收录：list_sessions / list_sessions_for_workspace / list_workspaces
 * / load_messages / send_message / interrupt_session / permission_response
 * / auto_rename_session / stop_bg_task / list_bg_tasks（后两者为远程对账
 * 配套：终止走 stop_bg_task，快照回填走 list_bg_tasks）。
 * 参数序列化差异：上游 TS 的 undefined 字段经 JSON.stringify 自动丢弃；ArkTS
 * Record 值域不含 null，故 None 参数以「缺键」表达（Rust 侧 Option 字段缺键即
 * None，serde 语义等价）。
 */
import { getTransport } from './transport';
import { Session, WorkspaceInfo, LoadMessagesResult, BgTaskInfo, PermissionRuleDraft } from './types';

/** send_message 的完整负载（镜像前端 SendMessageParams；可空项 null = Rust None）。 */
export interface SendMessageParams {
  sessionId: string;
  prompt: string;
  /** 会话归属工作区根路径；null = Rust 回落当前活动工作区。 */
  workspaceRoot: string | null;
  /** 图片附件；ohos 端暂无图片发送通路，恒 null（占位保持 DTO 形状完整）。 */
  images: null;
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
  /** 拒绝理由（UI 的 reason → 协议的 message，sidecar 透传给 SDK 的 deny message）；null = 无。 */
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
}

/** 全局门面单例（与上游 `api` 导出同名同用法）。 */
export const api: AideApi = new AideApi();
