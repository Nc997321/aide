/**
 * 平台适配器：@ohos.net.webSocket → WsLike（本轮唯一全新代码，非过筛）。
 *
 * WsLike 是上游 remote.ts 刻意隔离的「WebSocket 子集」接口——本文件是鸿蒙端
 * 唯一的平台绑定层；状态机（remote.ets）对 @ohos API 零感知，可被假 WsLike 测试。
 *
 * 关键差异（ohos WS 是事件驱动模型，无 readyState 属性）：
 *  - readyState 由本类自维护（0=connecting 1=open 2=closing 3=closed，模拟 DOM 子集）
 *  - connect 失败时手动补 onerror → onclose 序列（上游状态机靠 onclose 走 offline 重连）
 *  - connect/send/close 全部带同步异常防护：netstack 对异常态 socket 会同步抛错，
 *    裸穿会中断 remote.ets 握手看门狗回调 → 状态机永久停在 connecting（2026-09-12
 *    实测僵死：TCP 建立但握手卡死的 socket 上 close() 同步抛异常）
 *
 * ohos 增强（可整体删除回退，见 sdk/doh.ets）：连接前先走 DoH 拿字面量直连
 * （运营商缓存旧 AAAA 导致域名时好时坏），域名降为兜底；wss 由 doh.ets 闸门排除。
 * 字面量直连时显式覆盖 Host 为原域名 authority——ohos 栈对 v6 字面量生成的 Host
 * 不带方括号，nginx 按规范回 400（2026-09-12 实测）。
 * 另：实际 connect 推迟到 DoH 解析后发起——readyState 停留在 0（connecting）语义不变，
 * 全程受 remote.ets 握手看门狗兜底；看门狗强杀走本类 close()，顺带兜底计熔断。
 */
import { webSocket } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import type { WsLike, WsOpenEvent, WsMessageEvent, WsCloseEvent, WsErrorEvent, OpenUrlFn } from './remote';
import { dohConnectUrl, noteIpConnectResult, DohOutcome } from './doh';

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
  /** DoH 命中的直连字面量（null = 域名连接）；连接成败据此回写 doh 熔断器。 */
  private viaIp: string | null = null;
  /** 是否已收到 open（未 open 即 close/err = 握手夭折，计入熔断）。 */
  private opened: boolean = false;

  constructor(url: string) {
    this.ws.on('open', (err: Error) => {
      if (err) {
        return;
      }
      this.opened = true;
      if (this.viaIp !== null) {
        noteIpConnectResult(this.viaIp, true);
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
      if (!this.opened && this.viaIp !== null) {
        noteIpConnectResult(this.viaIp, false); // 握手夭折：字面量不可达，同样计入熔断
      }
      if (this.onclose) {
        this.onclose({ code: value.code, reason: value.reason });
      }
    });
    this.ws.on('error', (err: Error) => {
      if (this.onerror) {
        this.onerror({ message: err.message ?? '' });
      }
    });
    // ── DoH 直连段（可整段删除回退：this.startConnect(url, '')）──
    dohConnectUrl(url).then((o: DohOutcome) => {
      // close() 先于解析返回：连接已被丢弃（握手看门狗/换连接），不再发起
      if (this.readyState < 2) {
        this.viaIp = o.ip;
        // 字面量直连带出原 authority 覆盖 Host（ohos 栈 v6 Host 无括号缺陷，见文件头）
        this.startConnect(o.url, o.ip !== null ? o.origAuthority : '');
      }
    }).catch((_e: Error) => {
      // 防御：DoH 编排异常时回落域名，保持连接流程不断
      if (this.readyState < 2) {
        this.viaIp = null;
        this.startConnect(url, '');
      }
    });
  }

  /** 发起底层连接（DoH 产出地址与域名兜底共用）。hostHeader 非空 = 字面量直连，覆盖 Host。 */
  private startConnect(url: string, hostHeader: string): void {
    // 同步异常防护：netstack 对异常态 socket 的 connect 可能同步抛错（2026-09-12
    // 实测僵死案例：TCP 已建立但握手管道卡死的 socket）——转 onConnectResult 走
    // onerror→onclose 模拟序列，remote.ets 据此进 offline 退避，不能让异常裸穿
    if (hostHeader !== '') {
      const header: Record<string, string> = { 'Host': hostHeader };
      const opts: webSocket.WebSocketRequestOptions = { header: header };
      try {
        this.ws.connect(url, opts, (err: Error) => {
          this.onConnectResult(err);
        });
      } catch (e) {
        this.onConnectResult(e as Error);
      }
      return;
    }
    try {
      this.ws.connect(url, (err: Error) => {
        this.onConnectResult(err);
      });
    } catch (e) {
      this.onConnectResult(e as Error);
    }
  }

  /** connect 回调统一处理：失败计熔断 + 模拟 DOM 事件序。 */
  private onConnectResult(err: Error): void {
    if (!err) {
      return;
    }
    if (this.viaIp !== null && !this.opened) {
      noteIpConnectResult(this.viaIp, false);
    }
    // 连接失败：模拟 DOM 事件序 onerror → onclose（状态机据此进入 offline 退避重连）
    this.readyState = 3;
    if (this.onerror) {
      this.onerror({ message: err.message ?? '' });
    }
    if (this.onclose) {
      this.onclose({ code: 0, reason: err.message ?? '' });
    }
  }

  send(data: string): void {
    try {
      this.ws.send(data, (err: Error) => {
        if (err) {
          console.warn(`[ws-ohos] send 失败：${err.message ?? ''}`);
        }
      });
    } catch (e) {
      // 同步异常防护：同 close()——异常态 socket 上 send 可能同步抛错
      console.warn(`[ws-ohos] send 异常：${(e as Error).message ?? ''}`);
    }
  }

  close(): void {
    // 兜底计熔断：ohos 栈对被服务端拒绝的握手不回调 close/error，看门狗强杀是
    // 唯一能感知失败的路径（手动断开未握上手时也会计入——误伤代价仅 10min 域名兜底）
    if (!this.opened && this.viaIp !== null) {
      noteIpConnectResult(this.viaIp, false);
    }
    this.readyState = 2;
    // 同步异常防护（2026-09-12 僵死案例）：netstack 对 TCP 已建立但握手卡死的
    // socket，close() 会同步抛错——若裸穿到 remote.ets 握手看门狗回调，回调中断，
    // setState('offline')/scheduleReconnect 永不执行，状态机永久停在 connecting。
    // 吞掉同步异常（回调内错误仅记日志），看门狗回调得以完整走完重连编排。
    try {
      this.ws.close((err: Error) => {
        if (err) {
          console.warn(`[ws-ohos] close 失败：${err.message ?? ''}`);
        }
      });
    } catch (e) {
      console.warn(`[ws-ohos] close 异常：${(e as Error).message ?? ''}`);
    }
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
