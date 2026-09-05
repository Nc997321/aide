/**
 * 平台适配器：@ohos.net.webSocket → WsLike（本轮唯一全新代码，非过筛）。
 *
 * WsLike 是上游 remote.ts 刻意隔离的「WebSocket 子集」接口——本文件是鸿蒙端
 * 唯一的平台绑定层；状态机（remote.ets）对 @ohos API 零感知，可被假 WsLike 测试。
 *
 * 关键差异（ohos WS 是事件驱动模型，无 readyState 属性）：
 *  - readyState 由本类自维护（0=connecting 1=open 2=closing 3=closed，模拟 DOM 子集）
 *  - connect 失败时手动补 onerror → onclose 序列（上游状态机靠 onclose 走 offline 重连）
 */
import { webSocket } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import type { WsLike, WsOpenEvent, WsMessageEvent, WsCloseEvent, WsErrorEvent, OpenUrlFn } from './remote';

/** 默认 wsFactory：供 RemoteTransport 构造缺省使用。 */
export function createOhosWs(url: string): WsLike {
  return new OhosWs(url);
}

class OhosWs implements WsLike {
  readyState: number = 0;
  onopen: ((ev: WsOpenEvent) => void) | null = null;
  onmessage: ((ev: WsMessageEvent) => void) | null = null;
  onclose: ((ev: WsCloseEvent) => void) | null = null;
  onerror: ((ev: WsErrorEvent) => void) | null = null;
  private ws: webSocket.WebSocket = webSocket.createWebSocket();

  constructor(url: string) {
    this.ws.on('open', (err: Error) => {
      if (err) {
        return;
      }
      this.readyState = 1;
      if (this.onopen) {
        this.onopen({});
      }
    });
    this.ws.on('message', (err: Error, value: string | ArrayBuffer) => {
      if (err) {
        return;
      }
      if (this.onmessage) {
        this.onmessage({ data: value });
      }
    });
    this.ws.on('close', (err: Error, value: webSocket.CloseResult) => {
      this.readyState = 3;
      if (this.onclose) {
        this.onclose({ code: value.code, reason: value.reason });
      }
    });
    this.ws.on('error', (err: Error) => {
      if (this.onerror) {
        this.onerror({ message: err.message ?? '' });
      }
    });
    this.ws.connect(url, (err: Error) => {
      if (err) {
        // 连接失败：模拟 DOM 事件序 onerror → onclose（状态机据此进入 offline 退避重连）
        this.readyState = 3;
        if (this.onerror) {
          this.onerror({ message: err.message ?? '' });
        }
        if (this.onclose) {
          this.onclose({ code: 0, reason: err.message ?? '' });
        }
      }
    });
  }

  send(data: string): void {
    this.ws.send(data, (err: Error) => {
      if (err) {
        console.warn(`[ws-ohos] send 失败：${err.message ?? ''}`);
      }
    });
  }

  close(): void {
    this.readyState = 2;
    this.ws.close((err: Error) => {
      if (err) {
        console.warn(`[ws-ohos] close 失败：${err.message ?? ''}`);
      }
    });
  }
}

/**
 * 外链打开注入（RemoteTransport 构造第三参）。openLink 由系统选择浏览器/应用打开。
 * 用法：EntryAbility.onWindowStageCreate 里 makeOpenUrl(this.context) 存入 AppStorage，
 * 连接管理页构造 RemoteTransport 时取出注入。
 */
export function makeOpenUrl(context: common.UIAbilityContext): OpenUrlFn {
  return (url: string): void => {
    // appLinkingOnly:false = 允许系统兜底（浏览器/应用）打开，不限定 App Linking
    context.openLink(url, { appLinkingOnly: false }, (err: Error) => {
      if (err) {
        console.warn(`[ws-ohos] openLink 失败：${err.message ?? ''}`);
      }
    });
  };
}
