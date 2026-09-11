# 鸿蒙端（ohos）同步修改指南：keepalive + connect_error

**背景**：2026-09-11 远程配对/重连可靠性修复落地了 relay 层新契约（见
[remote-protocol.md](remote-protocol.md)）：手机腿 keepalive 活体帧、relay 关连接前的
`connect_error` 原因帧、桥接 last-connect-wins（supersede）。PWA 侧
（`packages/aide-sdk/src/remote.ts`）已同步；**ohos 镜像未同步**，本指南给出逐点改法。

**阻断性**：非阻断。relay 的 60s 静默超时是 **opt-in**（收到首帧 keepalive 才武装），
不改 ohos 也不会被断连；但会失去僵尸桥保护与秒级 supersede 重连收益，且被顶替/码错时
UI 语义差（无限 offline 重试、互踢循环）。建议随下个 ohos 版本同步。

**落点唯一**：`ohos/entry/src/main/ets/sdk/remote.ets`。
ws-ohos.ets / storage.ets / ConnModel.ets / ConnectPage.ets **均无需改动**。

**治理**：`ohos/.../sdk/README.md` 声明上游 `packages/aide-sdk/src/remote.ts` 为唯一事实源、
单向同步。本指南的两块改动与上游 diff 逐行镜像；重跑同步脚本时以**上游为准重新过筛**，
遵守 README:16-25 的 8 条 ArkTS 转换规则（具名 interface 代替字面量、timer 类型 number、
catch 带参、无 in 操作符等）。

---

## 改动 1：keepalive 活体帧（镜像上游 startKeepalive/stopKeepalive）

### 1.1 常量（remote.ets:155 `BACKOFF_MAX_MS` 之后）

```ts
/** 手机腿活体帧间隔：relay 据此武装 60s 静默超时（首帧 keepalive 才武装）。
 *  契约见 docs/reference/remote-protocol.md。 */
const KEEPALIVE_INTERVAL_MS = 20000;
```

### 1.2 上行消息 interface（:105-133 上行消息区，InvokeMsg 之后）

```ts
interface KeepaliveMsg {
  type: 'keepalive';
}
```

### 1.3 私有字段（:184 `authWaiter` 之后）

```ts
  private keepaliveTimer: number | null = null;
  /** 被新连接顶替（superseded）：onclose 据此回 idle 不重连，防互踢循环。 */
  private kickedBySupersede = false;
```

### 1.4 connect()（:275-294）

`if (this.ws) {` 块内、`this.ws.close()` 之前加 `this.stopKeepalive();`；
`this.closedByUser = false;` 之后加 `this.kickedBySupersede = false;`：

```ts
    if (this.ws) {
      this.closedByUser = true; // 旧连接关闭不触发重连
      this.stopKeepalive();
      this.ws.close();
      this.ws = null;
    }
    this.closedByUser = false;
    this.kickedBySupersede = false;
```

### 1.5 disconnect()（:312-324）

`this.closedByUser = true;` 之后加一行：

```ts
    this.closedByUser = true;
    this.stopKeepalive();
```

### 1.6 openOnce() onopen（:337-342）

creds 防御守卫之后加启动调用：

```ts
      if (!creds) {
        return;
      }
      this.startKeepalive(ws);
```

### 1.7 openOnce() onclose（:373-381）

`this.ws = null;` 后加 stopKeepalive；closedByUser 块之后加 supersede 块：

```ts
      this.ws = null;
      this.stopKeepalive();
      if (this.closedByUser) {
        this.setState('idle');
        return;
      }
      // 被新连接顶替：会话已易主，重连只会与新连接互踢——停在这里等用户决策
      if (this.kickedBySupersede) {
        this.failPending('已被新连接顶替');
        // waiter 不能被早返回漏掉：bridged 阶段挂起的 pair() 正是 superseded 的典型窗口
        const err = new Error('已被新连接顶替');
        if (this.pairWaiter) {
          this.pairWaiter.reject(err);
          this.pairWaiter = null;
        }
        if (this.authWaiter) {
          this.authWaiter.reject(err);
          this.authWaiter = null;
        }
        this.setState('idle');
        return;
      }
```

