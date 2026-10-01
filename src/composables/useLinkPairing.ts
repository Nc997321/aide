// 「手机连接（Aide Link）」的状态机：网关状态轮询 + 配对二维码的生命周期（生成 / 过期 / 被用掉 / 撤销）。
// 设置面板的 LinkPairingSection 与侧栏状态栏的 LinkConnectPopover 共用——**别在视图里各抄一份**。
//
// 管的是**这台 Host** 的网关（窗口连着哪台就是哪台）。二维码 SVG 来自 Host：只当 <img> 的 data URL 显示。
// 组件卸载时若二维码还开着就撤掉：关掉界面 = 不再展示二维码，也就不该留着一把有效的一次性密钥。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { linkApi, type LinkOffer, type LinkStatus } from "@aide/sdk";

const POLL_MS = 2000;

export function useLinkPairing() {
  const status = ref<LinkStatus | null>(null);
  const offer = ref<LinkOffer | null>(null);
  const error = ref("");
  const note = ref("");
  const busy = ref(false);
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  const qrSrc = computed(() => (offer.value ? `data:image/svg+xml;utf8,${encodeURIComponent(offer.value.qrSvg)}` : ""));
  const secondsLeft = computed(() => (offer.value ? Math.max(0, Math.ceil(offer.value.expiresAtUnix - now.value / 1000)) : 0));
  const mmss = computed(() => `${Math.floor(secondsLeft.value / 60)}:${String(secondsLeft.value % 60).padStart(2, "0")}`);
  const stateText = computed(() => {
    const s = status.value;
    if (!s) return "…";
    if (!s.enabled) return "未启用";
    if (s.relaySuppressed) return "已启用，但本构建不连中继（dev 构建与安装版共用同一台设备身份，同时注册会在中继上互踢；要调试：先退出安装版，再用 AIDE_DEV_REMOTE=1 启动 dev）";
    return s.connected ? "已就绪，手机可以连接" : "已启用，正在连接…";
  });

  async function refresh() {
    try {
      status.value = await linkApi.status();
      now.value = Date.now();
      // 二维码打开期间：手机配对成功（二维码被用掉）或过期，就收起它
      if (offer.value) {
        if (status.value.paired && !status.value.offerActive) {
          offer.value = null;
          note.value = "配对成功，手机已连上这台 Host。";
        } else if (secondsLeft.value <= 0 || !status.value.offerActive) {
          offer.value = null;
          note.value = "二维码已过期，请重新生成。";
        }
      }
    } catch (e) {
      error.value = String(e);
    }
  }

  onMounted(() => {
    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
  });
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer);
    if (offer.value) void linkApi.cancelOffer().catch(() => {});
  });

  async function guard(fn: () => Promise<void>) {
    busy.value = true;
    error.value = "";
    note.value = "";
    try {
      await fn();
    } catch (e) {
      error.value = String(e);
    } finally {
      busy.value = false;
    }
  }

  const setEnabled = (enabled: boolean) => guard(async () => {
    status.value = await linkApi.setEnabled(enabled);
    // 关网关 = 二维码作废（Host 侧随之失效），界面上别还留着一张扫不通的码
    if (!enabled) offer.value = null;
  });

  const showOffer = () => guard(async () => {
    offer.value = await linkApi.createOffer();
    await refresh();
  });

  const hideOffer = () => guard(async () => {
    offer.value = null;
    await linkApi.cancelOffer();
    await refresh();
  });

  const revoke = () => guard(async () => {
    await linkApi.revoke();
    note.value = "已撤销，该手机已被断开。";
    await refresh();
  });

  return { status, offer, error, note, busy, qrSrc, secondsLeft, mmss, stateText, setEnabled, showOffer, hideOffer, revoke };
}
