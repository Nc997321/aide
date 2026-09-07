/**
 * 工作区模型：抽屉工作区卡 + 切换弹层的全局可观察状态。
 *
 * 手机侧「切换」仅改两件事：浏览范围（list_sessions_for_workspace）与新会话
 * spawn 的 workspaceRoot——桌面活动工作区不受影响（协议无写 RPC；原型弹层
 * 脚注同语义：工作区由桌面 aide 管理）。selectedKey = '' 跟随桌面当前活动
 * 工作区（list_sessions）；活动工作区经 get_active_workspace 只读解析
 * （activeKey/activePath），跟随槽位展示真名；旧桌面无此 RPC、拉取失败或
 * 未设置时退占位「当前工作区」。
 * 弹层元信息：每次打开并行拉取各工作区会话列表，三态计数 = 全局事件推导的
 * id 集合（SessionsModel）∩ 该工作区会话列表——计数是快照，整体替换驱动 @Trace。
 */
import { ConnModel, connModel } from '../conn/ConnModel';
import { api } from '../sdk/api';
import { Session, WorkspaceInfo, ActiveWorkspace } from '../sdk/types';
import { sessionsModel } from './SessionsModel';

/** 弹层/工作区卡的单工作区计数快照（key = wsKey；'' = 跟随桌面槽位）。 */
export class WsMeta {
  readonly key: string;
  total: number = 0;
  started: number = 0;
  live: number = 0;
  wait: number = 0;

  constructor(key: string) {
    this.key = key;
  }
}