### 1.8 两个私有方法（wsUrl() 之后，:330 附近）

```ts
  /** 起活体帧定时器：relay 收到首帧 keepalive 才武装手机腿静默超时。
   *  tick 守卫 ws 身份与 readyState——真 onclose 异步，tick 可落在 close 与事件之间。 */
  private startKeepalive(ws: WsLike): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WS_OPEN) {
        return;
      }
      const k: KeepaliveMsg = { type: 'keepalive' };
      try {
        ws.send(JSON.stringify(k));
      } catch (e) {
        // 发送抛错 = 连接将死：onclose 会清定时器，此处仅记日志
        console.warn(`[sdk] keepalive send failed: ${e}`);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
```

---

## 改动 2：connect_error 原因帧映射

### 2.1 消息 interface + 联合（:81-103）

AuthErrorMsg 之后加：

```ts
interface ConnectErrorMsg {
  type: 'connect_error';
  reason: string;
}
```

联合类型增成员：

```ts
type DesktopToPhone = PairOkMsg | AuthOkMsg | AuthErrorMsg | ConnectErrorMsg | EventMsg | InvokeOkMsg | InvokeErrMsg;
```

### 2.2 handleMessage switch 增 case（:455 `auth_error` 臂之后）

```ts
      case 'connect_error': {
        // relay 源帧：unknown_code = 码路由未命中（码错/桌面未上报），回配对屏报码错
        // 且停止重试（重试同一个死码无意义）；superseded = 被新连接顶替；
        // device_offline 等其余原因忽略——onclose 照旧走 offline 退避
        const m = msg as ConnectErrorMsg;
        if (m.reason === 'unknown_code') {
          this.pendingPair = null;
          this.setState('needsPairing');
          const err = new Error('配对码无效或已过期');
          if (this.authWaiter) {
            this.authWaiter.reject(err);
            this.authWaiter = null;
          }
          if (this.pairWaiter) {
            this.pairWaiter.reject(err);
            this.pairWaiter = null;
          }
        } else if (m.reason === 'superseded') {
          this.kickedBySupersede = true;
        }
        break;
      }
```

> 说明：switch 无 default 臂，`device_offline` 与未来新 reason 自动落「忽略」，
> 与上游语义一致（onclose 照旧 offline 退避）。

---

## 不需要改的（自动受益）

- supersede / 码路由 TTL / 桌面腿 Ping 活体：纯 relay 侧，ohos 无感受益。
- 被顶替后的重连：ohos 收 `superseded` 后回 idle 不重试（改动 2），与 PWA 同语义。

## 验收清单（ohos 实机/模拟器手测）

1. **keepalive 生效**：配对成功后前台静置 > 60s，会话不断（relay 已武装静默超时但不误杀）。
2. **superseded 停重试**：再用 PWA 或第二台设备配对同一桌面 → ohos 回连接屏 idle，
   不出现 1s/2s/4s 退避重试循环（日志无反复 connect）。
3. **码错语义**：连接屏输错码 → 落「配对码无效或已过期」且**停止重试**（旧行为：offline 无限重试）。
4. **回归**：正常配对 / 断网重连（offline 退避后 authed + reconnected 回调补齐消息）不受影响。

## 与上游对账

改完后与 `packages/aide-sdk/src/remote.ts` 逐块对账三处：keepalive 定时器三清理点
（onclose / connect 替换 / disconnect）、connect_error 三分支、kickedBySupersede 的
onclose 块。上游对应位置：`startKeepalive/stopKeepalive` 私有方法、
`case "connect_error"` 臂、onclose 的 `kickedBySupersede` 块。
