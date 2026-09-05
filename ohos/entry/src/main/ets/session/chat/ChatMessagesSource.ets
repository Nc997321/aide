/**
 * LazyForEach 数据源：store.messages 的只读投影视图（消息级虚拟加载）。
 *
 * 同步模型：store 侧所有列表变形走 appendMessage / replaceAllMessages 两个
 * 结构原语并回调通知；本类收到通知后与 store.messages 按实例身份对账，把
 * 结构差异翻译成 LazyForEach 通知。三条快速路径——尾部追加 / 头部插入 /
 * 整体清空——各自命中即发精确 ADD / DELETE；其余形状（头尾同时变形等竞态，
 * 理论上仅断线重载窗口可达）退化为整表 RELOAD 重建。
 *
 * ⚠️ 通知只走 onDatasetChange 单一通道：
 *  - 官方 FAQ（faqs-arkui-683）：onDataReloaded 在键值复用路径上会让 List
 *    下滑到一定程度无法继续滑动（复用组件不重建导致），RELOAD 操作无此问题；
 *  - onDatasetChange 与 onDataAdd / onDataReloaded 等旧接口禁止混用。
 *
 * 块级/字段级更新不经此层：消息与块均为 @ObservedV2，@Trace 字段级观察直接
 * 驱动可见项刷新；数据源只负责「列表形状」，流式增量零通知开销。
 */
import { ChatMessage } from './ChatBlocks';

export class ChatMessagesSource implements IDataSource {
  private msgs: ChatMessage[] = [];
  private listeners: DataChangeListener[] = [];

  totalCount(): number {
    return this.msgs.length;
  }

  getData(index: number): ChatMessage {
    return this.msgs[index];
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    this.listeners = this.listeners.filter((l: DataChangeListener) => l !== listener);
  }

  /**
   * 与 store.messages 对账（结构变更通知到达时调用）。快速路径按实例身份
   * （!==）识别，仅扫描变形段长度，与总消息数无关。
   */
  syncWith(msgs: ChatMessage[]): void {
    if (msgs.length > this.msgs.length && this.isPrefix(msgs)) {
      this.applyAppend(msgs);
      return;
    }
    if (msgs.length > this.msgs.length && this.isSuffix(msgs)) {
      this.applyPrepend(msgs);
      return;
    }
    if (msgs.length === 0 && this.msgs.length > 0) {
      this.applyClear();
      return;
    }
    if (this.isPrefix(msgs)) {
      return; // 长度与身份均未变：无结构变更，不惊动列表
    }
    this.applyReload(msgs);
  }

  // ── 对账快速路径（按实例身份判定变形形状）──

  /** 旧表是否为新表前缀（尾部追加判定：新表 = 旧表 + 尾巴）。 */
  private isPrefix(msgs: ChatMessage[]): boolean {
    for (let i = 0; i < this.msgs.length; i++) {
      if (msgs[i] !== this.msgs[i]) {
        return false;
      }
    }
    return true;
  }

  /** 旧表是否为新表后缀（头部插入判定：新表 = 头部 + 旧表）。 */
  private isSuffix(msgs: ChatMessage[]): boolean {
    const offset: number = msgs.length - this.msgs.length;
    for (let i = 0; i < this.msgs.length; i++) {
      if (msgs[offset + i] !== this.msgs[i]) {
        return false;
      }
    }
    return true;
  }

  // ── 通知原语（全部走 onDatasetChange 单一通道，见文件头 ⚠️）──

  private applyAppend(msgs: ChatMessage[]): void {
    const at: number = this.msgs.length;
    const count: number = msgs.length - at;
    this.msgs = msgs;
    this.notifyAdd(at, count);
  }

  private applyPrepend(msgs: ChatMessage[]): void {
    const count: number = msgs.length - this.msgs.length;
    this.msgs = msgs;
    this.notifyAdd(0, count);
  }

  private applyClear(): void {
    const count: number = this.msgs.length;
    this.msgs = [];
    this.notifyDelete(0, count);
  }

  private applyReload(msgs: ChatMessage[]): void {
    this.msgs = msgs;
    const op: DataReloadOperation = { type: DataOperationType.RELOAD };
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i].onDatasetChange([op]);
    }
  }

  private notifyAdd(index: number, count: number): void {
    const op: DataAddOperation = { type: DataOperationType.ADD, index: index, count: count };
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i].onDatasetChange([op]);
    }
  }

  private notifyDelete(index: number, count: number): void {
    const op: DataDeleteOperation = { type: DataOperationType.DELETE, index: index, count: count };
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i].onDatasetChange([op]);
    }
  }
}