/** 路径 → 末段短名（工作区展示名；对照原型 ws-card 的 name/path 分离）。 */
export function baseName(path: string): string {
  const parts: string[] = path.split(/[\\\/]/).filter((s: string) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

@ObservedV2
export class WorkspaceModel {
  @Trace workspaces: WorkspaceInfo[] = [];
  /** 手机侧选中 key；'' = 桌面当前活动工作区。 */
  @Trace selectedKey: string = '';
  /** 桌面活动工作区编码键（get_active_workspace；'' = 未设置/拉取失败/旧桌面无此 RPC）。 */
  @Trace activeKey: string = '';
  /** 桌面活动工作区解码路径（空串语义同上，UI 隐藏路径行）。 */
  @Trace activePath: string = '';
  @Trace loaded: boolean = false;
  @Trace refreshing: boolean = false;
  /** 弹层计数快照（打开弹层时拉取；整体替换驱动 @Trace）。 */
  @Trace metas: WsMeta[] = [];
  @Trace loadingMetas: boolean = false;

  /** 拉取工作区列表 + 活动工作区（authed 前置；防重入；两路并行互不牵连）。 */
  async refresh(): Promise<void> {
    if (this.refreshing || connModel.state !== 'authed') {
      return;
    }
    this.refreshing = true;
    const activeJob: Promise<void> = this.fetchActive();
    try {
      this.workspaces = await api.listWorkspaces();
      this.loaded = true;
    } catch (e) {
      // 拉取失败静默：工作区卡退占位；弹层按 loaded 呈现空态，重开即重试
    } finally {
      await activeJob;
      this.refreshing = false;
    }
  }

  /** 只读解析桌面活动工作区；旧桌面版本无此 RPC（中继拒绝）或未设置 → 空串占位。 */
  private async fetchActive(): Promise<void> {
    try {
      const aw: ActiveWorkspace | null = await api.getActiveWorkspace();
      this.activeKey = aw !== null ? aw.key : '';
      this.activePath = aw !== null ? aw.path : '';
    } catch (e) {
      this.activeKey = '';
      this.activePath = '';
    }
  }

  /** 选中工作区并联动会话列表重拉（同 key 幂等）。 */
  select(key: string): void {
    if (key === this.selectedKey) {
      return;
    }
    this.selectedKey = key;
    sessionsModel.selectWorkspace(key);
  }

  /** 当前选中工作区展示名：跟随槽位解析活动工作区真名（未解析退占位
   *  「当前工作区」）；其余 → 路径末段。 */
  selectedDisplayName(): string {
    if (this.selectedKey === '') {
      const resolved: string = this.activeDisplayName();
      return resolved !== '' ? resolved : '当前工作区';
    }
    const ws: WorkspaceInfo | null = this.lookup(this.selectedKey);
    return ws !== null ? baseName(ws.name) : this.selectedKey;
  }

  /** 活动工作区真名（列表键匹配 → 路径末段；未解析出 → 空串）。 */
  activeDisplayName(): string {
    if (this.activeKey !== '') {
      const ws: WorkspaceInfo | null = this.lookup(this.activeKey);
      if (ws !== null) {
        return baseName(ws.name);
      }
    }
    return this.activePath !== '' ? baseName(this.activePath) : '';
  }

  /** 展示用 key（头像/色点取色）：选中键优先，跟随槽位退活动工作区键。 */
  displayKey(): string {
    return this.selectedKey !== '' ? this.selectedKey : this.activeKey;
  }

  /** 当前选中工作区完整路径（跟随槽位 → 活动工作区路径；空串 UI 隐藏路径行）。 */
  selectedPath(): string {
    if (this.selectedKey === '') {
      return this.activePath;
    }
    const ws: WorkspaceInfo | null = this.lookup(this.selectedKey);
    return ws !== null ? ws.name : '';
  }

  /** spawn 的 workspaceRoot：'' → null（桌面回落活动工作区）；选中项缺失兜底 null。 */
  selectedRoot(): string | null {
    if (this.selectedKey === '') {
      return null;
    }
    const ws: WorkspaceInfo | null = this.lookup(this.selectedKey);
    return ws !== null ? ws.name : null;
  }

  /** 弹层打开时拉取全部工作区计数（含 '' 跟随桌面槽位——独立走 list_sessions，
   *  不复用 sessionsModel 现势：手机侧可能已把列表切到别的工作区）。 */
  async loadMetas(): Promise<void> {
    if (this.loadingMetas || connModel.state !== 'authed') {
      return;
    }
    this.loadingMetas = true;
    try {
      // 并行拉取：'' 槽位 + 各工作区各一次 invoke（经中继各约一个 RTT），
      // 单条目失败静默为零值占位，其余照常展示
      const jobs: Array<Promise<WsMeta>> = [this.metaOf('')];
      for (let i = 0; i < this.workspaces.length; i++) {
        jobs.push(this.metaOf(this.workspaces[i].key));
      }
      this.metas = await Promise.all(jobs);
    } catch (e) {
      // 计数拉取失败静默——弹层退无计数展示
    } finally {
      this.loadingMetas = false;
    }
  }

  /** 计数快照查询（弹层行/工作区卡；null = 未拉取，UI 退隐藏计数）。 */
  metaOfKey(key: string): WsMeta | null {
    for (let i = 0; i < this.metas.length; i++) {
      if (this.metas[i].key === key) {
        return this.metas[i];
      }
    }
    return null;
  }

  // ── 内部 ──

  private lookup(key: string): WorkspaceInfo | null {
    for (let i = 0; i < this.workspaces.length; i++) {
      if (this.workspaces[i].key === key) {
        return this.workspaces[i];
      }
    }
    return null;
  }

  /** 单槽位计数（'' = 桌面活动工作区走 list_sessions）：会话列表 ∩ 全局
   *  三态 id 集合（拉取失败 → 零值条目占位，其余条目照常展示）。 */
  private async metaOf(key: string): Promise<WsMeta> {
    const m: WsMeta = new WsMeta(key);
    try {
      const sessions: Session[] = key === ''
        ? await api.listSessions()
        : await api.listSessionsForWorkspace(key);
      m.total = sessions.length;
      for (let i = 0; i < sessions.length; i++) {
        const sid: string = sessions[i].id;
        if (sessionsModel.startedIds.indexOf(sid) >= 0) {
          m.started++;
        }
        if (sessionsModel.liveIds.indexOf(sid) >= 0) {
          m.live++;
        }
        if (sessionsModel.waitConfirmIds.indexOf(sid) >= 0) {
          m.wait++;
        }
      }
    } catch (e) {
      // 单条目拉取失败静默
    }
    return m;
  }
}

/** 全局单例：抽屉工作区卡与切换弹层共用。 */
export const workspaceModel: WorkspaceModel = new WorkspaceModel();
