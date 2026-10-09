// 知识库服务「有新版本」提示的数据：查一次状态，记住「以后再说」。
//
// 横幅该说什么由 components/KnowledgeBase/updateBanner.ts 的纯函数决定；服务端那头见
// knowledge-server/src/api/update.rs。只告知，不执行升级。
import { ref, type Ref } from "vue";
import { kb, KbError } from "@/components/KnowledgeBase/kbClient";
import type { UpdateStatusSource } from "@/components/KnowledgeBase/updateBanner";

/** 「以后再说」记在本机：按「服务地址 → 版本号」记，再出新版还会提示。只是不唠叨，不影响功能。 */
const DISMISS_KEY = "aide.kb.updateDismissed";

function readDismissed(baseUrl: string): string | null {
  try {
    const map = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "{}") as Record<string, string>;
    return map[baseUrl] ?? null;
  } catch {
    return null;
  }
}

function writeDismissed(baseUrl: string, version: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "{}") as Record<string, string>;
    map[baseUrl] = version;
    localStorage.setItem(DISMISS_KEY, JSON.stringify(map));
  } catch {
    /* 存不了就下次再提示，无伤 */
  }
}

export function useKbUpdate(deps: { baseUrl: () => string }) {
  const status: Ref<UpdateStatusSource> = ref(null);
  const dismissedVersion = ref<string | null>(null);
  const checking = ref(false);

  /** 查一次。没登录 / 连不上 → null（不判）；404 → 服务端太老，没有这个接口。 */
  async function refresh(force = false): Promise<void> {
    dismissedVersion.value = readDismissed(deps.baseUrl());
    checking.value = true;
    try {
      status.value = await kb.updateStatus(force);
    } catch (e) {
      status.value = e instanceof KbError && e.status === 404 ? "unsupported" : null;
    } finally {
      checking.value = false;
    }
  }

  function dismiss(version: string): void {
    writeDismissed(deps.baseUrl(), version);
    dismissedVersion.value = version;
  }

  return { status, dismissedVersion, checking, refresh, dismiss };
}
