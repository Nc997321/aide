import { getTransport } from "../transport";

// ── Aide Link：这台 Host 的手机网关（设置面板用）──
// Rust 侧：src-tauri/crates/aide-core/src/link/ + commands/link.rs。命令是 **Host 自己的**——Host 窗口里
// 连着哪台 Host，管的就是那台 Host 的网关（配对的对象是 Host，不是桌面）。协议见 docs/aide-link-protocol.md。
// 这些命令**不对手机开放**（不在 aide-link 的暴露目录里）。

/** 网关状态。 */
export interface LinkStatus {
  /** 是否启用（启用 = Host 出站注册到中继、等手机）。 */
  enabled: boolean;
  /** 设置里是否配了中继地址（没配就没法配对 / 注册）。 */
  relayConfigured: boolean;
  relayUrl: string;
  /** 此刻是否已在中继上注册（手机能找到这台 Host）。 */
  connected: boolean;
  lastError: string;
  deviceId: string;
  hostName: string;
  /** 是否已配对了一台手机（单设备模型）。 */
  paired: boolean;
  /** 当前是否有一个有效的配对二维码。 */
  offerActive: boolean;
}

/** 配对二维码。 */
export interface LinkOffer {
  /** 二维码里的 URI（含一次性密钥——只给显示用，别记日志）。 */
  uri: string;
  /** 同一内容的二维码 SVG（黑白）。**来自 Host（可能是远程机器）：只能当图片显示，不能内联进 DOM。** */
  qrSvg: string;
  expiresAtUnix: number;
}

export const linkApi = {
  status(): Promise<LinkStatus> {
    return getTransport().invoke("link_status");
  },
  setEnabled(enabled: boolean): Promise<LinkStatus> {
    return getTransport().invoke("link_set_enabled", { enabled });
  },
  /** 生成配对二维码（会自动启用网关；需要先配好中继地址）。 */
  createOffer(): Promise<LinkOffer> {
    return getTransport().invoke("link_create_offer");
  },
  cancelOffer(): Promise<void> {
    return getTransport().invoke("link_cancel_offer");
  },
  /** 撤销已配对的手机（它会被踢下线，之后需要重新扫码）。 */
  revoke(): Promise<void> {
    return getTransport().invoke("link_revoke");
  },
};
