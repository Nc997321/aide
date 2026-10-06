import { getTransport } from "../transport";

// ── Aide Link：这台 Host 的手机网关（设置面板用）──
// Rust 侧：src-tauri/crates/aide-core/src/link/ + commands/link.rs。命令是 **Host 自己的**——Host 窗口里
// 连着哪台 Host，管的就是那台 Host 的网关（配对的对象是 Host，不是桌面）。协议见 docs/aide-link-protocol.md。
// 这些命令**不对手机开放**（不在 aide-link 的暴露目录里）。

/** 网关状态。 */
export interface LinkStatus {
  /** 是否启用（启用 = Host 出站注册到中继、等手机）。 */
  enabled: boolean;
  /** 此刻是否已在中继上注册（手机能找到这台 Host）。 */
  connected: boolean;
  /** 本构建被刻意挡住不连中继（桌面 dev 构建）。面板必须说明，否则「已启用」与「没连上」会同时出现。 */
  relaySuppressed: boolean;
  lastError: string;
  deviceId: string;
  hostName: string;
  /** 是否已配对了一台手机（单设备模型）。 */
  paired: boolean;
  /** 当前是否有一个有效的配对二维码。 */
  offerActive: boolean;
  /** 此刻生效的中继地址；`null` = 用户还没配（**没有出厂默认**，没配就出不了码）。 */
  relayUrl: string | null;
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
  /** 设置用户填的中继地址（空串 = 清除 = 未配置）。改地址后会立即重连；已配对的手机需重新扫码。 */
  setRelayUrl(url: string): Promise<LinkStatus> {
    return getTransport().invoke("link_set_relay_url", { url });
  },
  /** 生成配对二维码（会自动启用网关）。 */
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
